import { randomBytes } from 'node:crypto';

/**
 * Sortable, collision-resistant ids. Millisecond timestamp in base36 followed
 * by 8 random chars, so lexical sort matches creation order — handy when the
 * UI sorts messages client-side without a separate index.
 */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36).padStart(9, '0');
  const rand = randomBytes(5).toString('hex').slice(0, 8);
  return `${prefix}_${ts}${rand}`;
}

export const ID = {
  agent: () => newId('agt'),
  message: () => newId('msg'),
  channel: () => newId('chn'),
  permission: () => newId('prm'),
  file: () => newId('fil'),
  council: () => newId('cnl'),
  task: () => newId('tsk'),
  event: () => newId('evt'),
} as const;

/**
 * Stable id for a machine+session pair. Agents restart often (every new Claude
 * Code session is a new process), but we want the roster to show one row per
 * live session rather than an ever-growing pile of dead ones — the daemon
 * derives its id from host + session so a reconnect reclaims the same row.
 */
export function deriveAgentId(host: string, sessionKey: string): string {
  const safe = `${host}:${sessionKey}`.toLowerCase().replace(/[^a-z0-9:_-]/g, '-');
  return `agt_${safe}`;
}
