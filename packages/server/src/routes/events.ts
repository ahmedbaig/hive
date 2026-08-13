import { EventType } from '@hive/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAgent, touch, updateAgent } from '../services/agents.js';
import { listEvents, recordEvent } from '../services/events.js';

const IngestBody = z.object({
  agentId: z.string(),
  agentName: z.string().default('unknown'),
  type: EventType,
  subject: z.string().nullable().default(null),
  detail: z.record(z.unknown()).default({}),
  ts: z.number().int().optional(),
});

export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/events', async (req) => {
    const { limit, agentId, type } = req.query as {
      limit?: string;
      agentId?: string;
      type?: string;
    };
    return {
      events: await listEvents({
        limit: limit ? Number(limit) : 200,
        agentId,
        type,
      }),
    };
  });

  /**
   * Telemetry sink for the Claude Code hooks. Deliberately permissive: a
   * malformed event must never break the hook that emitted it, so validation
   * failures answer 202 and are dropped rather than surfacing an error into a
   * live session.
   */
  app.post('/api/events', async (req, reply) => {
    const parsed = IngestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(202).send({ ok: false, dropped: true });

    // Any hook traffic doubles as proof of life for that machine.
    await touch(parsed.data.agentId);
    await trackStatus(parsed.data.agentId, parsed.data.type, parsed.data.detail);
    const event = await recordEvent(parsed.data);
    return reply.code(202).send({ ok: true, eventId: event.id });
  });
}

/**
 * Derive agent status from session lifecycle events.
 *
 * Without this the roster only ever changes when a permission is gated, so an
 * agent that runs entirely auto-allowed tools looks idle while it works — and
 * `hive_agent_busy_seconds_total` under-reports. A turn ending is the only
 * reliable "done" signal Claude Code emits.
 *
 * A paused agent is left alone: the operator paused it deliberately, and hook
 * traffic from an in-flight turn must not silently un-pause it.
 */
async function trackStatus(
  agentId: string,
  type: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const current = await getAgent(agentId);
  if (!current || current.status === 'paused') return;

  switch (type) {
    case 'prompt.submit':
      await updateAgent(agentId, {
        status: 'working',
        activity: typeof detail.prompt === 'string' ? detail.prompt.slice(0, 120) : 'working',
      });
      return;
    case 'tool.post':
      // Mid-turn activity: keep the status line current without flapping.
      if (current.status === 'working') {
        await updateAgent(agentId, { activity: describeTool(detail) ?? current.activity });
      }
      return;
    case 'turn.stop':
    case 'session.end':
      await updateAgent(agentId, { status: 'idle', activity: null });
      return;
    default:
      return;
  }
}

function describeTool(detail: Record<string, unknown>): string | null {
  for (const key of ['command', 'file_path', 'url']) {
    const value = detail[key];
    if (typeof value === 'string' && value) return value.slice(0, 120);
  }
  return null;
}
