import {
  AgentRecord,
  type AgentRegistration,
  K,
  deriveAgentId,
} from '@hive/shared';
import { config } from '../config.js';
import { queueWrite } from '../db.js';
import { broadcast } from '../hub.js';
import { log } from '../log.js';
import { redis } from '../redis.js';
import { joinDefaultChannels } from './channels.js';
import { recordEvent } from './events.js';

/**
 * Registration is idempotent. An agent id is derived from host + session key so
 * a daemon that reconnects after a crash reclaims its roster row instead of
 * leaving a ghost behind.
 */
export async function registerAgent(
  reg: AgentRegistration,
  sessionKey: string,
): Promise<AgentRecord> {
  const id = deriveAgentId(reg.host, sessionKey);
  const now = Date.now();
  const existingRaw = await redis.hget(K.agents, id);
  const existing = existingRaw ? safeParse(existingRaw) : null;

  const record: AgentRecord = AgentRecord.parse({
    id,
    name: reg.name,
    host: reg.host,
    platform: reg.platform,
    pid: reg.pid,
    cwd: reg.cwd,
    sessionId: reg.sessionId ?? null,
    model: reg.model ?? null,
    role: reg.role ?? 'worker',
    status: 'idle',
    tags: reg.tags ?? [],
    wakeEnabled: reg.wakeEnabled ?? false,
    version: reg.version ?? null,
    registeredAt: existing?.registeredAt ?? now,
    lastSeen: now,
    activity: null,
  });

  await redis.hset(K.agents, id, JSON.stringify(record));
  await touch(id);
  await joinDefaultChannels(id);

  broadcast({ t: 'agent', agent: record });
  await recordEvent({
    agentId: id,
    agentName: record.name,
    type: 'agent.register',
    subject: record.host,
    detail: { cwd: record.cwd, pid: record.pid, role: record.role },
  });

  queueWrite(
    `insert into agents (id, name, host, platform, cwd, role, registered_at, last_seen)
     values ($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0), to_timestamp($8/1000.0))
     on conflict (id) do update set
       name = excluded.name, host = excluded.host, platform = excluded.platform,
       cwd = excluded.cwd, role = excluded.role, last_seen = excluded.last_seen`,
    [id, record.name, record.host, record.platform, record.cwd, record.role, record.registeredAt, now],
  );

  log.info({ agentId: id, name: record.name, host: record.host }, 'agent registered');
  return record;
}

/** Refresh the volatile presence key. Absence of this key means offline. */
export async function touch(agentId: string): Promise<void> {
  await redis.set(K.heartbeat(agentId), Date.now().toString(), 'PX', config.presenceTtlMs);
}

export async function getAgent(agentId: string): Promise<AgentRecord | null> {
  const raw = await redis.hget(K.agents, agentId);
  return raw ? safeParse(raw) : null;
}

export async function updateAgent(
  agentId: string,
  patch: Partial<AgentRecord>,
): Promise<AgentRecord | null> {
  const current = await getAgent(agentId);
  if (!current) return null;
  const next = AgentRecord.parse({ ...current, ...patch, id: agentId, lastSeen: Date.now() });
  await redis.hset(K.agents, agentId, JSON.stringify(next));
  broadcast({ t: 'agent', agent: next });
  return next;
}

/**
 * Roster with presence resolved. An agent whose heartbeat key has expired is
 * reported as offline rather than deleted, so the UI can show recent history
 * and the operator can still read what it was last doing.
 */
export async function listAgents(): Promise<AgentRecord[]> {
  const all = await redis.hgetall(K.agents);
  const ids = Object.keys(all);
  if (ids.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.exists(K.heartbeat(id));
  const presence = await pipeline.exec();

  const out: AgentRecord[] = [];
  ids.forEach((id, i) => {
    const raw = all[id];
    if (!raw) return;
    const rec = safeParse(raw);
    if (!rec) return;
    const alive = presence?.[i]?.[1] === 1;
    out.push(alive ? rec : { ...rec, status: 'offline' });
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function forgetAgent(agentId: string): Promise<void> {
  await redis.hdel(K.agents, agentId);
  await redis.del(K.heartbeat(agentId), K.commandQueue(agentId), K.agentPause(agentId));
  broadcast({ t: 'agent.remove', agentId });
  log.info({ agentId }, 'agent removed from roster');
}

/**
 * Periodic sweep so the UI flips agents to offline even when nobody is polling
 * the roster. Emits one event per transition rather than on every tick.
 */
export function startPresenceSweep(): NodeJS.Timeout {
  const seenOffline = new Set<string>();
  return setInterval(() => {
    void (async () => {
      const agents = await listAgents();
      for (const agent of agents) {
        if (agent.status === 'offline') {
          if (!seenOffline.has(agent.id)) {
            seenOffline.add(agent.id);
            broadcast({ t: 'agent', agent });
            await recordEvent({
              agentId: agent.id,
              agentName: agent.name,
              type: 'agent.offline',
              subject: agent.host,
              detail: {},
            });
          }
        } else {
          seenOffline.delete(agent.id);
        }
      }
    })().catch((err) => log.error({ err: String(err) }, 'presence sweep failed'));
  }, Math.max(5_000, Math.floor(config.presenceTtlMs / 2)));
}

function safeParse(raw: string): AgentRecord | null {
  try {
    return AgentRecord.parse(JSON.parse(raw));
  } catch (err) {
    log.warn({ err: String(err) }, 'discarding malformed agent record');
    return null;
  }
}
