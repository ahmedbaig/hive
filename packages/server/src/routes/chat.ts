import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAgent, listAgents } from '../services/agents.js';
import {
  createChannel,
  deleteChannel,
  ensureDirectChannel,
  joinChannel,
  leaveChannel,
  listChannels,
  renderChannelContext,
  resolveChannel,
  restoreChannel,
  setArchived,
  updateChannel,
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
  app.get('/api/channels', async (req) => {
    const { includeDeleted } = req.query as { includeDeleted?: string };
    return {
      channels: await listChannels({
        includeDeleted: includeDeleted === '1' || includeDeleted === 'true',
      }),
    };
  });

  app.post('/api/channels', async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(80),
        kind: z.enum(['group', 'direct', 'council', 'system']).default('group'),
        topic: z.string().max(300).default(''),
        description: z.string().max(2_000).default(''),
        members: z.array(z.string()).default([]),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid channel' });
    const actor = actorFrom(req);
    const channel = await createChannel({ ...parsed.data, createdBy: actor.name });
    return { channel };
  });

  app.patch('/api/channels/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({
        name: z.string().min(1).max(80).optional(),
        topic: z.string().max(300).optional(),
        description: z.string().max(2_000).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid patch' });
    const existing = await resolveChannel(id);
    if (!existing) return reply.code(404).send({ error: 'unknown channel' });
    const channel = await updateChannel(existing.id, parsed.data);
    return { channel };
  });

  app.post('/api/channels/:id/archive', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ archived: z.boolean().default(true) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid request' });
    const existing = await resolveChannel(id);
    if (!existing) return reply.code(404).send({ error: 'unknown channel' });
    const channel = await setArchived(existing.id, parsed.data.archived);
    return { channel };
  });

  /**
   * Soft delete. Answers 409 for the built-in channels rather than pretending
   * to succeed — the fleet's plumbing addresses those by name.
   */
  app.delete('/api/channels/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await resolveChannel(id);
    if (!existing) return reply.code(404).send({ error: 'unknown channel' });
    const result = await deleteChannel(existing.id);
    if (result === 'protected') {
      return reply.code(409).send({ error: 'built-in channels cannot be deleted, only archived' });
    }
    if (!result) return reply.code(404).send({ error: 'unknown channel' });
    return { channel: result };
  });

  app.post('/api/channels/:id/restore', async (req, reply) => {
    const { id } = req.params as { id: string };
    const channel = await restoreChannel(id);
    if (!channel) return reply.code(404).send({ error: 'unknown channel' });
    return { channel };
  });

  /**
   * The standing context block for a channel, rendered server-side so every
   * agent path states the purpose with the same wording.
   */
  app.get('/api/channels/:id/context', async (req, reply) => {
    const { id } = req.params as { id: string };
    const channel = await resolveChannel(id);
    if (!channel) return reply.code(404).send({ error: 'unknown channel' });
    const roster = await listAgents();
    const participants = roster
      .filter((a) => channel.members.includes(a.id))
      .map((a) => ({ name: a.name, host: a.host, role: a.role }));
    return { channel, context: renderChannelContext(channel, participants) };
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
    // Mentions may name agents rather than ids, and may only exist as `@name`
    // in the prose; resolve both so delivery works whichever the caller used.
    const mentions = await resolveMentions(
      mentionsFrom(parsed.data.body, parsed.data.mentions),
    );

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

/** `@name`, not preceded by a word character so emails do not become mentions. */
const MENTION_RE = /(?:^|[^\w@])@([\w.-]+)/g;

/**
 * Union of the caller's explicit mentions and any `@name` in the body.
 *
 * The web client extracts mentions before posting, but agent daemons post raw
 * prose — without this, one agent naming another in a sentence was never
 * delivered, so agents could only ever answer the human.
 */
function mentionsFrom(body: string, explicit: string[]): string[] {
  const inline = [...body.matchAll(MENTION_RE)].map((m) => m[1] ?? '');
  return [...new Set([...explicit, ...inline].filter(Boolean))];
}

async function resolveMentions(mentions: string[]): Promise<string[]> {
  if (mentions.length === 0) return [];
  const needsLookup = mentions.some((m) => m !== '@all' && !m.startsWith('agt_'));
  if (!needsLookup) return [...new Set(mentions)];

  const agents = await listAgents();
  const resolved = mentions.map((mention) => {
    if (mention === '@all' || mention.startsWith('agt_')) return mention;
    const bare = mention.startsWith('@') ? mention.slice(1) : mention;
    const lower = bare.toLowerCase();
    return agents.find((a) => a.name.toLowerCase() === lower)?.id ?? mention;
  });
  // `@macmini` and `macmini` both resolve to one id; fanout must not double.
  return [...new Set(resolved)];
}
