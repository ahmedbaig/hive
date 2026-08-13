import { hostname, platform } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';

for (const candidate of ['.env', '../.env', '../../.env', '../../../.env', '../../../../.env']) {
  const p = path.resolve(process.cwd(), candidate);
  if (existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

export const HIVE_URL = (process.env.HIVE_URL || process.env.HIVE_PUBLIC_URL || 'http://127.0.0.1:7777').replace(
  /\/$/,
  '',
);
const TOKEN = process.env.HIVE_TOKEN || '';

/**
 * One agent per machine by default: the session key is the hostname, so the
 * MCP server and the agent daemon derive the same agent id without having to
 * coordinate. Override HIVE_SESSION_KEY to run several independent agents on
 * one box.
 */
export const SESSION_KEY = process.env.HIVE_SESSION_KEY || hostname();
export const AGENT_NAME = process.env.HIVE_AGENT_NAME || hostname();

export interface Identity {
  agentId: string;
  name: string;
}

let identity: Identity | null = null;

export async function hiveFetch<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (TOKEN) headers.set('authorization', `Bearer ${TOKEN}`);
  if (identity) {
    headers.set('x-hive-agent', identity.agentId);
    headers.set('x-hive-agent-name', identity.name);
  }

  const res = await fetch(`${HIVE_URL}${pathname}`, { ...init, headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`hive ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

export const hivePost = <T>(pathname: string, body?: unknown): Promise<T> =>
  hiveFetch<T>(pathname, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/**
 * Registration is idempotent and cheap, so the MCP server does it lazily on the
 * first tool call rather than at startup — a Claude session that never touches
 * a hive tool should not appear in the roster.
 */
export async function ensureIdentity(): Promise<Identity> {
  if (identity) return identity;

  const res = await hivePost<{ agent: { id: string; name: string } }>('/api/agents/register', {
    name: AGENT_NAME,
    host: hostname(),
    platform: platform(),
    pid: process.pid,
    cwd: process.cwd(),
    sessionKey: SESSION_KEY,
    sessionId: process.env.CLAUDE_SESSION_ID ?? null,
    model: process.env.CLAUDE_MODEL ?? null,
    role: (process.env.HIVE_AGENT_ROLE as 'worker' | 'observer' | 'coordinator') || 'worker',
    tags: (process.env.HIVE_AGENT_TAGS || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    wakeEnabled: process.env.HIVE_WAKE_ENABLED === '1',
    version: '0.1.0',
  });

  identity = { agentId: res.agent.id, name: res.agent.name };
  return identity;
}
