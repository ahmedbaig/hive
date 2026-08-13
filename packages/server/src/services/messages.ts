import { type Attachment, ID, K, Message, type MessageDraft } from '@hive/shared';
import { config } from '../config.js';
import { query, queueWrite } from '../db.js';
import { broadcast } from '../hub.js';
import { messageHopDepth, messagesPosted } from '../metrics.js';
import { redis } from '../redis.js';
import { resolveChannel } from './channels.js';

export interface Author {
  type: Message['authorType'];
  id: string;
  name: string;
}

/**
 * Mentions drive delivery. `@all` fans out to every member of the channel;
 * anything else is treated as an agent id or name resolved by the caller.
 */
export async function postMessage(draft: MessageDraft, author: Author): Promise<Message> {
  const channel = await resolveChannel(draft.channelId);
  if (!channel) throw new Error(`unknown channel: ${draft.channelId}`);
  if (channel.kind === 'system' && author.type === 'agent') {
    throw new Error('agents cannot post to the system channel');
  }

  const message = Message.parse({
    id: ID.message(),
    channelId: channel.id,
    ts: Date.now(),
    authorType: author.type,
    authorId: author.id,
    authorName: author.name,
    body: draft.body,
    replyTo: draft.replyTo ?? null,
    mentions: draft.mentions ?? [],
    hopDepth: author.type === 'agent' ? await nextHopDepth(draft.replyTo ?? null) : 0,
    attachments: (draft.attachments ?? []) as Attachment[],
    kind: draft.kind ?? 'text',
    meta: draft.meta ?? {},
  });

  await redis.xadd(
    K.chatStream(channel.id),
    'MAXLEN',
    '~',
    config.streamMaxLen,
    '*',
    'payload',
    JSON.stringify(message),
  );

  // Inbox fanout. Explicit mentions always land; otherwise every member except
  // the author gets it, so an agent polling its inbox sees channel traffic too.
  const recipients =
    message.mentions.includes('@all') || message.mentions.length === 0
      ? channel.members
      : message.mentions;
  const pipeline = redis.pipeline();
  for (const agentId of recipients) {
    if (agentId === author.id) continue;
    pipeline.zadd(K.inbox(agentId), message.ts, message.id);
    // Bound the inbox so an agent that never reads does not grow without limit.
    pipeline.zremrangebyrank(K.inbox(agentId), 0, -501);
  }
  await pipeline.exec();

  broadcast({ t: 'message', message });
  // Labelled by channel kind, not id: councils mint a channel each, so an id
  // label would grow the series set without bound.
  messagesPosted.inc({
    channel_kind: channel.kind,
    author_type: message.authorType,
    kind: message.kind,
  });
  messageHopDepth.observe({ author_type: message.authorType }, message.hopDepth);

  queueWrite(
    `insert into messages
       (id, channel_id, ts, author_type, author_id, author_name, body, reply_to, mentions, attachments, kind, meta, hop_depth)
     values ($1,$2, to_timestamp($3/1000.0), $4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (id) do nothing`,
    [
      message.id,
      message.channelId,
      message.ts,
      message.authorType,
      message.authorId,
      message.authorName,
      message.body,
      message.replyTo,
      message.mentions,
      JSON.stringify(message.attachments),
      message.kind,
      message.meta,
      message.hopDepth,
    ],
  );

  return message;
}

/**
 * Depth of the chain a new agent message continues.
 *
 * A reply inherits its parent's depth plus one; an agent message that threads
 * off nothing starts its own chain at 1. Resolved here rather than trusted from
 * the request so a daemon cannot keep a conversation alive by claiming depth 0.
 */
async function nextHopDepth(replyTo: string | null): Promise<number> {
  if (!replyTo) return 1;
  const [parent] = await hydrate([replyTo]);
  return (parent?.hopDepth ?? 0) + 1;
}

/** Chronological page. Postgres when present, Redis stream as the fallback. */
export async function listMessages(channelId: string, limit = 100): Promise<Message[]> {
  const capped = Math.min(limit, 500);

  const rows = await query<{
    id: string;
    channel_id: string;
    ts: Date;
    author_type: string;
    author_id: string;
    author_name: string;
    body: string;
    reply_to: string | null;
    mentions: string[];
    attachments: unknown;
    kind: string;
    meta: Record<string, unknown>;
    hop_depth: number | null;
  }>(
    `select * from messages where channel_id = $1 order by ts desc limit $2`,
    [channelId, capped],
  );

  if (rows.length > 0) {
    return rows
      .map((r) =>
        Message.parse({
          id: r.id,
          channelId: r.channel_id,
          ts: r.ts.getTime(),
          authorType: r.author_type,
          authorId: r.author_id,
          authorName: r.author_name,
          body: r.body,
          replyTo: r.reply_to,
          mentions: r.mentions ?? [],
          attachments: typeof r.attachments === 'string' ? JSON.parse(r.attachments) : (r.attachments ?? []),
          kind: r.kind,
          meta: r.meta ?? {},
          hopDepth: r.hop_depth ?? 0,
        }),
      )
      .reverse();
  }

  const entries = await redis.xrevrange(K.chatStream(channelId), '+', '-', 'COUNT', capped);
  const out: Message[] = [];
  for (const [, fields] of entries) {
    const idx = fields.indexOf('payload');
    const raw = idx >= 0 ? fields[idx + 1] : undefined;
    if (!raw) continue;
    const parsed = Message.safeParse(JSON.parse(raw));
    if (parsed.success) out.push(parsed.data);
  }
  return out.reverse();
}

/**
 * Drain an agent's unread queue. Reads are destructive by default — an agent
 * that has seen a message should not see it again on the next poll — but the
 * message itself stays in channel history.
 */
export async function readInbox(
  agentId: string,
  opts: { limit?: number; peek?: boolean } = {},
): Promise<Message[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  const ids = await redis.zrange(K.inbox(agentId), 0, limit - 1);
  if (ids.length === 0) return [];
  if (!opts.peek) await redis.zrem(K.inbox(agentId), ...ids);
  return hydrate(ids);
}

export async function inboxCount(agentId: string): Promise<number> {
  return redis.zcard(K.inbox(agentId));
}

/**
 * Message ids are timestamp-sortable, so the channel is not known from the id
 * alone. Postgres resolves them directly; without it we scan the recent window
 * of every channel stream, which is bounded by streamMaxLen.
 */
async function hydrate(ids: string[]): Promise<Message[]> {
  const rows = await query<{ payload: unknown }>(
    `select row_to_json(m) as payload from messages m where id = any($1::text[]) order by ts asc`,
    [ids],
  );
  if (rows.length > 0) {
    return rows
      .map((r) => {
        const p = r.payload as Record<string, unknown>;
        return Message.safeParse({
          id: p.id,
          channelId: p.channel_id,
          ts: new Date(p.ts as string).getTime(),
          authorType: p.author_type,
          authorId: p.author_id,
          authorName: p.author_name,
          body: p.body,
          replyTo: p.reply_to,
          mentions: p.mentions ?? [],
          attachments: p.attachments ?? [],
          kind: p.kind,
          meta: p.meta ?? {},
          hopDepth: p.hop_depth ?? 0,
        });
      })
      .filter((r) => r.success)
      .map((r) => r.data);
  }

  const wanted = new Set(ids);
  const found: Message[] = [];
  const channelKeys = await redis.keys(K.chatStream('*'));
  for (const key of channelKeys) {
    const entries = await redis.xrevrange(key, '+', '-', 'COUNT', config.streamMaxLen);
    for (const [, fields] of entries) {
      const idx = fields.indexOf('payload');
      const raw = idx >= 0 ? fields[idx + 1] : undefined;
      if (!raw) continue;
      const parsed = Message.safeParse(JSON.parse(raw));
      if (parsed.success && wanted.has(parsed.data.id)) found.push(parsed.data);
    }
    if (found.length === wanted.size) break;
  }
  return found.sort((a, b) => a.ts - b.ts);
}
