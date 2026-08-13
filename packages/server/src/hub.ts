import { randomUUID } from 'node:crypto';
import { K, type OutboundFrame } from '@hive/shared';
import type { WebSocket } from 'ws';
import { log } from './log.js';
import { redis, redisSub } from './redis.js';

export interface Connection {
  id: string;
  socket: WebSocket;
  kind: 'human' | 'agent';
  /** Set once the hello frame is validated. */
  agentId: string | null;
  name: string;
  /** Channel ids this connection wants message traffic for. Empty = all. */
  channels: Set<string>;
  aliveSince: number;
}

const connections = new Map<string, Connection>();

/** Marker so a frame that came back over pub/sub is not re-published. */
const ORIGIN = randomUUID();

export function addConnection(socket: WebSocket): Connection {
  const conn: Connection = {
    id: randomUUID(),
    socket,
    kind: 'human',
    agentId: null,
    name: 'anonymous',
    channels: new Set(),
    aliveSince: Date.now(),
  };
  connections.set(conn.id, conn);
  return conn;
}

export function removeConnection(id: string): Connection | undefined {
  const conn = connections.get(id);
  connections.delete(id);
  return conn;
}

export function listConnections(): Connection[] {
  return [...connections.values()];
}

/** True when at least one live socket belongs to this agent. */
export function isAgentConnected(agentId: string): boolean {
  for (const c of connections.values()) if (c.agentId === agentId) return true;
  return false;
}

export function sendTo(conn: Connection, frame: OutboundFrame): void {
  if (conn.socket.readyState !== conn.socket.OPEN) return;
  try {
    conn.socket.send(JSON.stringify(frame));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'socket send failed');
  }
}

function matches(conn: Connection, frame: OutboundFrame): boolean {
  // Commands are addressed to exactly one agent daemon; browsers never see them.
  if (frame.t === 'command') return false;
  // Message traffic honours the subscription set when one is declared.
  if (frame.t === 'message' && conn.channels.size > 0) {
    return conn.channels.has(frame.message.channelId);
  }
  return true;
}

/** Deliver to every matching local socket. Does not cross instances. */
function fanoutLocal(frame: OutboundFrame): void {
  for (const conn of connections.values()) {
    if (matches(conn, frame)) sendTo(conn, frame);
  }
}

/**
 * Broadcast to all clients on every server instance. Local sockets get it
 * immediately; the Redis publish covers any sibling process.
 */
export function broadcast(frame: OutboundFrame): void {
  fanoutLocal(frame);
  void redis.publish(K.pubsub, JSON.stringify({ origin: ORIGIN, frame }));
}

/** Deliver a frame to one agent's sockets only, wherever that agent is attached. */
export function sendToAgent(agentId: string, frame: OutboundFrame): boolean {
  let delivered = false;
  for (const conn of connections.values()) {
    if (conn.agentId === agentId) {
      sendTo(conn, frame);
      delivered = true;
    }
  }
  if (!delivered) {
    void redis.publish(K.pubsub, JSON.stringify({ origin: ORIGIN, frame, agentId }));
  }
  return delivered;
}

/**
 * Permission decisions travel over the same pub/sub channel as broadcast
 * frames. The permissions service registers here rather than importing the hub
 * back into itself, which would close an import cycle.
 */
type DecisionHandler = (permissionId: string, reply: unknown) => void;
let decisionHandler: DecisionHandler | null = null;
export function setDecisionHandler(fn: DecisionHandler): void {
  decisionHandler = fn;
}

export async function startPubSub(): Promise<void> {
  await redisSub.subscribe(K.pubsub);
  redisSub.on('message', (_channel, raw) => {
    try {
      const parsed = JSON.parse(raw) as {
        origin: string;
        frame: OutboundFrame;
        agentId?: string;
        permissionId?: string;
        reply?: unknown;
      };
      if (parsed.origin === 'decision' && parsed.permissionId) {
        decisionHandler?.(parsed.permissionId, parsed.reply);
        return;
      }
      if (parsed.origin === ORIGIN) return; // our own publish, already delivered
      if (parsed.agentId) {
        for (const conn of connections.values()) {
          if (conn.agentId === parsed.agentId) sendTo(conn, parsed.frame);
        }
        return;
      }
      fanoutLocal(parsed.frame);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'bad pubsub payload');
    }
  });
  log.info('pubsub fanout attached');
}
