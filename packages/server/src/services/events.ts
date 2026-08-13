import { HiveEvent, ID, K } from '@hive/shared';
import { config } from '../config.js';
import { query, queueWrite } from '../db.js';
import { broadcast } from '../hub.js';
import {
  agentPrompts,
  agentSessions,
  agentTurns,
  eventsIngested,
  tokensUsed,
  toolCalls,
  turnDuration,
} from '../metrics.js';
import { redis } from '../redis.js';

/** Cap on any single detail value before it reaches Redis or the browser. */
const MAX_DETAIL_CHARS = 2_000;

function truncate(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'string' && value.length > MAX_DETAIL_CHARS) {
      out[key] = `${value.slice(0, MAX_DETAIL_CHARS)}… [${value.length} chars]`;
    } else if (value && typeof value === 'object') {
      const json = JSON.stringify(value);
      out[key] =
        json.length > MAX_DETAIL_CHARS ? `${json.slice(0, MAX_DETAIL_CHARS)}… [truncated]` : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export async function recordEvent(
  input: Omit<HiveEvent, 'id' | 'ts'> & { ts?: number },
): Promise<HiveEvent> {
  const event = HiveEvent.parse({
    ...input,
    detail: truncate(input.detail ?? {}),
    id: ID.event(),
    ts: input.ts ?? Date.now(),
  });

  // MAXLEN ~ keeps trimming cheap; Postgres holds the durable tail.
  await redis.xadd(
    K.eventStream,
    'MAXLEN',
    '~',
    config.streamMaxLen,
    '*',
    'payload',
    JSON.stringify(event),
  );

  broadcast({ t: 'event', event });
  observe(event);

  queueWrite(
    `insert into events (id, ts, agent_id, agent_name, type, subject, detail)
     values ($1, to_timestamp($2/1000.0), $3, $4, $5, $6, $7)
     on conflict (id) do nothing`,
    [event.id, event.ts, event.agentId, event.agentName, event.type, event.subject, event.detail],
  );

  return event;
}

/**
 * Timestamp of the last prompt per agent, used to derive turn duration.
 * Bounded by machine count, and each entry is cleared when its turn ends.
 */
const turnStartedAt = new Map<string, number>();

/** Translate an event into Prometheus counters as it is recorded. */
function observe(event: HiveEvent): void {
  eventsIngested.inc({ agent: event.agentId, type: event.type });

  switch (event.type) {
    case 'tool.post': {
      // The hook reports success as `ok`; anything else is treated as a failure
      // so a dashboard alert on error rate does not miss malformed responses.
      const ok = event.detail.ok !== false;
      toolCalls.inc({
        agent: event.agentId,
        tool: event.subject ?? 'unknown',
        result: ok ? 'ok' : 'error',
      });
      return;
    }
    case 'session.start':
      agentSessions.inc({ agent: event.agentId });
      return;
    case 'usage': {
      const model = event.subject ?? 'unknown';
      const kinds = {
        input: event.detail.input_tokens,
        output: event.detail.output_tokens,
        cache_read: event.detail.cache_read_tokens,
        cache_write: event.detail.cache_write_tokens,
      };
      for (const [kind, value] of Object.entries(kinds)) {
        if (typeof value === 'number' && value > 0) {
          tokensUsed.inc({ agent: event.agentId, model, kind }, value);
        }
      }
      return;
    }
    case 'prompt.submit':
      agentPrompts.inc({ agent: event.agentId });
      turnStartedAt.set(event.agentId, event.ts);
      return;
    case 'turn.stop': {
      agentTurns.inc({ agent: event.agentId });
      const started = turnStartedAt.get(event.agentId);
      if (started !== undefined) {
        turnStartedAt.delete(event.agentId);
        const seconds = (event.ts - started) / 1000;
        // Guard against a stale start left by a crashed session: an hour-long
        // "turn" is a lost Stop event, not a real measurement.
        if (seconds >= 0 && seconds < 3_600) {
          turnDuration.observe({ agent: event.agentId }, seconds);
        }
      }
      return;
    }
    default:
      return;
  }
}

/** Newest-first page of events. Reads Postgres when available, Redis otherwise. */
export async function listEvents(opts: {
  limit?: number;
  agentId?: string;
  type?: string;
}): Promise<HiveEvent[]> {
  const limit = Math.min(opts.limit ?? 200, 1_000);

  const rows = await query<{
    id: string;
    ts: Date;
    agent_id: string;
    agent_name: string;
    type: string;
    subject: string | null;
    detail: Record<string, unknown>;
  }>(
    `select id, ts, agent_id, agent_name, type, subject, detail
       from events
      where ($1::text is null or agent_id = $1)
        and ($2::text is null or type = $2)
      order by ts desc
      limit $3`,
    [opts.agentId ?? null, opts.type ?? null, limit],
  );

  if (rows.length > 0) {
    return rows.map((r) =>
      HiveEvent.parse({
        id: r.id,
        ts: r.ts.getTime(),
        agentId: r.agent_id,
        agentName: r.agent_name,
        type: r.type,
        subject: r.subject,
        detail: r.detail ?? {},
      }),
    );
  }

  const entries = await redis.xrevrange(K.eventStream, '+', '-', 'COUNT', limit);
  const events: HiveEvent[] = [];
  for (const [, fields] of entries) {
    const idx = fields.indexOf('payload');
    const raw = idx >= 0 ? fields[idx + 1] : undefined;
    if (!raw) continue;
    const parsed = HiveEvent.safeParse(JSON.parse(raw));
    if (!parsed.success) continue;
    if (opts.agentId && parsed.data.agentId !== opts.agentId) continue;
    if (opts.type && parsed.data.type !== opts.type) continue;
    events.push(parsed.data);
  }
  return events;
}
