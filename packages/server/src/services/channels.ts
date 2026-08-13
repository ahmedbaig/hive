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
const DEFAULT_CHANNELS: Array<Pick<Channel, 'id' | 'name' | 'kind' | 'topic'>> = [
  { id: 'chn_lobby', name: 'lobby', kind: 'group', topic: 'General fleet chat' },
  { id: 'chn_ops', name: 'ops', kind: 'group', topic: 'Approvals, control, incidents' },
  { id: 'chn_system', name: 'system', kind: 'system', topic: 'Server announcements' },
  {
    id: 'chn_memory',
    name: 'memory',
    kind: 'group',
    topic: 'CLAUDE.md and memory files collected from each machine',
  },
  {
    id: 'chn_sessions',
    name: 'sessions',
    kind: 'group',
    topic: 'Live Claude Code session transcripts',
  },
];

export async function ensureDefaultChannels(): Promise<void> {
  for (const seed of DEFAULT_CHANNELS) {
    const exists = await redis.hexists(K.channels, seed.id);
    if (exists) continue;
    const channel = Channel.parse({
      ...seed,
      members: [],
      createdAt: Date.now(),
      createdBy: 'system',
      archived: false,
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
  members?: string[];
  createdBy: string;
}): Promise<Channel> {
  const channel = Channel.parse({
    id: ID.channel(),
    name: input.name,
    kind: input.kind ?? 'group',
    topic: input.topic ?? '',
    members: input.members ?? [],
    createdAt: Date.now(),
    createdBy: input.createdBy,
    archived: false,
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

/** Resolve by id first, then by name, so the MCP tools can take either. */
export async function resolveChannel(idOrName: string): Promise<Channel | null> {
  const direct = await getChannel(idOrName);
  if (direct) return direct;
  const all = await listChannels();
  return all.find((c) => c.name === idOrName) ?? null;
}

export async function listChannels(): Promise<Channel[]> {
  const all = await redis.hgetall(K.channels);
  const out: Channel[] = [];
  for (const raw of Object.values(all)) {
    const parsed = Channel.safeParse(JSON.parse(raw));
    if (parsed.success) out.push(parsed.data);
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
    `insert into channels (id, name, kind, topic, created_at, created_by)
     values ($1,$2,$3,$4, to_timestamp($5/1000.0), $6)
     on conflict (id) do update set name = excluded.name, topic = excluded.topic`,
    [channel.id, channel.name, channel.kind, channel.topic, channel.createdAt, channel.createdBy],
  );
}
