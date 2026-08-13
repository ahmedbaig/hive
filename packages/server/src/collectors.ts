import { K } from '@hive/shared';
import { listConnections } from './hub.js';
import { log } from './log.js';
import {
  agentInfo,
  agentLastSeen,
  agentStatus,
  agentUp,
  agentsByStatus,
  agentsPaused,
  councilsByPhase,
  inboxDepth,
  killSwitchEngaged,
  oldestPendingAge,
  permissionsPending,
  redisLatency,
  redisUp,
  wsConnections,
} from './metrics.js';
import { redis } from './redis.js';
import { listAgents } from './services/agents.js';
import { listCouncils } from './services/council.js';
import { listPending } from './services/permissions.js';

const ALL_STATUSES = ['idle', 'working', 'waiting_approval', 'paused', 'offline'] as const;
const ALL_PHASES = ['gathering', 'opening', 'debate', 'voting', 'closed'] as const;

/**
 * Refresh point-in-time gauges immediately before serialisation.
 *
 * These describe current state rather than accumulated activity, so reading
 * them at scrape time is both cheaper and more accurate than maintaining them
 * on every mutation — and it means a value can never drift out of sync with
 * Redis after a missed update.
 */
export async function refreshGauges(): Promise<void> {
  const started = Date.now();

  // Redis liveness doubles as the scrape's own health check.
  try {
    const pingStart = Date.now();
    const pong = await redis.ping();
    redisLatency.set((Date.now() - pingStart) / 1000);
    redisUp.set(pong === 'PONG' ? 1 : 0);
  } catch {
    redisUp.set(0);
  }

  const agents = await listAgents();

  // Reset before repopulating: an agent that was forgotten must not linger as a
  // stale series reporting its last known status forever.
  agentUp.reset();
  agentStatus.reset();
  agentLastSeen.reset();
  agentInfo.reset();
  inboxDepth.reset();

  const counts = new Map<string, number>(ALL_STATUSES.map((s) => [s, 0]));
  let paused = 0;

  for (const agent of agents) {
    counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
    if (agent.status === 'paused') paused += 1;

    agentInfo.set(
      {
        agent: agent.id,
        host: agent.host,
        platform: agent.platform,
        role: agent.role,
        version: agent.version ?? 'unknown',
      },
      1,
    );
    agentUp.set({ agent: agent.id, host: agent.host }, agent.status === 'offline' ? 0 : 1);
    agentLastSeen.set({ agent: agent.id }, (Date.now() - agent.lastSeen) / 1000);

    // One series per status with a 0/1 value, so a Grafana state-timeline can
    // show transitions without string-valued metrics.
    for (const status of ALL_STATUSES) {
      agentStatus.set({ agent: agent.id, status }, agent.status === status ? 1 : 0);
    }

    try {
      inboxDepth.set({ agent: agent.id }, await redis.zcard(K.inbox(agent.id)));
    } catch {
      /* a missing inbox key simply means zero unread */
    }
  }

  for (const [status, count] of counts) agentsByStatus.set({ status }, count);
  agentsPaused.set(paused);

  const pending = await listPending();
  permissionsPending.set(pending.length);
  oldestPendingAge.set(
    pending.length === 0 ? 0 : (Date.now() - Math.min(...pending.map((p) => p.ts))) / 1000,
  );

  const kill = await redis.get(K.killSwitch);
  killSwitchEngaged.set(kill === null ? 0 : 1);

  const councils = await listCouncils();
  const phases = new Map<string, number>(ALL_PHASES.map((p) => [p, 0]));
  for (const council of councils) {
    phases.set(council.phase, (phases.get(council.phase) ?? 0) + 1);
  }
  for (const [phase, count] of phases) councilsByPhase.set({ phase }, count);

  wsConnections.reset();
  const byKind = { human: 0, agent: 0 };
  for (const conn of listConnections()) byKind[conn.kind] += 1;
  wsConnections.set({ kind: 'human' }, byKind.human);
  wsConnections.set({ kind: 'agent' }, byKind.agent);

  const elapsed = Date.now() - started;
  if (elapsed > 2_000) log.warn({ elapsedMs: elapsed }, 'slow metrics collection');
}
