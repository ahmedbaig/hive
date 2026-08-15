import { z } from 'zod';

/* ── Agents ──────────────────────────────────────────────────────────────── */

export const AgentStatus = z.enum([
  'idle', // registered, no active turn
  'working', // mid-turn, tools running
  'waiting_approval', // blocked on a permission decision
  'paused', // human paused this machine
  'offline', // heartbeat expired
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentRole = z.enum([
  'worker', // does tasks
  'observer', // reads the bus, never acts
  'coordinator', // may issue commands to other agents
]);
export type AgentRole = z.infer<typeof AgentRole>;

/**
 * Last-value telemetry for one agent.
 *
 * Deliberately a snapshot, not a series: it answers "how full is this machine's
 * context right now", which has no useful history — the agent overwrites it on
 * every turn. Historical spend lives in `TokenEvent`, which is append-only and
 * written at a completely different rate. Sharing one table for both would mean
 * either rewriting history rows or keeping a series nobody graphs.
 */
export const AgentStats = z.object({
  /** Tokens occupying the model's context window at the end of the last turn. */
  contextUsed: z.number().int().nonnegative().default(0),
  /** Window size for the reporting model, so the UI can render a percentage. */
  contextMax: z.number().int().positive().default(200_000),
  model: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  /** Cumulative totals for the reporting session, not for the reset window. */
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  /** Turns this session has taken, for a tokens-per-turn read. */
  turns: z.number().int().nonnegative().default(0),
  updatedAt: z.number().int(),
});
export type AgentStats = z.infer<typeof AgentStats>;

/** What an agent posts after a turn. Deltas plus a fresh context snapshot. */
export const StatsReport = z.object({
  contextUsed: z.number().int().nonnegative().default(0),
  contextMax: z.number().int().positive().default(200_000),
  model: z.string().nullable().default(null),
  sessionId: z.string().nullable().default(null),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  turns: z.number().int().nonnegative().default(1),
  /** Session totals so far, used to replace rather than accumulate the record. */
  sessionTotals: z
    .object({
      inputTokens: z.number().int().nonnegative().default(0),
      outputTokens: z.number().int().nonnegative().default(0),
      cacheReadTokens: z.number().int().nonnegative().default(0),
      cacheWriteTokens: z.number().int().nonnegative().default(0),
      turns: z.number().int().nonnegative().default(0),
    })
    .nullable()
    .default(null),
});
export type StatsReport = z.infer<typeof StatsReport>;

/** One append-only spend row. Never updated, only inserted and aged out. */
export const TokenEvent = z.object({
  id: z.string(),
  ts: z.number().int(),
  agentId: z.string(),
  agentName: z.string(),
  sessionId: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  /** Model turns this report covers, which is not the same as one report. */
  turns: z.number().int().nonnegative().default(1),
});
export type TokenEvent = z.infer<typeof TokenEvent>;

/**
 * Spend inside the current rolling window.
 *
 * Computed server-side and shipped as absolute timestamps. A client that
 * computed `resetsAt` itself would be wrong by its own clock skew, and every
 * browser on the LAN would disagree about when the window turns over.
 *
 * `startedAt` is the first billable request inside the window, so `resetsAt` is
 * `startedAt + windowMs` — the same rolling shape Anthropic's own limits use.
 * The rate-limit *headers* are not available to us: Claude Code never exposes
 * HTTP response headers to hooks or MCP tools, and the hive server never talks
 * to the API itself, so there is nothing to read them from. This window is
 * derived from observed spend, which is honest but is not the billing window.
 */
export const UsageWindow = z.object({
  windowMs: z.number().int().positive(),
  startedAt: z.number().int().nullable().default(null),
  resetsAt: z.number().int().nullable().default(null),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
  turns: z.number().int().nonnegative().default(0),
});
export type UsageWindow = z.infer<typeof UsageWindow>;

/** Memory files this fleet has collected, aggregated for the stats view. */
export const MemoryStats = z.object({
  files: z.number().int().nonnegative().default(0),
  bytes: z.number().int().nonnegative().default(0),
  machines: z.number().int().nonnegative().default(0),
  lastSyncAt: z.number().int().nullable().default(null),
});
export type MemoryStats = z.infer<typeof MemoryStats>;

export const AgentUsage = z.object({
  agentId: z.string(),
  agentName: z.string(),
  status: z.string(),
  stats: AgentStats.nullable().default(null),
  window: UsageWindow,
  /** Coarse buckets over the window, oldest first, for a sparkline. */
  spark: z.array(z.number()).default([]),
});
export type AgentUsage = z.infer<typeof AgentUsage>;

export const FleetStats = z.object({
  serverTime: z.number().int(),
  window: UsageWindow,
  agents: z.array(AgentUsage).default([]),
  memory: MemoryStats,
  /** True when the series is backed by Postgres rather than the Redis cache. */
  durable: z.boolean().default(false),
});
export type FleetStats = z.infer<typeof FleetStats>;

export const AgentRecord = z.object({
  id: z.string(),
  name: z.string().min(1).max(64),
  host: z.string(),
  platform: z.string(),
  pid: z.number().int().nonnegative(),
  cwd: z.string(),
  sessionId: z.string().nullable(),
  model: z.string().nullable(),
  role: AgentRole.default('worker'),
  status: AgentStatus.default('idle'),
  /** Free-form tags the human sets: "gpu", "prod", "scratch". Used for routing. */
  tags: z.array(z.string()).default([]),
  /** Whether this machine's daemon will spawn headless runs on wake events. */
  wakeEnabled: z.boolean().default(false),
  version: z.string().nullable(),
  registeredAt: z.number().int(),
  lastSeen: z.number().int(),
  /** Short human-readable note of what it is doing right now. */
  activity: z.string().nullable().default(null),
  /** Latest context/token snapshot this machine reported. Null until it does. */
  stats: AgentStats.nullable().default(null),
});
export type AgentRecord = z.infer<typeof AgentRecord>;

export const AgentRegistration = AgentRecord.pick({
  name: true,
  host: true,
  platform: true,
  pid: true,
  cwd: true,
  sessionId: true,
  model: true,
  role: true,
  tags: true,
  wakeEnabled: true,
  version: true,
}).partial({
  sessionId: true,
  model: true,
  role: true,
  tags: true,
  wakeEnabled: true,
  version: true,
});
export type AgentRegistration = z.infer<typeof AgentRegistration>;

/* ── Telemetry events ────────────────────────────────────────────────────── */

export const EventType = z.enum([
  'session.start',
  'session.end',
  'prompt.submit',
  'tool.pre',
  'tool.post',
  'turn.stop',
  'notification',
  'agent.register',
  'agent.offline',
  'permission.request',
  'permission.decision',
  /** Token accounting lifted from a session transcript. */
  'usage',
  /** A memory or CLAUDE.md file was collected from this machine. */
  'memory.sync',
  /**
   * A daemon decided whether to answer a chat message. Emitted for suppressed
   * turns too — the loop guards are only trustworthy if you can see them fire.
   */
  'chat.reply',
  'error',
]);
export type EventType = z.infer<typeof EventType>;

export const HiveEvent = z.object({
  id: z.string(),
  ts: z.number().int(),
  agentId: z.string(),
  agentName: z.string(),
  type: EventType,
  /** Tool name for tool.* events, notification kind for notifications. */
  subject: z.string().nullable().default(null),
  /** Arbitrary structured detail. Truncated server-side before persistence. */
  detail: z.record(z.unknown()).default({}),
});
export type HiveEvent = z.infer<typeof HiveEvent>;

/* ── Channels and chat ───────────────────────────────────────────────────── */

export const ChannelKind = z.enum([
  'group', // many participants, the default
  'direct', // exactly two participants
  'council', // structured debate, backed by a Council record
  'system', // server announcements, read-only for agents
]);
export type ChannelKind = z.infer<typeof ChannelKind>;

export const Channel = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  kind: ChannelKind.default('group'),
  /**
   * The current focus. Mutable, changes as the work moves on.
   *
   * Kept separate from `description` on purpose: the two drift apart within a
   * day, and collapsing them means either the charter goes stale or the focus
   * gets overwritten every time someone edits the charter.
   */
  topic: z.string().default(''),
  /**
   * The channel's standing charter — what it is for, who belongs in it. Static.
   * Injected into every agent's prompt so a woken agent knows where it is
   * speaking; without it an agent answers blind and drifts off-topic.
   */
  description: z.string().default(''),
  /** Agent ids. The human operator is implicitly a member of every channel. */
  members: z.array(z.string()).default([]),
  createdAt: z.number().int(),
  createdBy: z.string(),
  /** Mirrors `archivedAt !== null`; both are always written together. */
  archived: z.boolean().default(false),
  archivedAt: z.number().int().nullable().default(null),
  /**
   * Soft delete only. An agent channel is often the sole record of why a
   * decision was made, so the row is hidden rather than dropped and can be
   * restored from the undo toast or the archive list.
   */
  deletedAt: z.number().int().nullable().default(null),
});
export type Channel = z.infer<typeof Channel>;

export const AuthorType = z.enum(['human', 'agent', 'system']);
export type AuthorType = z.infer<typeof AuthorType>;

export const Attachment = z.object({
  fileId: z.string(),
  filename: z.string(),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  sha256: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

export const Message = z.object({
  id: z.string(),
  channelId: z.string(),
  ts: z.number().int(),
  authorType: AuthorType,
  authorId: z.string(),
  authorName: z.string(),
  body: z.string(),
  /** Message id this replies to, for threading. */
  replyTo: z.string().nullable().default(null),
  /** Agent ids explicitly addressed. Drives inbox delivery and wake events. */
  mentions: z.array(z.string()).default([]),
  /**
   * Depth of the reply chain this message belongs to. A human or system post is
   * 0; an agent reply is its parent's depth plus one. Daemons stop answering at
   * a hop limit, which is what keeps two agents from talking forever. Computed
   * server-side and deliberately absent from MessageDraft: a daemon must not be
   * able to reset its own chain.
   */
  hopDepth: z.number().int().nonnegative().default(0),
  attachments: z.array(Attachment).default([]),
  /** Set when the message is a structured payload rather than prose. */
  kind: z.enum(['text', 'command', 'result', 'council_turn']).default('text'),
  meta: z.record(z.unknown()).default({}),
});
export type Message = z.infer<typeof Message>;

export const MessageDraft = Message.pick({
  channelId: true,
  body: true,
  replyTo: true,
  mentions: true,
  attachments: true,
  kind: true,
  meta: true,
}).partial({
  replyTo: true,
  mentions: true,
  attachments: true,
  kind: true,
  meta: true,
});
export type MessageDraft = z.infer<typeof MessageDraft>;

/* ── Permission gate ─────────────────────────────────────────────────────── */

export const PermissionDecision = z.enum(['allow', 'deny', 'ask']);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const PermissionStatus = z.enum([
  'pending',
  'allowed',
  'denied',
  'expired', // no decision before the hook timed out; fell back to local prompt
  'auto_allowed', // matched the auto-allow list, never queued
  'killed', // refused because the fleet kill switch was engaged
]);
export type PermissionStatus = z.infer<typeof PermissionStatus>;

export const PermissionRequest = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  ts: z.number().int(),
  toolName: z.string(),
  /** Raw tool input, truncated for display. */
  toolInput: z.record(z.unknown()).default({}),
  /** One-line rendering of the call, e.g. `rm -rf /srv/data`. */
  summary: z.string(),
  cwd: z.string(),
  status: PermissionStatus.default('pending'),
  decidedBy: z.string().nullable().default(null),
  decidedAt: z.number().int().nullable().default(null),
  reason: z.string().nullable().default(null),
  /** Wall-clock deadline after which the hook stops waiting. */
  expiresAt: z.number().int(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

/** What the server LPUSHes onto the reply list the hook is blocked on. */
export const PermissionReply = z.object({
  decision: PermissionDecision,
  reason: z.string().nullable().default(null),
  decidedBy: z.string(),
});
export type PermissionReply = z.infer<typeof PermissionReply>;

/* ── Commands to agents ──────────────────────────────────────────────────── */

export const CommandKind = z.enum([
  'wake', // start a headless run with the given prompt
  'stop', // interrupt the current run
  'pause', // deny all tool calls until resumed
  'resume',
  'shutdown', // daemon exits
  'ping',
]);
export type CommandKind = z.infer<typeof CommandKind>;

export const AgentCommand = z.object({
  id: z.string(),
  kind: CommandKind,
  ts: z.number().int(),
  issuedBy: z.string(),
  /** Prompt text for `wake`; reason string for `pause`/`stop`. */
  payload: z.string().default(''),
  /** Channel the resulting work should report back into. */
  replyChannelId: z.string().nullable().default(null),
});
export type AgentCommand = z.infer<typeof AgentCommand>;

/* ── Files ───────────────────────────────────────────────────────────────── */

export const FileTransfer = z.object({
  id: z.string(),
  filename: z.string(),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  uploadedBy: z.string(),
  uploadedByName: z.string(),
  uploadedAt: z.number().int(),
  channelId: z.string().nullable().default(null),
  /** Server-side storage path, never exposed to clients. */
  storedPath: z.string(),
  /**
   * Set when the bytes were already on disk under this hash. The metadata row
   * is still new — two agents sharing the same file get two ids and one blob.
   */
  deduped: z.boolean().default(false),
  /** True when the content is small text the server can serve inline as ranges. */
  inlineText: z.boolean().default(false),
  deletedAt: z.number().int().nullable().default(null),
});
export type FileTransfer = z.infer<typeof FileTransfer>;

/** A window of a shared file, so one large log cannot flood an agent's context. */
export const FileChunk = z.object({
  fileId: z.string(),
  filename: z.string(),
  /** Byte offset the slice starts at. */
  offset: z.number().int().nonnegative(),
  /** Bytes actually returned; may be shorter than requested at end of file. */
  length: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  eof: z.boolean(),
  /** Only set when the file decodes as text; binary is refused, not mangled. */
  text: z.string().nullable().default(null),
});
export type FileChunk = z.infer<typeof FileChunk>;

/* ── Council ─────────────────────────────────────────────────────────────── */

export const CouncilPhase = z.enum([
  'gathering', // waiting for participants to join
  'opening', // each participant states a position
  'debate', // rounds of rebuttal
  'voting',
  'closed',
]);
export type CouncilPhase = z.infer<typeof CouncilPhase>;

export const CouncilVote = z.object({
  agentId: z.string(),
  agentName: z.string(),
  /** Free-form option label the agent votes for. */
  option: z.string(),
  rationale: z.string().default(''),
  ts: z.number().int(),
});
export type CouncilVote = z.infer<typeof CouncilVote>;

export const Council = z.object({
  id: z.string(),
  channelId: z.string(),
  topic: z.string(),
  question: z.string(),
  /** Options put to the vote. Empty means free-form answers. */
  options: z.array(z.string()).default([]),
  phase: CouncilPhase.default('gathering'),
  participants: z.array(z.string()).default([]),
  /** Current debate round, 1-indexed. */
  round: z.number().int().default(0),
  maxRounds: z.number().int().default(3),
  votes: z.array(CouncilVote).default([]),
  verdict: z.string().nullable().default(null),
  createdBy: z.string(),
  createdAt: z.number().int(),
  closedAt: z.number().int().nullable().default(null),
});
export type Council = z.infer<typeof Council>;
