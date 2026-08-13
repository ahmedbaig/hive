import { z } from 'zod';
import {
  AgentCommand,
  AgentRecord,
  Channel,
  Council,
  FileTransfer,
  HiveEvent,
  Message,
  PermissionRequest,
} from './protocol.js';

/**
 * WebSocket envelopes. One socket type serves both browsers and agent daemons;
 * the `hello` frame declares which. Everything is a discriminated union on
 * `t` so both ends can exhaustively switch without casting.
 */

/* ── Client/agent → server ───────────────────────────────────────────────── */

export const ClientHello = z.object({
  t: z.literal('hello'),
  as: z.enum(['human', 'agent']),
  /** Required when `as` is "agent"; the id returned by /api/agents/register. */
  agentId: z.string().nullable().default(null),
  name: z.string().default('operator'),
  token: z.string().nullable().default(null),
});

export const ClientSubscribe = z.object({
  t: z.literal('subscribe'),
  channels: z.array(z.string()),
});

export const ClientPing = z.object({ t: z.literal('ping') });

export const AgentStatusUpdate = z.object({
  t: z.literal('status'),
  status: AgentRecord.shape.status,
  activity: z.string().nullable().default(null),
});

export const InboundFrame = z.discriminatedUnion('t', [
  ClientHello,
  ClientSubscribe,
  ClientPing,
  AgentStatusUpdate,
]);
export type InboundFrame = z.infer<typeof InboundFrame>;

/* ── Server → client/agent ───────────────────────────────────────────────── */

export const ServerWelcome = z.object({
  t: z.literal('welcome'),
  connectionId: z.string(),
  serverTime: z.number().int(),
  /** Full snapshot so a fresh browser tab renders without extra round trips. */
  agents: z.array(AgentRecord),
  channels: z.array(Channel),
  pendingPermissions: z.array(PermissionRequest),
  killSwitch: z.string().nullable(),
});

export const ServerEvent = z.object({ t: z.literal('event'), event: HiveEvent });
export const ServerMessage = z.object({ t: z.literal('message'), message: Message });
export const ServerAgentUpsert = z.object({ t: z.literal('agent'), agent: AgentRecord });
export const ServerAgentRemove = z.object({ t: z.literal('agent.remove'), agentId: z.string() });
export const ServerChannel = z.object({ t: z.literal('channel'), channel: Channel });
export const ServerPermission = z.object({
  t: z.literal('permission'),
  request: PermissionRequest,
});
export const ServerCouncil = z.object({ t: z.literal('council'), council: Council });
export const ServerFile = z.object({ t: z.literal('file'), file: FileTransfer });
export const ServerKillSwitch = z.object({
  t: z.literal('killswitch'),
  reason: z.string().nullable(),
});
/** Directed at a single agent daemon, never broadcast to browsers. */
export const ServerCommand = z.object({ t: z.literal('command'), command: AgentCommand });
export const ServerPong = z.object({ t: z.literal('pong'), serverTime: z.number().int() });
export const ServerError = z.object({ t: z.literal('error'), message: z.string() });

export const OutboundFrame = z.discriminatedUnion('t', [
  ServerWelcome,
  ServerEvent,
  ServerMessage,
  ServerAgentUpsert,
  ServerAgentRemove,
  ServerChannel,
  ServerPermission,
  ServerCouncil,
  ServerFile,
  ServerKillSwitch,
  ServerCommand,
  ServerPong,
  ServerError,
]);
export type OutboundFrame = z.infer<typeof OutboundFrame>;

/** Convenience: the shape a browser needs to bootstrap its store. */
export type Snapshot = z.infer<typeof ServerWelcome>;
