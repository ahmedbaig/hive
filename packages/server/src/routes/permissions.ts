import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import {
  decidePermission,
  getKillSwitch,
  listPending,
  listPermissionHistory,
  requestPermission,
  setAgentPause,
  setKillSwitch,
} from '../services/permissions.js';
import { actorFrom } from './auth.js';

const RequestBody = z.object({
  agentId: z.string(),
  agentName: z.string().default('unknown'),
  toolName: z.string(),
  toolInput: z.record(z.unknown()).default({}),
  cwd: z.string().default(''),
  timeoutMs: z.number().int().optional(),
});

const DecisionBody = z.object({
  decision: z.enum(['allow', 'deny']),
  reason: z.string().nullable().default(null),
});

export async function permissionRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Long-polling endpoint the PreToolUse hook calls. The response is delayed
   * until an operator decides or the deadline passes, so the hook stays a
   * single blocking HTTP call with no Redis client of its own.
   */
  app.post('/api/permissions/request', async (req, reply) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid request', detail: parsed.error.flatten() });
    }
    const outcome = await requestPermission(parsed.data);
    return {
      permissionId: outcome.request.id,
      decision: outcome.decision,
      reason: outcome.reason,
      status: outcome.request.status,
    };
  });

  app.get('/api/permissions/pending', async () => ({ pending: await listPending() }));

  app.get('/api/permissions/history', async (req) => {
    const { limit } = req.query as { limit?: string };
    return { permissions: await listPermissionHistory(limit ? Number(limit) : 200) };
  });

  app.post('/api/permissions/:id/decide', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = DecisionBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'decision must be allow or deny' });

    const actor = actorFrom(req);
    const updated = await decidePermission(id, parsed.data.decision, actor.name, parsed.data.reason);
    if (!updated) return reply.code(404).send({ error: 'unknown or already-resolved request' });
    return { request: updated };
  });

  /* ── Fleet control ─────────────────────────────────────────────────────── */

  app.get('/api/control', async () => ({
    killSwitch: await getKillSwitch(),
    autoAllow: config.autoAllow,
    permissionTimeoutMs: config.permissionTimeoutMs,
  }));

  /**
   * Engaging the kill switch denies every subsequent tool call fleet-wide,
   * including calls that would otherwise be auto-allowed. It does not interrupt
   * work already in flight — pair it with a `stop` command per agent for that.
   */
  app.post('/api/control/killswitch', async (req, reply) => {
    const parsed = z
      .object({ engaged: z.boolean(), reason: z.string().default('stopped by operator') })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'engaged flag required' });
    await setKillSwitch(parsed.data.engaged ? parsed.data.reason : null);
    return { killSwitch: await getKillSwitch() };
  });

  app.post('/api/control/agents/:id/pause', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ paused: z.boolean(), reason: z.string().default('paused by operator') })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'paused flag required' });
    await setAgentPause(id, parsed.data.paused ? parsed.data.reason : null);
    return { ok: true };
  });
}
