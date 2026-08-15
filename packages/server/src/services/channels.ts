import { Channel, ID, K } from '@hive/shared';
import { queueWrite } from '../db.js';
import { broadcast } from '../hub.js';
import { log } from '../log.js';
import { redis } from '../redis.js';

/**
 * Channels every fleet gets on first boot. `lobby` is where agents introduce
 * themselves, `ops` carries permission and control chatter, `system` is
 * server-authored and read-only for agents.
 */
const DEFAULT_CHANNELS: Array<Pick<Channel, 'id' | 'name' | 'kind' | 'topic' | 'description'>> = [
  {
    id: 'chn_lobby',
    name: 'lobby',
    kind: 'group',
    topic: 'General fleet chat',
    description:
      'Open floor for the fleet. Agents introduce themselves here, the operator ' +
      'hands out work, and anything without a better home lands here.',
  },
  {
    id: 'chn_ops',
    name: 'ops',
    kind: 'group',
    topic: 'Approvals, control, incidents',
    description:
      'Operational traffic: permission decisions, kill-switch events, machines ' +
      'going offline. Keep it terse and factual — this is the incident record.',
  },
  {
    id: 'chn_system',
    name: 'system',
    kind: 'system',
    topic: 'Server announcements',
    description: 'Server-authored announcements. Read-only for agents.',
  },
  {
    id: 'chn_memory',
    name: 'memory',
    kind: 'group',
    topic: 'CLAUDE.md and memory files collected from each machine',
    description:
      'Every machine publishes its CLAUDE.md and memory files here so the fleet ' +
      'can see what rules each agent is operating under.',
  },
  {
    id: 'chn_sessions',
    name: 'sessions',
    kind: 'group',
    topic: 'Live Claude Code session transcripts',
    description:
      'Mirrored session transcripts. High volume and machine-written — read it ' +
      'for context, do not hold conversations in it.',
  },
];

export async function ensureDefaultChannels(): Promise<void> {
  for (const seed of DEFAULT_CHANNELS) {
    const existing = await getChannel(seed.id);
    if (existing) {
      // Backfill only. A channel created before descriptions existed has an
      // empty one, and an agent reading that channel has no idea what it is
      // for — but an operator who has since written their own must keep it.
      if (!existing.description) await write({ ...existing, description: seed.description });
      continue;
    }
    const channel = Channel.parse({
      ...seed,
      members: [],
      createdAt: Date.now(),
      createdBy: 'system',
    });
    await redis.hset(K.channels, channel.id, JSON.stringify(channel));
    log.info({ channel: channel.name }, 'created default channel');
  }

  // Re-persist every channel on boot. Channels created while Postgres was
  // unreachable would otherwise never reach the database, leaving history rows
  // pointing at channels the durable store has never heard of.
  for (const channel of await listChannels()) persist(channel);
}

/**
 * Channels a newly registered agent is put into automatically. Without this an
 * agent is in the roster but in no channel, so `@all` fanout reaches nobody and
 * its inbox stays empty no matter what the fleet says.
 */
export async function joinDefaultChannels(agentId: string): Promise<void> {
  for (const seed of DEFAULT_CHANNELS) {
    if (seed.kind === 'system') continue; // announcements are read-only for agents
    await joinChannel(seed.id, agentId);
  }
}

export async function createChannel(input: {
  name: string;
  kind?: Channel['kind'];
  topic?: string;
  description?: string;
  members?: string[];
  createdBy: string;
}): Promise<Channel> {
  const channel = Channel.parse({
    id: ID.channel(),
    name: normaliseName(input.name),
    kind: input.kind ?? 'group',
    topic: input.topic ?? '',
    description: input.description ?? '',
    members: input.members ?? [],
    createdAt: Date.now(),
    createdBy: input.createdBy,
  });
  await redis.hset(K.channels, channel.id, JSON.stringify(channel));
  for (const member of channel.members) {
    await redis.sadd(K.agentChannels(member), channel.id);
  }
  persist(channel);
  broadcast({ t: 'channel', channel });
  return channel;
}

/**
 * Channel names address a channel everywhere — MCP tools, daemon reply rules,
 * `#name` in prose — so a name with a space or a leading `#` resolves to
 * nothing later. Normalised once here rather than defended against at every
 * lookup.
 */
function normaliseName(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9:_-]/g, '');
  return cleaned.slice(0, 80) || 'channel';
}

/** Editable fields. Kind and id are fixed for the life of the channel. */
export async function updateChannel(
  id: string,
  patch: { name?: string; topic?: string; description?: string },
): Promise<Channel | null> {
  const channel = await getChannel(id);
  if (!channel) return null;
  const next: Channel = {
    ...channel,
    ...(patch.name !== undefined ? { name: normaliseName(patch.name) } : {}),
    ...(patch.topic !== undefined ? { topic: patch.topic.slice(0, 300) } : {}),
    ...(patch.description !== undefined ? { description: patch.description.slice(0, 2_000) } : {}),
  };
  await write(next);
  return next;
}

/**
 * Archive or restore. Archived channels keep every message and every member —
 * they leave the sidebar's live list and nothing else — so this is reversible
 * with no data movement at all.
 */
export async function setArchived(id: string, archived: boolean): Promise<Channel | null> {
  const channel = await getChannel(id);
  if (!channel) return null;
  const next: Channel = {
    ...channel,
    archived,
    archivedAt: archived ? (channel.archivedAt ?? Date.now()) : null,
  };
  await write(next);
  return next;
}

/**
 * Soft delete. The row and its history stay; the channel stops being listed and
 * stops accepting posts. Undo is just clearing the timestamp, which is why the
 * UI can offer a ten-second undo without holding anything in memory.
 *
 * The default channels refuse deletion: the fleet's plumbing (memory sync,
 * transcript mirroring, reply routing) addresses them by name, and removing one
 * breaks those paths silently rather than loudly.
 */
export async function deleteChannel(id: string): Promise<Channel | null | 'protected'> {
  const channel = await getChannel(id);
  if (!channel) return null;
  if (DEFAULT_CHANNELS.some((d) => d.id === channel.id)) return 'protected';
  const next: Channel = { ...channel, deletedAt: Date.now() };
  await write(next);
  broadcast({ t: 'channel.remove', channelId: next.id });
  return next;
}

export async function restoreChannel(id: string): Promise<Channel | null> {
  const channel = await getChannel(id);
  if (!channel) return null;
  const next: Channel = { ...channel, deletedAt: null };
  await write(next);
  return next;
}

/** Single write path: Redis, then Postgres, then the socket. */
async function write(channel: Channel): Promise<void> {
  await redis.hset(K.channels, channel.id, JSON.stringify(channel));
  persist(channel);
  broadcast({ t: 'channel', channel });
}

/**
 * The prompt block an agent sees before answering in a channel.
 *
 * Rendered server-side so every consumer — the daemon's reply turn, the MCP
 * read tool, a woken headless run — states the channel's purpose identically.
 * Phrased as standing context rather than as a message, or agents answer *it*
 * instead of answering the human.
 */
export function renderChannelContext(
  channel: Channel,
  participants: Array<{ name: string; host?: string; role?: string }> = [],
): string {
  const lines = [`Channel: #${channel.name}`];
  if (channel.description) lines.push(`Purpose: ${channel.description}`);
  if (channel.topic) lines.push(`Current topic: ${channel.topic}`);
  if (participants.length > 0) {
    lines.push(
      `Participants: ${participants
        .map((p) => [p.name, p.host, p.role].filter(Boolean).join(' · '))
        .join(', ')}`,
    );
  }
  lines.push('Reply on-topic for this channel. Do not restate the purpose back.');
  return lines.join('\n');
}

/**
 * Direct channels are keyed by the sorted participant pair so repeated opens
 * between the same two agents reuse one thread instead of piling up duplicates.
 */
export async function ensureDirectChannel(a: string, b: string): Promise<Channel> {
  const pair = [a, b].sort();
  const id = `chn_dm_${pair.join('__')}`.slice(0, 200);
  const existing = await getChannel(id);
  if (existing) return existing;

  const channel = Channel.parse({
    id,
    name: `dm:${pair.join('↔')}`,
    kind: 'direct',
    topic: '',
    members: pair,
    createdAt: Date.now(),
    createdBy: a,
    archived: false,
  });
  await redis.hset(K.channels, id, JSON.stringify(channel));
  for (const member of pair) await redis.sadd(K.agentChannels(member), id);
  persist(channel);
  broadcast({ t: 'channel', channel });
  return channel;
}

export async function getChannel(id: string): Promise<Channel | null> {
  const raw = await redis.hget(K.channels, id);
  if (!raw) return null;
  const parsed = Channel.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

/**
 * Resolve by id first, then by name, so the MCP tools can take either.
 *
 * Deleted channels resolve to nothing: everything that posts or reads goes
 * through here, so one check here is what makes a soft delete actually stop
 * traffic instead of merely hiding it in the sidebar.
 */
export async function resolveChannel(idOrName: string): Promise<Channel | null> {
  const direct = await getChannel(idOrName);
  if (direct) return direct.deletedAt === null ? direct : null;
  const bare = idOrName.startsWith('#') ? idOrName.slice(1) : idOrName;
  const all = await listChannels();
  return all.find((c) => c.name === bare) ?? null;
}

/**
 * Every channel the caller should see. Soft-deleted rows are excluded unless
 * asked for, so a stale client that still holds a deleted id gets a 404 from
 * `getChannel` rather than a channel nobody can see in the sidebar.
 */
export async function listChannels(opts: { includeDeleted?: boolean } = {}): Promise<Channel[]> {
  const all = await redis.hgetall(K.channels);
  const out: Channel[] = [];
  for (const raw of Object.values(all)) {
    const parsed = Channel.safeParse(JSON.parse(raw));
    if (!parsed.success) continue;
    if (!opts.includeDeleted && parsed.data.deletedAt !== null) continue;
    out.push(parsed.data);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

export async function joinChannel(channelId: string, agentId: string): Promise<Channel | null> {
  const channel = await getChannel(channelId);
  if (!channel) return null;
  if (channel.members.includes(agentId)) return channel;
  const next: Channel = { ...channel, members: [...channel.members, agentId] };
  await redis.hset(K.channels, channelId, JSON.stringify(next));
  await redis.sadd(K.agentChannels(agentId), channelId);
  broadcast({ t: 'channel', channel: next });
  return next;
}

export async function leaveChannel(channelId: string, agentId: string): Promise<Channel | null> {
  const channel = await getChannel(channelId);
  if (!channel) return null;
  const next: Channel = { ...channel, members: channel.members.filter((m) => m !== agentId) };
  await redis.hset(K.channels, channelId, JSON.stringify(next));
  await redis.srem(K.agentChannels(agentId), channelId);
  broadcast({ t: 'channel', channel: next });
  return next;
}

function persist(channel: Channel): void {
  queueWrite(
    `insert into channels (id, name, kind, topic, description, created_at, created_by, archived_at, deleted_at)
     values ($1,$2,$3,$4,$5, to_timestamp($6/1000.0), $7, $8, $9)
     on conflict (id) do update set
       name        = excluded.name,
       topic       = excluded.topic,
       description = excluded.description,
       archived_at = excluded.archived_at,
       deleted_at  = excluded.deleted_at`,
    [
      channel.id,
      channel.name,
      channel.kind,
      channel.topic,
      channel.description,
      channel.createdAt,
      channel.createdBy,
      channel.archivedAt === null ? null : new Date(channel.archivedAt),
      channel.deletedAt === null ? null : new Date(channel.deletedAt),
    ],
  );
}
