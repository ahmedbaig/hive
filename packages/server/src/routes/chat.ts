import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAgent, listAgents } from '../services/agents.js';
import {
  createChannel,
  ensureDirectChannel,
  joinChannel,
  leaveChannel,
  listChannels,
  resolveChannel,
} from '../services/channels.js';
import { inboxCount, listMessages, postMessage, readInbox } from '../services/messages.js';
import { actorFrom } from './auth.js';

const PostBody = z.object({
  body: z.string().min(1).max(64_000),
  replyTo: z.string().nullable().default(null),
  mentions: z.array(z.string()).default([]),
  attachments: z
    .array(
      z.object({
        fileId: z.string(),
        filename: z.string(),
        size: z.number().int(),
        mime: z.string(),
        sha256: z.string(),
      }),
    )
    .default([]),
  kind: z.enum(['text', 'command', 'result', 'council_turn']).default('text'),
  meta: z.record(z.unknown()).default({}),
});

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels', async () => ({ channels: await listChannels() }));

  app.post('/api/channels', async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(80),
        kind: z.enum(['group', 'direct', 'council', 'system']).default('group'),
        topic: z.string().default(''),
        members: z.array(z.string()).default([]),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid channel' });
    const actor = actorFrom(req);
    const channel = await createChannel({ ...parsed.data, createdBy: actor.name });
    return { channel };
  });

  /** Open (or reuse) a direct thread between two agents. */
  app.post('/api/channels/direct', async (req, reply) => {
    const parsed = z.object({ a: z.string(), b: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'need both agent ids' });
    const channel = await ensureDirectChannel(parsed.data.a, parsed.data.b);
    return { channel };
  });

  app.get('/api/channels/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const channel = await resolveChannel(id);
    if (!channel) return reply.code(404).send({ error: 'unknown channel' });
    const { limit } = req.query as { limit?: string };
    const messages = await listMessages(channel.id, limit ? Number(limit) : 100);
    return { channel, messages };
  });

  app.post('/api/channels/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const channel = await resolveChannel(id);
    if (!channel) return reply.code(404).send({ error: 'unknown channel' });

    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid message', detail: parsed.error.flatten() });
    }

    const actor = actorFrom(req);
    // Mentions may name agents rather than ids; resolve so delivery works
    // whichever the caller used.
    const mentions = await resolveMentions(parsed.data.mentions);

    try {
      const message = await postMessage(
        { channelId: channel.id, ...parsed.data, mentions },
        { type: actor.isAgent ? 'agent' : 'human', id: actor.id, name: actor.name },
      );
      return { message };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/channels/:id/join', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ agentId: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'agentId required' });
    const channel = await joinChannel(id, parsed.data.agentId);
    if (!channel) return reply.code(404).send({ error: 'unknown channel' });
    return { channel };
  });

  app.post('/api/channels/:id/leave', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ agentId: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'agentId required' });
    const channel = await leaveChannel(id, parsed.data.agentId);
    if (!channel) return reply.code(404).send({ error: 'unknown channel' });
    return { channel };
  });

  /** An agent's unread queue. `peek=1` leaves the queue intact. */
  app.get('/api/agents/:id/inbox', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!(await getAgent(id))) return reply.code(404).send({ error: 'unknown agent' });
    const { limit, peek } = req.query as { limit?: string; peek?: string };
    const messages = await readInbox(id, {
      limit: limit ? Number(limit) : 50,
      peek: peek === '1' || peek === 'true',
    });
    return { messages, remaining: await inboxCount(id) };
  });
}

async function resolveMentions(mentions: string[]): Promise<string[]> {
  if (mentions.length === 0) return [];
  const needsLookup = mentions.some((m) => m !== '@all' && !m.startsWith('agt_'));
  if (!needsLookup) return mentions;

  const agents = await listAgents();
  return mentions.map((mention) => {
    if (mention === '@all' || mention.startsWith('agt_')) return mention;
    const bare = mention.startsWith('@') ? mention.slice(1) : mention;
    return agents.find((a) => a.name === bare)?.id ?? mention;
  });
}
