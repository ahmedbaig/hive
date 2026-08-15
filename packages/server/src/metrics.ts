/**
 * Prometheus instrumentation for the hive.
 *
 * The question this is built to answer is "what is each Claude doing, and how
 * busy is it" — so the design leans on a small number of well-labelled series
 * rather than a firehose:
 *
 *   - `agent` labels are bounded by machine count, safe to use everywhere.
 *   - `tool` labels are bounded by the Claude Code tool set, plus MCP tools.
 *   - channel labels use the channel *kind*, not its id: councils create a
 *     channel each, so labelling by id would grow without limit.
 *
 * Utilisation comes from `hive_agent_busy_seconds_total`, a counter advanced by
 * a sampler. Dividing its rate by wall-clock gives a 0..1 busy fraction that
 * behaves correctly across restarts and scrape gaps:
 *
 *     rate(hive_agent_busy_seconds_total[5m])
 */
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'hive-server' });

// Node runtime metrics: heap, event loop lag, GC, file descriptors.
collectDefaultMetrics({ register: registry, prefix: 'hive_' });

/* ── Fleet composition ───────────────────────────────────────────────────── */

export const agentInfo = new Gauge({
  name: 'hive_agent_info',
  help: 'Static metadata for a registered agent. Always 1; join on this for labels.',
  labelNames: ['agent', 'host', 'platform', 'role', 'version'] as const,
  registers: [registry],
});

export const agentUp = new Gauge({
  name: 'hive_agent_up',
  help: '1 when the agent heartbeat is fresh, 0 when it has expired.',
  labelNames: ['agent', 'host'] as const,
  registers: [registry],
});

export const agentStatus = new Gauge({
  name: 'hive_agent_status',
  help: '1 for the status the agent is currently in, 0 for the others.',
  labelNames: ['agent', 'status'] as const,
  registers: [registry],
});

export const agentLastSeen = new Gauge({
  name: 'hive_agent_last_seen_seconds',
  help: 'Seconds since this agent was last heard from.',
  labelNames: ['agent'] as const,
  registers: [registry],
});

export const agentsByStatus = new Gauge({
  name: 'hive_agents',
  help: 'Number of agents in each status.',
  labelNames: ['status'] as const,
  registers: [registry],
});

/**
 * Busy time. Advanced by the sampler below while an agent is working or blocked
 * on an approval, which is the fleet's core utilisation signal.
 */
export const agentBusySeconds = new Counter({
  name: 'hive_agent_busy_seconds_total',
  help: 'Cumulative seconds an agent spent in a non-idle state.',
  labelNames: ['agent', 'state'] as const,
  registers: [registry],
});

export const agentSessions = new Counter({
  name: 'hive_agent_sessions_total',
  help: 'Claude Code sessions started on this agent.',
  labelNames: ['agent'] as const,
  registers: [registry],
});

export const agentPrompts = new Counter({
  name: 'hive_agent_prompts_total',
  help: 'User prompts submitted on this agent.',
  labelNames: ['agent'] as const,
  registers: [registry],
});

export const agentTurns = new Counter({
  name: 'hive_agent_turns_total',
  help: 'Assistant turns completed on this agent.',
  labelNames: ['agent'] as const,
  registers: [registry],
});

export const turnDuration = new Histogram({
  name: 'hive_agent_turn_duration_seconds',
  help: 'Wall-clock time from prompt submission to turn end.',
  labelNames: ['agent'] as const,
  // Turns run from a couple of seconds to many minutes; bucket accordingly.
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
  registers: [registry],
});

/* ── Tool activity ───────────────────────────────────────────────────────── */

export const toolCalls = new Counter({
  name: 'hive_tool_calls_total',
  help: 'Tool invocations observed, by outcome reported in the PostToolUse hook.',
  labelNames: ['agent', 'tool', 'result'] as const,
  registers: [registry],
});

/**
 * Token accounting lifted from session transcripts. `kind` separates fresh
 * input, output, and the two cache paths — cache reads are billed differently
 * from fresh input, so summing them together would misstate cost.
 */
export const tokensUsed = new Counter({
  name: 'hive_tokens_total',
  help: 'Tokens consumed by Claude sessions, by agent, model and kind.',
  labelNames: ['agent', 'model', 'kind'] as const,
  registers: [registry],
});

export const memoryFiles = new Gauge({
  name: 'hive_memory_files',
  help: 'Memory and CLAUDE.md files collected from each machine.',
  labelNames: ['agent'] as const,
  registers: [registry],
});

export const eventsIngested = new Counter({
  name: 'hive_events_total',
  help: 'Telemetry events recorded, by type.',
  labelNames: ['agent', 'type'] as const,
  registers: [registry],
});

/* ── Permission gate ─────────────────────────────────────────────────────── */

export const permissionRequests = new Counter({
  name: 'hive_permission_requests_total',
  help: 'Tool calls that reached the permission gate, by final status.',
  labelNames: ['agent', 'tool', 'status'] as const,
  registers: [registry],
});

export const permissionWait = new Histogram({
  name: 'hive_permission_wait_seconds',
  help: 'Time a gated tool call waited before a decision or timeout.',
  labelNames: ['agent', 'tool', 'status'] as const,
  // The hook gives up at 45s by default, so resolution above that is noise.
  buckets: [0.05, 0.25, 1, 3, 10, 30, 45, 60, 120],
  registers: [registry],
});

export const permissionsPending = new Gauge({
  name: 'hive_permissions_pending',
  help: 'Tool calls currently blocked waiting for an operator decision.',
  registers: [registry],
});

export const oldestPendingAge = new Gauge({
  name: 'hive_permission_oldest_pending_seconds',
  help: 'Age of the longest-waiting pending permission request.',
  registers: [registry],
});

export const killSwitchEngaged = new Gauge({
  name: 'hive_killswitch_engaged',
  help: '1 when the fleet-wide kill switch is denying every tool call.',
  registers: [registry],
});

export const agentsPaused = new Gauge({
  name: 'hive_agents_paused',
  help: 'Number of agents individually paused by the operator.',
  registers: [registry],
});

/* ── Collaboration ───────────────────────────────────────────────────────── */

export const messagesPosted = new Counter({
  name: 'hive_messages_total',
  help: 'Chat messages posted. Labelled by channel kind to bound cardinality.',
  labelNames: ['channel_kind', 'author_type', 'kind'] as const,
  registers: [registry],
});

/**
 * Reply-chain depth of every message posted.
 *
 * The interesting shape is the tail: a healthy fleet posts mostly at depth 0
 * (humans) and 1 (a single agent answer). Mass at the hop limit means agents
 * are talking to each other until the guard cuts them off, which is a prompt
 * problem rather than a transport one.
 */
export const messageHopDepth = new Histogram({
  name: 'hive_message_hop_depth',
  help: 'Depth of the reply chain a posted message continued.',
  labelNames: ['author_type'] as const,
  buckets: [0, 1, 2, 3, 4, 5, 6, 8, 12],
  registers: [registry],
});

/**
 * Every reply decision a daemon made, answered or not.
 *
 * Suppressions are the half worth watching: `reason="hop_limit"` rising is the
 * loop guard doing its job, while `reason="peer_cooldown"` rising instead means
 * two agents are trying to talk faster than the fleet allows.
 */
export const chatReplyDecisions = new Counter({
  name: 'hive_chat_reply_decisions_total',
  help: 'Chat messages a daemon evaluated, by decision and reason.',
  labelNames: ['agent', 'decision', 'reason'] as const,
  registers: [registry],
});

export const chatReplyDuration = new Histogram({
  name: 'hive_chat_reply_duration_seconds',
  help: 'Wall-clock time a daemon spent producing a chat reply.',
  labelNames: ['agent', 'result'] as const,
  // Replies are uncapped by default and may run tool work for minutes.
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
  registers: [registry],
});

export const inboxDepth = new Gauge({
  name: 'hive_agent_inbox_depth',
  help: 'Unread messages queued for an agent.',
  labelNames: ['agent'] as const,
  registers: [registry],
});

export const filesUploaded = new Counter({
  name: 'hive_files_uploaded_total',
  help: 'Files shared into the hive.',
  registers: [registry],
});

export const fileBytes = new Counter({
  name: 'hive_file_bytes_total',
  help: 'Total bytes of shared files stored.',
  registers: [registry],
});

export const filesDeduped = new Counter({
  name: 'hive_files_deduped_total',
  help: 'Uploads whose bytes were already stored under the same sha256.',
  registers: [registry],
});

export const contextUsedRatio = new Gauge({
  name: 'hive_agent_context_ratio',
  help: 'Fraction of the context window an agent was holding at its last turn.',
  labelNames: ['agent'] as const,
  registers: [registry],
});

export const councilsByPhase = new Gauge({
  name: 'hive_councils',
  help: 'Councils in each phase.',
  labelNames: ['phase'] as const,
  registers: [registry],
});

export const councilVotes = new Counter({
  name: 'hive_council_votes_total',
  help: 'Votes cast in councils.',
  labelNames: ['agent'] as const,
  registers: [registry],
});

export const commandsIssued = new Counter({
  name: 'hive_commands_total',
  help: 'Commands sent to agent daemons.',
  labelNames: ['agent', 'kind', 'delivery'] as const,
  registers: [registry],
});

/* ── Transport and storage health ────────────────────────────────────────── */

export const wsConnections = new Gauge({
  name: 'hive_ws_connections',
  help: 'Open WebSocket connections, by client kind.',
  labelNames: ['kind'] as const,
  registers: [registry],
});

export const httpRequests = new Counter({
  name: 'hive_http_requests_total',
  help: 'HTTP requests served.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'hive_http_request_duration_seconds',
  help: 'HTTP request latency.',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.005, 0.02, 0.05, 0.1, 0.5, 1, 5, 30, 60],
  registers: [registry],
});

export const redisUp = new Gauge({
  name: 'hive_redis_up',
  help: '1 when Redis answered the last health probe.',
  registers: [registry],
});

export const redisLatency = new Gauge({
  name: 'hive_redis_ping_seconds',
  help: 'Round-trip time of the last Redis PING.',
  registers: [registry],
});

export const postgresUp = new Gauge({
  name: 'hive_postgres_up',
  help: '1 when durable persistence is enabled and reachable.',
  registers: [registry],
});

export const persistenceWrites = new Counter({
  name: 'hive_persistence_writes_total',
  help: 'Background writes to Postgres, by result.',
  labelNames: ['result'] as const,
  registers: [registry],
});

/* ── Busy-time sampler ───────────────────────────────────────────────────── */

const BUSY_STATES = new Set(['working', 'waiting_approval']);

/**
 * Advance per-agent busy counters on a fixed tick.
 *
 * Sampling rather than event-pairing is deliberate: an agent can crash mid-turn
 * without ever emitting a Stop event, and a paired-timestamp approach would
 * either lose that time or leak an open interval forever. A sampler is bounded
 * and self-correcting — worst case it is off by one tick.
 */
export function startBusySampler(
  listAgents: () => Promise<Array<{ id: string; status: string }>>,
  intervalMs = 5_000,
): NodeJS.Timeout {
  let last = Date.now();
  const timer = setInterval(() => {
    void (async () => {
      const now = Date.now();
      const elapsed = (now - last) / 1000;
      last = now;
      // A long pause (laptop sleep, debugger break) would otherwise credit
      // every busy agent with hours of work in a single tick.
      if (elapsed <= 0 || elapsed > intervalMs / 1000 + 30) return;

      const agents = await listAgents();
      for (const agent of agents) {
        if (BUSY_STATES.has(agent.status)) {
          agentBusySeconds.inc({ agent: agent.id, state: agent.status }, elapsed);
        }
      }
    })().catch(() => {
      /* sampling must never take the server down */
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

/**
 * Route label normaliser.
 *
 * Fastify hands us the parameterised path for any matched route, which is
 * already bounded. Everything else — 404s, and every deep link the SPA fallback
 * serves — collapses to a single bucket: using the raw URL there would let
 * anyone mint unlimited series just by requesting `/a1`, `/a2`, `/a3`.
 */
export function routeLabel(url: string, routerPath?: string): string {
  if (routerPath) {
    return routerPath.replace(/\/(agt|msg|chn|prm|fil|cnl|tsk|evt)_[A-Za-z0-9_:-]+/g, '/:id');
  }
  const path = (url.split('?')[0] ?? '/').toLowerCase();
  // Static assets are worth separating from app routes when reading latency.
  if (/\.(js|css|map|png|svg|ico|woff2?)$/.test(path)) return '<static>';
  return '<unmatched>';
}
