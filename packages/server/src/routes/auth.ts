import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';

/**
 * Bearer auth is opt-in. With HIVE_TOKEN empty the server runs in open LAN
 * mode: any host on the private network can register an agent and approve tool
 * calls. Setting the variable turns this into a hard gate without touching any
 * call site — every route and the WebSocket upgrade run through here.
 */
export function checkToken(headerValue: string | undefined | null): boolean {
  if (!config.token) return true;
  if (!headerValue) return false;
  const provided = headerValue.startsWith('Bearer ') ? headerValue.slice(7) : headerValue;
  return timingSafeEqual(provided, config.token);
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (checkToken(req.headers.authorization)) return;
  await reply.code(401).send({ error: 'unauthorized' });
}

/** Constant-time compare so a token cannot be recovered byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Who is acting. Agents identify with `x-hive-agent`; anything else is the
 * human operator. In open mode this is an honour-system label used for the
 * audit trail, not a security boundary.
 */
export function actorFrom(req: FastifyRequest): { id: string; name: string; isAgent: boolean } {
  const agentId = req.headers['x-hive-agent'];
  if (typeof agentId === 'string' && agentId.length > 0) {
    const name = req.headers['x-hive-agent-name'];
    return { id: agentId, name: typeof name === 'string' ? name : agentId, isAgent: true };
  }
  const operator = req.headers['x-hive-operator'];
  return {
    id: 'operator',
    name: typeof operator === 'string' && operator ? operator : 'operator',
    isAgent: false,
  };
}
