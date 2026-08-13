import type { Channel, Council, FileTransfer, HiveEvent, Message, PermissionRequest } from '@hive/shared';

/**
 * The SPA is served from the hive server in production and proxied by Vite in
 * dev, so relative URLs are always correct — no base URL configuration.
 */
const OPERATOR_KEY = 'hive.operator';
const TOKEN_KEY = 'hive.token';

export function operatorName(): string {
  return localStorage.getItem(OPERATOR_KEY) || 'operator';
}
export function setOperatorName(name: string): void {
  localStorage.setItem(OPERATOR_KEY, name);
}
export function authToken(): string {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setAuthToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('x-hive-operator', operatorName());
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const token = authToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  health: () => request<{ ok: boolean; postgres: { configured: boolean } }>('/health'),

  channels: () => request<{ channels: Channel[] }>('/api/channels'),
  createChannel: (input: { name: string; topic?: string; kind?: Channel['kind'] }) =>
    post<{ channel: Channel }>('/api/channels', input),
  messages: (channelId: string, limit = 200) =>
    request<{ channel: Channel; messages: Message[] }>(
      `/api/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`,
    ),
  send: (channelId: string, body: string, mentions: string[] = [], attachments: Message['attachments'] = []) =>
    post<{ message: Message }>(`/api/channels/${encodeURIComponent(channelId)}/messages`, {
      body,
      mentions,
      attachments,
    }),

  events: (limit = 200) => request<{ events: HiveEvent[] }>(`/api/events?limit=${limit}`),

  pending: () => request<{ pending: PermissionRequest[] }>('/api/permissions/pending'),
  history: (limit = 100) =>
    request<{ permissions: PermissionRequest[] }>(`/api/permissions/history?limit=${limit}`),
  decide: (id: string, decision: 'allow' | 'deny', reason: string | null = null) =>
    post<{ request: PermissionRequest }>(`/api/permissions/${id}/decide`, { decision, reason }),

  control: () => request<{ killSwitch: string | null; autoAllow: string[] }>('/api/control'),
  killSwitch: (engaged: boolean, reason = 'stopped by operator') =>
    post<{ killSwitch: string | null }>('/api/control/killswitch', { engaged, reason }),
  pauseAgent: (agentId: string, paused: boolean, reason = 'paused by operator') =>
    post<{ ok: true }>(`/api/control/agents/${agentId}/pause`, { paused, reason }),
  command: (agentId: string, kind: string, payload = '', replyChannelId: string | null = null) =>
    post<unknown>(`/api/agents/${agentId}/commands`, { kind, payload, replyChannelId }),
  forgetAgent: (agentId: string) => request<{ ok: true }>(`/api/agents/${agentId}`, { method: 'DELETE' }),

  councils: () => request<{ councils: Council[] }>('/api/councils'),
  openCouncil: (input: {
    topic: string;
    question: string;
    options: string[];
    participants: string[];
    maxRounds: number;
  }) => post<{ council: Council }>('/api/councils', input),
  advanceCouncil: (id: string) => post<{ council: Council }>(`/api/councils/${id}/advance`),

  files: (channelId?: string) =>
    request<{ files: FileTransfer[] }>(`/api/files${channelId ? `?channelId=${channelId}` : ''}`),
  upload: async (file: File, channelId: string | null): Promise<FileTransfer> => {
    const form = new FormData();
    if (channelId) form.append('channelId', channelId);
    form.append('file', file);
    const headers = new Headers({ 'x-hive-operator': operatorName() });
    const token = authToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch('/api/files', { method: 'POST', body: form, headers });
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { file: FileTransfer };
    return json.file;
  },
};
