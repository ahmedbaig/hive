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
  topic: z.string().default(''),
  /** Agent ids. The human operator is implicitly a member of every channel. */
  members: z.array(z.string()).default([]),
  createdAt: z.number().int(),
  createdBy: z.string(),
  archived: z.boolean().default(false),
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
});
export type FileTransfer = z.infer<typeof FileTransfer>;

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
