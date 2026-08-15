import type {
  AgentRecord,
  Channel,
  Council,
  FileTransfer,
  FleetStats,
  HiveEvent,
  Message,
  OutboundFrame,
  PermissionRequest,
} from '@hive/shared';
import { create } from 'zustand';
import { authToken, operatorName } from './api.js';
import { notifyMessage } from './notify.js';
import { play } from './sound.js';

const MAX_EVENTS = 500;
const MAX_MESSAGES_PER_CHANNEL = 500;
const MAX_TOASTS = 4;

export type ConnectionState = 'connecting' | 'open' | 'closed';
export type View = 'chat' | 'feed' | 'council' | 'files' | 'stats';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'danger';
  text: string;
  /** Optional single action, used for undo. Dismisses the toast when run. */
  action?: { label: string; run: () => void };
  /** Milliseconds before it fades on its own. */
  ttl: number;
}

export interface Prefs {
  sound: boolean;
  notifications: boolean;
  /** Suppresses sound and notifications wholesale without losing per-channel state. */
  doNotDisturb: boolean;
  /**
   * Channel ids muted individually. Five agents talking at once means a global
   * mute gets flipped on day one and never flipped back, so muting has to be
   * available at the granularity the noise actually arrives at.
   */
  mutedChannels: string[];
  /** Collapse the archived section in the sidebar. */
  showArchived: boolean;
}

const DEFAULT_PREFS: Prefs = {
  sound: true,
  notifications: false,
  doNotDisturb: false,
  mutedChannels: [],
  showArchived: false,
};

/* ── Persistence ─────────────────────────────────────────────────────────── */

const PERSIST_KEY = 'hive.ui.v1';

interface Persisted {
  drafts: Record<string, string>;
  prefs: Prefs;
  unread: Record<string, number>;
  lastChannelId: string;
  view: View;
}

function loadPersisted(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      ...parsed,
      prefs: { ...DEFAULT_PREFS, ...(parsed.prefs ?? {}) },
    };
  } catch {
    // A corrupt blob must not stop the app booting; defaults are fine.
    return {};
  }
}

const saved = loadPersisted();

/**
 * Writes are debounced because drafts change on every keystroke and
 * localStorage is synchronous — writing per character janks the composer on a
 * phone long before it costs anything on a desktop.
 */
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(state: HiveState): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      const payload: Persisted = {
        drafts: state.drafts,
        prefs: state.prefs,
        unread: state.unread,
        lastChannelId: state.channelId,
        view: state.view,
      };
      localStorage.setItem(PERSIST_KEY, JSON.stringify(payload));
    } catch {
      /* private-mode quota failures are not worth surfacing */
    }
  }, 400);
}

/* ── Store ───────────────────────────────────────────────────────────────── */

interface HiveState {
  connection: ConnectionState;
  agents: Record<string, AgentRecord>;
  channels: Record<string, Channel>;
  messages: Record<string, Message[]>;
  events: HiveEvent[];
  permissions: Record<string, PermissionRequest>;
  councils: Record<string, Council>;
  killSwitch: string | null;
  stats: FleetStats | null;
  /** Channels whose history has been fetched, so we only backfill once. */
  loadedChannels: Set<string>;

  /* UI state. Lives here rather than in a component so switching channels,
     opening the drawer or reloading the tab cannot destroy it. */
  view: View;
  channelId: string;
  drawerOpen: boolean;
  railOpen: boolean;
  selectedAgent: string | null;
  /**
   * Composer text per channel.
   *
   * The whole reason this is in the store: it used to be `useState` inside
   * `<Chat>`, and `<Chat key={channelId}>` remounted that component on every
   * channel switch — so a half-written message was destroyed by clicking away
   * to check something, which is exactly when you click away.
   */
  drafts: Record<string, string>;
  /** Scroll position per channel, so returning to a channel returns to your place. */
  scrollTops: Record<string, number>;
  unread: Record<string, number>;
  prefs: Prefs;
  toasts: Toast[];

  applyFrame: (frame: OutboundFrame) => void;
  setConnection: (state: ConnectionState) => void;
  ingestMessages: (channelId: string, messages: Message[]) => void;
  ingestEvents: (events: HiveEvent[]) => void;
  ingestPermissions: (permissions: PermissionRequest[]) => void;
  ingestCouncils: (councils: Council[]) => void;
  ingestChannels: (channels: Channel[]) => void;
  setStats: (stats: FleetStats) => void;

  setView: (view: View) => void;
  openChannel: (channelId: string) => void;
  setDrawer: (open: boolean) => void;
  setRail: (open: boolean) => void;
  selectAgent: (agentId: string | null) => void;
  setDraft: (channelId: string, draft: string) => void;
  setScrollTop: (channelId: string, top: number) => void;
  setPrefs: (patch: Partial<Prefs>) => void;
  toggleMute: (channelId: string) => void;
  toast: (toast: Omit<Toast, 'id' | 'ttl'> & { ttl?: number }) => number;
  dismissToast: (id: number) => void;
}

let toastSeq = 0;

export const useHive = create<HiveState>((set, get) => ({
  connection: 'connecting',
  agents: {},
  channels: {},
  messages: {},
  events: [],
  permissions: {},
  councils: {},
  killSwitch: null,
  stats: null,
  loadedChannels: new Set(),

  view: saved.view ?? 'chat',
  channelId: saved.lastChannelId ?? 'chn_lobby',
  drawerOpen: false,
  railOpen: false,
  selectedAgent: null,
  drafts: saved.drafts ?? {},
  scrollTops: {},
  unread: saved.unread ?? {},
  prefs: saved.prefs ?? DEFAULT_PREFS,
  toasts: [],

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

        case 'channel.remove': {
          const channels = { ...state.channels };
          delete channels[frame.channelId];
          // Leaving the deleted channel selected would render an empty pane
          // with no way back, so fall back to the lobby.
          const channelId =
            state.channelId === frame.channelId ? 'chn_lobby' : state.channelId;
          return { channels, channelId };
        }

        case 'message': {
          const list = state.messages[frame.message.channelId] ?? [];
          // The socket can deliver a message we already have from the REST
          // backfill; dedupe rather than rendering it twice.
          if (list.some((m) => m.id === frame.message.id)) return {};
          const next = [...list, frame.message].slice(-MAX_MESSAGES_PER_CHANNEL);

          const isActive =
            state.view === 'chat' &&
            state.channelId === frame.message.channelId &&
            document.visibilityState === 'visible';
          const unread = isActive
            ? state.unread
            : {
                ...state.unread,
                [frame.message.channelId]: (state.unread[frame.message.channelId] ?? 0) + 1,
              };

          return { messages: { ...state.messages, [frame.message.channelId]: next }, unread };
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

  ingestChannels: (channels) =>
    set((state) => ({
      channels: { ...state.channels, ...Object.fromEntries(channels.map((c) => [c.id, c])) },
    })),

  setStats: (stats) => set({ stats }),

  setView: (view) => {
    set({ view, drawerOpen: false });
    schedulePersist(get());
  },

  openChannel: (channelId) => {
    set((state) => ({
      channelId,
      view: 'chat',
      drawerOpen: false,
      unread: { ...state.unread, [channelId]: 0 },
    }));
    schedulePersist(get());
  },

  setDrawer: (drawerOpen) => set({ drawerOpen }),
  setRail: (railOpen) => set({ railOpen }),
  selectAgent: (selectedAgent) => set({ selectedAgent }),

  setDraft: (channelId, draft) => {
    set((state) => {
      const drafts = { ...state.drafts };
      // An empty draft is deleted rather than stored, so the persisted blob
      // does not accumulate one key per channel ever visited.
      if (draft) drafts[channelId] = draft;
      else delete drafts[channelId];
      return { drafts };
    });
    schedulePersist(get());
  },

  setScrollTop: (channelId, top) =>
    set((state) => ({ scrollTops: { ...state.scrollTops, [channelId]: top } })),

  setPrefs: (patch) => {
    set((state) => ({ prefs: { ...state.prefs, ...patch } }));
    schedulePersist(get());
  },

  toggleMute: (channelId) => {
    set((state) => {
      const muted = new Set(state.prefs.mutedChannels);
      if (muted.has(channelId)) muted.delete(channelId);
      else muted.add(channelId);
      return { prefs: { ...state.prefs, mutedChannels: [...muted] } };
    });
    schedulePersist(get());
  },

  toast: ({ ttl = 6_000, ...rest }) => {
    const id = (toastSeq += 1);
    set((state) => ({ toasts: [...state.toasts, { ...rest, id, ttl }].slice(-MAX_TOASTS) }));
    setTimeout(() => get().dismissToast(id), ttl);
    return id;
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/* ── Derived helpers ─────────────────────────────────────────────────────── */

/** Channels the sidebar shows, split the way it renders them. */
export function visibleChannels(channels: Record<string, Channel>): {
  live: Channel[];
  archived: Channel[];
  councils: Channel[];
} {
  const all = Object.values(channels)
    .filter((c) => c.deletedAt === null)
    .sort((a, b) => a.createdAt - b.createdAt);
  return {
    live: all.filter((c) => !c.archived && c.kind !== 'council'),
    councils: all.filter((c) => !c.archived && c.kind === 'council'),
    archived: all.filter((c) => c.archived),
  };
}

/** True when a message should make a noise for this operator. */
function isForMe(message: Message): boolean {
  if (message.authorType === 'human') return false;
  const me = operatorName().toLowerCase();
  return (
    message.mentions.includes('@all') ||
    message.mentions.some((m) => m.toLowerCase().replace(/^@/, '') === me) ||
    new RegExp(`@(all|${me.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\b`, 'i').test(message.body)
  );
}

/* ── Socket ──────────────────────────────────────────────────────────────── */

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
      let frame: OutboundFrame;
      try {
        frame = JSON.parse(evt.data as string) as OutboundFrame;
      } catch {
        // A frame we cannot parse is dropped rather than tearing down the feed.
        return;
      }
      const before = useHive.getState();
      useHive.getState().applyFrame(frame);
      react(frame, before);
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

/**
 * Side effects for an incoming frame.
 *
 * Kept out of `applyFrame` deliberately: that reducer runs inside `set` and
 * must stay pure, or React 18's strict double-invocation plays every sound
 * twice in development.
 */
function react(frame: OutboundFrame, before: HiveState): void {
  const state = useHive.getState();
  const { prefs } = state;

  if (frame.t === 'message') {
    const message = frame.message;
    // Our own message is not news; the composer already acknowledged it.
    if (message.authorType === 'human' && message.authorName === operatorName()) {
      play('send', prefs);
      return;
    }
    // A duplicate that `applyFrame` deduped must not ring a second time.
    const list = before.messages[message.channelId] ?? [];
    if (list.some((m) => m.id === message.id)) return;

    const muted = prefs.mutedChannels.includes(message.channelId);
    const mention = isForMe(message);
    const channel = state.channels[message.channelId];
    const focused =
      document.visibilityState === 'visible' &&
      state.view === 'chat' &&
      state.channelId === message.channelId;

    if (!muted) {
      play(mention ? 'mention' : 'message', prefs);
      if (!focused) {
        notifyMessage(
          {
            title: mention
              ? `${message.authorName} mentioned you`
              : `${message.authorName} in #${channel?.name ?? 'hive'}`,
            body: message.body.slice(0, 180),
            tag: message.channelId,
            channelId: message.channelId,
          },
          prefs,
        );
      }
    }
    return;
  }

  if (frame.t === 'permission' && frame.request.status === 'pending') {
    play('approval', prefs, { urgent: true });
    if (document.visibilityState !== 'visible') {
      notifyMessage(
        {
          title: `${frame.request.agentName} needs approval`,
          body: frame.request.summary.slice(0, 180),
          tag: `perm-${frame.request.id}`,
          channelId: null,
          /** Approvals ignore do-not-disturb: something is blocked on you. */
          urgent: true,
        },
        prefs,
      );
    }
    return;
  }

  if (frame.t === 'killswitch' && frame.reason !== null && before.killSwitch === null) {
    play('alert', prefs, { urgent: true });
    state.toast({ kind: 'danger', text: `Kill switch engaged — ${frame.reason}` });
  }
}
