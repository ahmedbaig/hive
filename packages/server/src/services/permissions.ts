import { EventEmitter } from 'node:events';
import {
  ID,
  K,
  PermissionReply,
  PermissionRequest,
  type PermissionDecision,
} from '@hive/shared';
import type { AgentStatus } from '@hive/shared';
import { config } from '../config.js';
import { queueWrite, query } from '../db.js';
import { broadcast } from '../hub.js';
import { log } from '../log.js';
import { killSwitchEngaged, permissionRequests, permissionWait } from '../metrics.js';
import { redis } from '../redis.js';
import { getAgent, updateAgent } from './agents.js';
import { recordEvent } from './events.js';

/**
 * Local wake-up channel for hooks parked on this process. A decision made on
 * another server instance arrives over Redis pub/sub and is re-emitted here, so
 * a waiter never depends on which instance took the click.
 */
const decisions = new EventEmitter();
decisions.setMaxListeners(0);

export function resolveLocalWaiter(permissionId: string, reply: PermissionReply): void {
  decisions.emit(permissionId, reply);
}

/** Render a tool call as one line an operator can judge at a glance. */
export function summarise(toolName: string, input: Record<string, unknown>): string {
  const str = (key: string): string | null =>
    typeof input[key] === 'string' ? (input[key] as string) : null;

  switch (toolName) {
    case 'Bash':
      return str('command') ?? 'bash';
    case 'Write':
      return `write ${str('file_path') ?? '?'}`;
    case 'Edit':
      return `edit ${str('file_path') ?? '?'}`;
    case 'Read':
      return `read ${str('file_path') ?? '?'}`;
    case 'WebFetch':
      return `fetch ${str('url') ?? '?'}`;
    case 'WebSearch':
      return `search ${str('query') ?? '?'}`;
    default: {
      const json = JSON.stringify(input);
      return `${toolName} ${json.length > 160 ? `${json.slice(0, 160)}…` : json}`;
    }
  }
}

export interface PermissionOutcome {
  request: PermissionRequest;
  decision: PermissionDecision;
  reason: string | null;
}

/**
 * Create a request and block until an operator decides or the deadline passes.
 *
 * The caller is a PreToolUse hook holding up a real tool call, so the deadline
 * matters: on timeout we answer `ask`, which makes Claude Code fall back to its
 * own terminal prompt rather than silently allowing or denying.
 */
export async function requestPermission(input: {
  agentId: string;
  agentName: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  cwd: string;
  timeoutMs?: number;
}): Promise<PermissionOutcome> {
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? config.permissionTimeoutMs);
  const now = Date.now();

  const base = {
    id: ID.permission(),
    agentId: input.agentId,
    agentName: input.agentName,
    ts: now,
    toolName: input.toolName,
    toolInput: input.toolInput,
    summary: summarise(input.toolName, input.toolInput),
    cwd: input.cwd,
    decidedBy: null,
    decidedAt: null,
    reason: null,
    expiresAt: now + timeoutMs,
  };

  // Kill switch wins over everything, including the auto-allow list.
  const kill = await redis.get(K.killSwitch);
  if (kill !== null) {
    const request = PermissionRequest.parse({ ...base, status: 'killed', reason: kill });
    await persist(request);
    return { request, decision: 'deny', reason: `fleet kill switch engaged: ${kill}` };
  }

  const paused = await redis.get(K.agentPause(input.agentId));
  if (paused !== null) {
    const request = PermissionRequest.parse({ ...base, status: 'killed', reason: paused });
    await persist(request);
    return { request, decision: 'deny', reason: `agent paused: ${paused}` };
  }

  if (config.autoAllow.includes(input.toolName)) {
    const request = PermissionRequest.parse({ ...base, status: 'auto_allowed' });
    await persist(request);
    return { request, decision: 'allow', reason: 'auto-allowed by policy' };
  }

  const request = PermissionRequest.parse({ ...base, status: 'pending' });
  await redis.hset(K.permissions, request.id, JSON.stringify(request));
  await redis.xadd(
    K.permStream,
    'MAXLEN',
    '~',
    config.streamMaxLen,
    '*',
    'payload',
    JSON.stringify(request),
  );
  broadcast({ t: 'permission', request });

  // Remember what the agent was doing so the block can be undone exactly.
  // Hardcoding a status on the way out would strand an idle agent in "working"
  // forever, which silently inflates every utilisation metric.
  const before = await getAgent(input.agentId);
  const priorStatus: AgentStatus = before?.status === 'paused' ? 'paused' : (before?.status ?? 'idle');
  const priorActivity = before?.activity ?? null;
  await updateAgent(input.agentId, { status: 'waiting_approval', activity: request.summary });
  await recordEvent({
    agentId: request.agentId,
    agentName: request.agentName,
    type: 'permission.request',
    subject: request.toolName,
    detail: { summary: request.summary, permissionId: request.id },
  });

  const reply = await waitForDecision(request.id, timeoutMs);

  if (!reply) {
    const expired = await markStatus(request.id, 'expired', null, 'no decision before timeout');
    await updateAgent(input.agentId, { status: priorStatus, activity: priorActivity });
    log.warn({ permissionId: request.id, tool: request.toolName }, 'permission timed out');
    // `ask` hands control back to the local terminal instead of guessing.
    return { request: expired ?? request, decision: 'ask', reason: 'hive timeout' };
  }

  const finalStatus = reply.decision === 'allow' ? 'allowed' : 'denied';
  const decided = await markStatus(request.id, finalStatus, reply.decidedBy, reply.reason);
  // An allowed call means the agent is about to execute it, so it is working;
  // a denial returns it to whatever it was doing before.
  await updateAgent(input.agentId, {
    status: reply.decision === 'allow' && priorStatus !== 'paused' ? 'working' : priorStatus,
    activity: reply.decision === 'allow' ? request.summary : priorActivity,
  });
  return {
    request: decided ?? request,
    decision: reply.decision,
    reason: reply.reason,
  };
}

function waitForDecision(id: string, timeoutMs: number): Promise<PermissionReply | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      decisions.off(id, onDecision);
      resolve(null);
    }, timeoutMs);

    function onDecision(reply: PermissionReply): void {
      clearTimeout(timer);
      decisions.off(id, onDecision);
      resolve(reply);
    }

    decisions.once(id, onDecision);
  });
}

/** Called by the REST route when an operator (or coordinator agent) decides. */
export async function decidePermission(
  permissionId: string,
  decision: PermissionDecision,
  decidedBy: string,
  reason: string | null,
): Promise<PermissionRequest | null> {
  const raw = await redis.hget(K.permissions, permissionId);
  if (!raw) return null;
  const parsed = PermissionRequest.safeParse(JSON.parse(raw));
  if (!parsed.success) return null;
  if (parsed.data.status !== 'pending') return parsed.data;

  const reply = PermissionReply.parse({ decision, reason, decidedBy });

  // Local waiters first, then Redis so other instances and any BLPOP-style
  // client (the MCP server uses one) see the same decision.
  resolveLocalWaiter(permissionId, reply);
  await redis.lpush(K.permReply(permissionId), JSON.stringify(reply));
  await redis.expire(K.permReply(permissionId), 120);
  await redis.publish(
    K.pubsub,
    JSON.stringify({ origin: 'decision', permissionId, reply }),
  );

  const status = decision === 'allow' ? 'allowed' : 'denied';
  const updated = await markStatus(permissionId, status, decidedBy, reason);

  await recordEvent({
    agentId: parsed.data.agentId,
    agentName: parsed.data.agentName,
    type: 'permission.decision',
    subject: parsed.data.toolName,
    detail: { decision, decidedBy, reason, permissionId },
  });

  return updated;
}

export async function listPending(): Promise<PermissionRequest[]> {
  const all = await redis.hgetall(K.permissions);
  const out: PermissionRequest[] = [];
  for (const raw of Object.values(all)) {
    const parsed = PermissionRequest.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.status === 'pending') out.push(parsed.data);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export async function listPermissionHistory(limit = 200): Promise<PermissionRequest[]> {
  const rows = await query<{ payload: PermissionRequest }>(
    `select payload from permissions order by ts desc limit $1`,
    [Math.min(limit, 1_000)],
  );
  if (rows.length > 0) {
    return rows
      .map((r) => PermissionRequest.safeParse(r.payload))
      .filter((r) => r.success)
      .map((r) => r.data);
  }
  const entries = await redis.xrevrange(K.permStream, '+', '-', 'COUNT', Math.min(limit, 1_000));
  const out: PermissionRequest[] = [];
  for (const [, fields] of entries) {
    const idx = fields.indexOf('payload');
    const raw = idx >= 0 ? fields[idx + 1] : undefined;
    if (!raw) continue;
    const parsed = PermissionRequest.safeParse(JSON.parse(raw));
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

async function markStatus(
  permissionId: string,
  status: PermissionRequest['status'],
  decidedBy: string | null,
  reason: string | null,
): Promise<PermissionRequest | null> {
  const raw = await redis.hget(K.permissions, permissionId);
  if (!raw) return null;
  const parsed = PermissionRequest.safeParse(JSON.parse(raw));
  if (!parsed.success) return null;

  // Both the deciding route and the waiting request path call this, so the same
  // transition arrives twice. Settle it once: a second pass would double-count
  // the metrics and re-broadcast a resolved card.
  if (parsed.data.status === status) return parsed.data;

  const updated: PermissionRequest = {
    ...parsed.data,
    status,
    decidedBy,
    decidedAt: Date.now(),
    reason,
  };
  await persist(updated);
  if (ACTIONABLE.has(updated.status)) broadcast({ t: 'permission', request: updated });
  return updated;
}

/**
 * Statuses the operator's approval queue cares about. `auto_allowed` is
 * deliberately excluded: those calls never needed a human, and broadcasting
 * them buries the handful of requests that do need action under a stream of
 * routine reads. They remain in the metrics and the Postgres audit trail, and
 * they still show up in the live event feed as ordinary activity.
 */
const ACTIONABLE: ReadonlySet<PermissionRequest['status']> = new Set([
  'pending',
  'allowed',
  'denied',
  'expired',
  'killed',
]);

async function persist(request: PermissionRequest): Promise<void> {
  // Only queue-relevant requests occupy the hot hash the dashboard reads from.
  if (ACTIONABLE.has(request.status)) {
    await redis.hset(K.permissions, request.id, JSON.stringify(request));
  }

  if (request.status !== 'pending') {
    const labels = { agent: request.agentId, tool: request.toolName, status: request.status };
    permissionRequests.inc(labels);
    permissionWait.observe(labels, Math.max(0, ((request.decidedAt ?? Date.now()) - request.ts) / 1000));
  }
  // Resolved requests linger briefly so a late-joining browser still renders
  // the outcome, then drop out of the hot hash. The stream and Postgres keep
  // the durable record.
  if (request.status !== 'pending') {
    setTimeout(() => {
      redis.hdel(K.permissions, request.id).catch(() => {});
    }, 300_000).unref();
  }
  queueWrite(
    `insert into permissions (id, ts, agent_id, tool_name, status, payload)
     values ($1, to_timestamp($2/1000.0), $3, $4, $5, $6)
     on conflict (id) do update set status = excluded.status, payload = excluded.payload`,
    [request.id, request.ts, request.agentId, request.toolName, request.status, request],
  );
}

/* ── Fleet control ───────────────────────────────────────────────────────── */

export async function setKillSwitch(reason: string | null): Promise<void> {
  if (reason === null) {
    await redis.del(K.killSwitch);
  } else {
    await redis.set(K.killSwitch, reason);
  }
  killSwitchEngaged.set(reason === null ? 0 : 1);
  broadcast({ t: 'killswitch', reason });
  log.warn({ reason }, reason === null ? 'kill switch cleared' : 'kill switch engaged');
}

export async function getKillSwitch(): Promise<string | null> {
  return redis.get(K.killSwitch);
}

export async function setAgentPause(agentId: string, reason: string | null): Promise<void> {
  if (reason === null) {
    await redis.del(K.agentPause(agentId));
    await updateAgent(agentId, { status: 'idle' });
  } else {
    await redis.set(K.agentPause(agentId), reason);
    await updateAgent(agentId, { status: 'paused', activity: reason });
  }
}
