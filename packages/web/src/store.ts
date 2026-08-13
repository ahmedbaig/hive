import type {
  AgentRecord,
  Channel,
  Council,
  HiveEvent,
  Message,
  OutboundFrame,
  PermissionRequest,
} from '@hive/shared';
import { create } from 'zustand';
import { authToken, operatorName } from './api.js';

const MAX_EVENTS = 500;
const MAX_MESSAGES_PER_CHANNEL = 500;

export type ConnectionState = 'connecting' | 'open' | 'closed';

interface HiveState {
  connection: ConnectionState;
  agents: Record<string, AgentRecord>;
  channels: Record<string, Channel>;
  messages: Record<string, Message[]>;
  events: HiveEvent[];
  permissions: Record<string, PermissionRequest>;
  councils: Record<string, Council>;
  killSwitch: string | null;
  /** Channels whose history has been fetched, so we only backfill once. */
  loadedChannels: Set<string>;

  applyFrame: (frame: OutboundFrame) => void;
  setConnection: (state: ConnectionState) => void;
  ingestMessages: (channelId: string, messages: Message[]) => void;
  ingestEvents: (events: HiveEvent[]) => void;
  ingestPermissions: (permissions: PermissionRequest[]) => void;
  ingestCouncils: (councils: Council[]) => void;
}

export const useHive = create<HiveState>((set) => ({
  connection: 'connecting',
  agents: {},
  channels: {},
  messages: {},
  events: [],
  permissions: {},
  councils: {},
  killSwitch: null,
  loadedChannels: new Set(),

  setConnection: (connection) => set({ connection }),

  applyFrame: (frame) =>
    set((state) => {
      switch (frame.t) {
        case 'welcome':
          return {
            agents: Object.fromEntries(frame.agents.map((a) => [a.id, a])),
            channels: Object.fromEntries(frame.channels.map((c) => [c.id, c])),
            permissions: Object.fromEntries(frame.pendingPermissions.map((p) => [p.id, p])),
            killSwitch: frame.killSwitch,
          };

        case 'agent':
          return { agents: { ...state.agents, [frame.agent.id]: frame.agent } };

        case 'agent.remove': {
          const agents = { ...state.agents };
          delete agents[frame.agentId];
          return { agents };
        }

        case 'channel':
          return { channels: { ...state.channels, [frame.channel.id]: frame.channel } };

        case 'message': {
          const list = state.messages[frame.message.channelId] ?? [];
          // The socket can deliver a message we already have from the REST
          // backfill; dedupe rather than rendering it twice.
          if (list.some((m) => m.id === frame.message.id)) return {};
          const next = [...list, frame.message].slice(-MAX_MESSAGES_PER_CHANNEL);
          return { messages: { ...state.messages, [frame.message.channelId]: next } };
        }

        case 'event':
          return { events: [frame.event, ...state.events].slice(0, MAX_EVENTS) };

        case 'permission': {
          const permissions = { ...state.permissions, [frame.request.id]: frame.request };
          return { permissions };
        }

        case 'council':
          return { councils: { ...state.councils, [frame.council.id]: frame.council } };

        case 'killswitch':
          return { killSwitch: frame.reason };

        default:
          return {};
      }
    }),

  ingestMessages: (channelId, messages) =>
    set((state) => {
      const existing = state.messages[channelId] ?? [];
      const byId = new Map(existing.map((m) => [m.id, m]));
      for (const message of messages) byId.set(message.id, message);
      const merged = [...byId.values()]
        .sort((a, b) => a.ts - b.ts)
        .slice(-MAX_MESSAGES_PER_CHANNEL);
      const loadedChannels = new Set(state.loadedChannels);
      loadedChannels.add(channelId);
      return { messages: { ...state.messages, [channelId]: merged }, loadedChannels };
    }),

  ingestEvents: (events) =>
    set((state) => {
      const byId = new Map(state.events.map((e) => [e.id, e]));
      for (const event of events) byId.set(event.id, event);
      return {
        events: [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, MAX_EVENTS),
      };
    }),

  ingestPermissions: (permissions) =>
    set((state) => ({
      permissions: {
        ...state.permissions,
        ...Object.fromEntries(permissions.map((p) => [p.id, p])),
      },
    })),

  ingestCouncils: (councils) =>
    set((state) => ({
      councils: { ...state.councils, ...Object.fromEntries(councils.map((c) => [c.id, c])) },
    })),
}));

/**
 * Single long-lived socket with exponential backoff. Reconnecting re-issues the
 * hello frame, and the server answers with a full snapshot, so a dropped
 * connection self-heals without the UI reloading.
 */
export function connectSocket(): () => void {
  let socket: WebSocket | null = null;
  let attempt = 0;
  let closedByCaller = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const open = (): void => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws`);
    useHive.getState().setConnection('connecting');

    socket.onopen = () => {
      attempt = 0;
      useHive.getState().setConnection('open');
      socket?.send(
        JSON.stringify({
          t: 'hello',
          as: 'human',
          agentId: null,
          name: operatorName(),
          token: authToken() || null,
        }),
      );
      heartbeat = setInterval(() => socket?.send(JSON.stringify({ t: 'ping' })), 25_000);
    };

    socket.onmessage = (evt) => {
      try {
        useHive.getState().applyFrame(JSON.parse(evt.data as string) as OutboundFrame);
      } catch {
        // A frame we cannot parse is dropped rather than tearing down the feed.
      }
    };

    socket.onclose = () => {
      if (heartbeat) clearInterval(heartbeat);
      useHive.getState().setConnection('closed');
      if (closedByCaller) return;
      attempt += 1;
      const delay = Math.min(1_000 * 2 ** Math.min(attempt, 5), 15_000);
      retryTimer = setTimeout(open, delay);
    };

    socket.onerror = () => socket?.close();
  };

  open();

  return () => {
    closedByCaller = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (heartbeat) clearInterval(heartbeat);
    socket?.close();
  };
}
