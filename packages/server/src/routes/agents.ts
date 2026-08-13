import { AgentRegistration } from '@hive/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  forgetAgent,
  getAgent,
  listAgents,
  registerAgent,
  touch,
  updateAgent,
} from '../services/agents.js';
import { drainCommands, issueCommand } from '../services/commands.js';
import { actorFrom } from './auth.js';

const RegisterBody = AgentRegistration.extend({
  /** Stable per-machine key: Claude session id, or a daemon-generated uuid. */
  sessionKey: z.string().min(1),
});

const CommandBody = z.object({
  kind: z.enum(['wake', 'stop', 'pause', 'resume', 'shutdown', 'ping']),
  payload: z.string().default(''),
  replyChannelId: z.string().nullable().default(null),
});

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agents', async () => ({ agents: await listAgents() }));

  app.get('/api/agents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    return { agent };
  });

  app.post('/api/agents/register', async (req, reply) => {
    const parsed = RegisterBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid registration', detail: parsed.error.flatten() });
    }
    const { sessionKey, ...registration } = parsed.data;
    const agent = await registerAgent(registration, sessionKey);
    // Anything queued while this machine was down is handed back immediately so
    // the daemon can act on it before announcing itself as idle.
    const pending = await drainCommands(agent.id);
    return { agent, pendingCommands: pending };
  });

  app.post('/api/agents/:id/heartbeat', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    await touch(id);

    const body = z
      .object({
        status: z.enum(['idle', 'working', 'waiting_approval', 'paused', 'offline']).optional(),
        activity: z.string().nullable().optional(),
      })
      .safeParse(req.body ?? {});
    if (body.success && (body.data.status || body.data.activity !== undefined)) {
      await updateAgent(id, {
        ...(body.data.status ? { status: body.data.status } : {}),
        ...(body.data.activity !== undefined ? { activity: body.data.activity } : {}),
      });
    }
    return { ok: true };
  });

  app.post('/api/agents/:id/commands', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    const parsed = CommandBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid command' });

    const actor = actorFrom(req);
    const command = await issueCommand({
      agentId: id,
      kind: parsed.data.kind,
      payload: parsed.data.payload,
      replyChannelId: parsed.data.replyChannelId,
      issuedBy: actor.name,
    });
    return { command };
  });

  /** Daemon-side drain, used on reconnect when the socket was down. */
  app.get('/api/agents/:id/commands', async (req) => {
    const { id } = req.params as { id: string };
    return { commands: await drainCommands(id) };
  });

  app.delete('/api/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    await forgetAgent(id);
    return { ok: true };
  });
}
