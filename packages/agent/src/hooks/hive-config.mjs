/**
 * Shared configuration for the hook scripts.
 *
 * Hooks are launched by Claude Code, not by a shell the user controls, so they
 * cannot rely on exported environment variables being present. The installer
 * writes ~/.hive/config.json and every hook reads it, with real environment
 * variables still winning so a one-off override works.
 */
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

let file = {};
try {
  file = JSON.parse(
    readFileSync(path.join(process.env.HOME || '.', '.hive', 'config.json'), 'utf8'),
  );
} catch {
  // No config file: fall back to environment and defaults.
}

const pick = (envKey, fileKey, fallback) =>
  process.env[envKey] ?? file[fileKey] ?? fallback;

export const HIVE_URL = String(pick('HIVE_URL', 'hiveUrl', 'http://127.0.0.1:7777')).replace(
  /\/$/,
  '',
);
export const TOKEN = String(pick('HIVE_TOKEN', 'token', ''));
export const SESSION_KEY = String(pick('HIVE_SESSION_KEY', 'sessionKey', hostname()));
export const AGENT_NAME = String(pick('HIVE_AGENT_NAME', 'agentName', hostname()));

/** Agent id derivation, identical to the server's so ids line up exactly. */
export function agentId() {
  const safe = `${hostname()}:${SESSION_KEY}`.toLowerCase().replace(/[^a-z0-9:_-]/g, '-');
  return `agt_${safe}`;
}

export function hiveHeaders() {
  const out = { 'content-type': 'application/json' };
  if (TOKEN) out.authorization = `Bearer ${TOKEN}`;
  out['x-hive-agent'] = agentId();
  out['x-hive-agent-name'] = AGENT_NAME;
  return out;
}

export function setting(envKey, fileKey, fallback) {
  return pick(envKey, fileKey, fallback);
}
