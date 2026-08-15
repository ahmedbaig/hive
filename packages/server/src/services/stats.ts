/**
 * Fleet token and context accounting.
 *
 * Two pipelines with deliberately different shapes:
 *
 *   1. Live context — a last-value snapshot on the agent record. Overwritten on
 *      every turn, never historised. "How full is this machine's context right
 *      now" has no useful past.
 *   2. Historical spend — an append-only series. Written once per turn, read as
 *      "everything since T". Sharing a table with (1) would mean UPDATE traffic
 *      on an INSERT-only series.
 *
 * A note on the reset countdown: Claude Code does not expose HTTP response
 * headers to hooks or MCP tools, so no agent can read `anthropic-ratelimit-*`,
 * and this server never talks to the API itself. The window here is therefore
 * *derived* — first observed spend plus the window length — not the billing
 * window. It is honest about what it measures and labelled as such in the UI.
 */
import { ID, K, type AgentStats, type FleetStats, type StatsReport, type UsageWindow } from '@hive/shared';
import { config } from '../config.js';
import { hasDb, query, queueWrite } from '../db.js';
import { log } from '../log.js';
import { contextUsedRatio } from '../metrics.js';
import { redis } from '../redis.js';
import { getAgent, listAgents, updateAgent } from './agents.js';
import { listFiles } from './files.js';

/** Buckets in the sparkline. Enough shape to read, cheap enough to compute. */
const SPARK_BUCKETS = 24;

/** Hot window kept in the Redis stream, so stats work without Postgres. */
const STREAM_MAXLEN = 20_000;

interface Totals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
}

const zero = (): Totals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turns: 0,
});

/**
 * Ingest one turn's usage.
 *
 * `sessionTotals` replaces the agent's cumulative counters when the reporter
 * knows them (it has read the whole transcript), rather than accumulating
 * deltas here — a hook that runs twice on the same turn would otherwise double
 * the session's totals forever.
 */
export async function recordUsage(
  agentId: string,
  agentName: string,
  report: StatsReport,
): Promise<AgentStats | null> {
  const agent = await getAgent(agentId);
  if (!agent) return null;

  const now = Date.now();
  const previous = agent.stats;
  const totals = report.sessionTotals;
  const sameSession = previous?.sessionId === report.sessionId && report.sessionId !== null;

  const stats: AgentStats = {
    contextUsed: report.contextUsed,
    contextMax: report.contextMax,
    model: report.model ?? previous?.model ?? null,
    sessionId: report.sessionId,
    inputTokens: totals
      ? totals.inputTokens
      : (sameSession ? (previous?.inputTokens ?? 0) : 0) + report.inputTokens,
    outputTokens: totals
      ? totals.outputTokens
      : (sameSession ? (previous?.outputTokens ?? 0) : 0) + report.outputTokens,
    cacheReadTokens: totals
      ? totals.cacheReadTokens
      : (sameSession ? (previous?.cacheReadTokens ?? 0) : 0) + report.cacheReadTokens,
    cacheWriteTokens: totals
      ? totals.cacheWriteTokens
      : (sameSession ? (previous?.cacheWriteTokens ?? 0) : 0) + report.cacheWriteTokens,
    turns: totals ? totals.turns : (sameSession ? (previous?.turns ?? 0) : 0) + report.turns,
    updatedAt: now,
  };

  await updateAgent(agentId, { stats });

  // Last-value columns, so a dashboard querying Postgres directly sees the same
  // snapshot the socket just pushed. `where` guards against a late report from
  // a stale hook overwriting a newer one.
  queueWrite(
    `update agents
        set context_used = $2, context_max = $3, model = $4, session_id = $5,
            stats_at = to_timestamp($6/1000.0)
      where id = $1 and (stats_at is null or stats_at <= to_timestamp($6/1000.0))`,
    [agentId, stats.contextUsed, stats.contextMax, stats.model, stats.sessionId, now],
  );

  contextUsedRatio.set(
    { agent: agentId },
    stats.contextMax > 0 ? Math.min(1, stats.contextUsed / stats.contextMax) : 0,
  );

  const spend =
    report.inputTokens + report.outputTokens + report.cacheReadTokens + report.cacheWriteTokens;
  if (spend > 0) {
    // No Prometheus counter is incremented here. `hive_tokens_total` is already
    // fed by the `usage` telemetry event, which is derived from the same
    // transcript — counting it twice would double every token on the dashboard.
    // This path owns the durable series and the REST stats view instead.
    await appendTokenEvent({
      id: ID.event(),
      ts: now,
      agentId,
      agentName,
      sessionId: report.sessionId,
      model: report.model,
      inputTokens: report.inputTokens,
      outputTokens: report.outputTokens,
      cacheReadTokens: report.cacheReadTokens,
      cacheWriteTokens: report.cacheWriteTokens,
      turns: report.turns,
    });
  }

  return stats;
}

interface StoredEvent {
  ts: number;
  agentId: string;
  agentName: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Model turns this row covers. One report can carry several. */
  turns: number;
}

async function appendTokenEvent(event: StoredEvent & { id: string; sessionId: string | null }): Promise<void> {
  // The stream is the hot path and the only series when Postgres is absent, so
  // it is written first and awaited; Postgres is fire-and-forget behind it.
  try {
    // Auto-generated ids are millisecond-prefixed, which is exactly the range
    // key `eventsSince` needs — no explicit id, no clash with a sibling writer.
    await redis.xadd(
      K.tokenStream,
      'MAXLEN',
      '~',
      STREAM_MAXLEN,
      '*',
      'payload',
      JSON.stringify(event),
    );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'token event stream write failed');
  }

  queueWrite(
    `insert into token_events
       (id, ts, agent_id, agent_name, session_id, model,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, turns)
     values ($1, to_timestamp($2/1000.0), $3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do nothing`,
    [
      event.id,
      event.ts,
      event.agentId,
      event.agentName,
      event.sessionId,
      event.model,
      event.inputTokens,
      event.outputTokens,
      event.cacheReadTokens,
      event.cacheWriteTokens,
      event.turns,
    ],
  );
}

/** Every spend row since `since`, newest last. Postgres first, stream fallback. */
async function eventsSince(since: number): Promise<StoredEvent[]> {
  if (hasDb()) {
    const rows = await query<{
      ts: Date;
      agent_id: string;
      agent_name: string;
      model: string | null;
      input_tokens: string | number;
      output_tokens: string | number;
      cache_read_tokens: string | number;
      cache_write_tokens: string | number;
      turns: number | null;
    }>(
      `select ts, agent_id, agent_name, model,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, turns
         from token_events
        where ts >= to_timestamp($1/1000.0)
        order by ts asc`,
      [since],
    );
    if (rows.length > 0) {
      // bigint columns come back as strings from node-postgres; Number() them
      // once here rather than at every arithmetic site.
      return rows.map((r) => ({
        ts: r.ts.getTime(),
        agentId: r.agent_id,
        agentName: r.agent_name,
        model: r.model,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cacheReadTokens: Number(r.cache_read_tokens),
        cacheWriteTokens: Number(r.cache_write_tokens),
        turns: r.turns ?? 1,
      }));
    }
  }

  const entries = await redis.xrange(K.tokenStream, `${since}`, '+');
  const out: StoredEvent[] = [];
  for (const [, fields] of entries) {
    const idx = fields.indexOf('payload');
    const raw = idx >= 0 ? fields[idx + 1] : undefined;
    if (!raw) continue;
    try {
      // Entries written before `turns` existed carry one report's worth.
      const parsed = JSON.parse(raw) as StoredEvent;
      out.push({ ...parsed, turns: parsed.turns ?? 1 });
    } catch {
      /* a corrupt entry is dropped rather than failing the whole view */
    }
  }
  return out;
}

function add(into: Totals, event: StoredEvent): void {
  into.inputTokens += event.inputTokens;
  into.outputTokens += event.outputTokens;
  into.cacheReadTokens += event.cacheReadTokens;
  into.cacheWriteTokens += event.cacheWriteTokens;
  // The row's own turn count, not one per row: a Stop hook that covers twelve
  // turns is one row, and counting rows undercounted the fleet twelvefold.
  into.turns += event.turns;
}

function toWindow(totals: Totals, startedAt: number | null, windowMs: number): UsageWindow {
  return {
    windowMs,
    startedAt,
    resetsAt: startedAt === null ? null : startedAt + windowMs,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    totalTokens:
      totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    turns: totals.turns,
  };
}

/**
 * Everything the stats view renders, in one round trip.
 *
 * Timestamps are absolute and server-authored. A client that computed the reset
 * moment from its own clock would disagree with every other browser on the LAN
 * by however far their clocks have drifted.
 */
export async function fleetStats(): Promise<FleetStats> {
  const now = Date.now();
  const windowMs = config.usageWindowMs;
  const since = now - windowMs;

  const events = await eventsSince(since);
  const agents = await listAgents();

  const globalTotals = zero();
  const perAgent = new Map<string, Totals>();
  const firstSeen = new Map<string, number>();
  const sparks = new Map<string, number[]>();
  let startedAt: number | null = null;

  for (const event of events) {
    if (startedAt === null || event.ts < startedAt) startedAt = event.ts;
    add(globalTotals, event);

    const totals = perAgent.get(event.agentId) ?? zero();
    add(totals, event);
    perAgent.set(event.agentId, totals);
    if (!firstSeen.has(event.agentId)) firstSeen.set(event.agentId, event.ts);

    const bucket = Math.min(
      SPARK_BUCKETS - 1,
      Math.max(0, Math.floor(((event.ts - since) / windowMs) * SPARK_BUCKETS)),
    );
    const spend =
      event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
    const spark = sparks.get(event.agentId) ?? new Array<number>(SPARK_BUCKETS).fill(0);
    spark[bucket] = (spark[bucket] ?? 0) + spend;
    sparks.set(event.agentId, spark);
  }

  return {
    serverTime: now,
    window: toWindow(globalTotals, startedAt, windowMs),
    agents: agents.map((agent) => ({
      agentId: agent.id,
      agentName: agent.name,
      status: agent.status,
      stats: agent.stats,
      window: toWindow(perAgent.get(agent.id) ?? zero(), firstSeen.get(agent.id) ?? null, windowMs),
      spark: sparks.get(agent.id) ?? new Array<number>(SPARK_BUCKETS).fill(0),
    })),
    memory: await memoryStats(),
    durable: hasDb(),
  };
}

/**
 * What the fleet's collected memory looks like in aggregate.
 *
 * "Memory" here is the CLAUDE.md and memory-file corpus the daemons sync into
 * the memory channel — the thing that actually shapes how every agent behaves.
 */
async function memoryStats(): Promise<FleetStats['memory']> {
  const files = await listFiles('chn_memory');
  const machines = new Set(files.map((f) => f.uploadedBy));
  return {
    files: files.length,
    bytes: files.reduce((sum, f) => sum + f.size, 0),
    machines: machines.size,
    lastSyncAt: files.length === 0 ? null : Math.max(...files.map((f) => f.uploadedAt)),
  };
}
