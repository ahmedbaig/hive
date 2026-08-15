/**
 * Redis key namespace.
 *
 * IMPORTANT: the Redis instance at 192.168.0.117 is shared. Database 0 holds a
 * live Django/Celery application (kombu queues, TMDB/Trakt/TVMaze caches).
 * Hive therefore:
 *   1. runs on its own database index (REDIS_DB, default 3), and
 *   2. prefixes every key with `hive:` even inside its own database.
 *
 * Never issue FLUSHALL against this server, and never FLUSHDB outside the
 * configured hive index — either would destroy the other application's queue.
 */
export const NS = 'hive';

export const K = {
  /** Hash: agentId -> serialised AgentRecord. Survives disconnects. */
  agents: `${NS}:agents`,
  /** Volatile per-agent heartbeat. Presence = existence of this key. */
  heartbeat: (agentId: string) => `${NS}:hb:${agentId}`,

  /** Global telemetry stream: every hook event from every machine. */
  eventStream: `${NS}:stream:events`,
  /** Chat stream, one per channel, so a busy channel cannot starve others. */
  chatStream: (channelId: string) => `${NS}:stream:chat:${channelId}`,
  /** Permission requests awaiting a decision. */
  permStream: `${NS}:stream:perm`,

  /** Hash: channelId -> serialised Channel. */
  channels: `${NS}:channels`,
  /** Set of channelIds an agent belongs to. */
  agentChannels: (agentId: string) => `${NS}:agent:${agentId}:channels`,
  /** Sorted set of unread message ids for an agent, scored by timestamp. */
  inbox: (agentId: string) => `${NS}:inbox:${agentId}`,

  /** Hash: permissionId -> serialised PermissionRequest. */
  permissions: `${NS}:permissions`,
  /**
   * Single-element list the waiting hook blocks on with BLPOP. The server
   * LPUSHes the decision here. A list rather than pub/sub so a decision made
   * microseconds before the hook starts waiting is not lost.
   */
  permReply: (permissionId: string) => `${NS}:perm:reply:${permissionId}`,

  /** Hash: councilId -> serialised Council. */
  councils: `${NS}:councils`,
  /** Hash: fileId -> serialised FileTransfer. */
  files: `${NS}:files`,
  /**
   * Hash: sha256 -> storedPath. Agents re-share the same artifact constantly
   * (memory sync alone re-uploads on every change), so identical bytes are
   * written once and later uploads point at the existing blob.
   */
  fileBlobs: `${NS}:files:sha`,

  /**
   * Token spend stream. Postgres holds the long tail; this is the hot window
   * the stats view reads, and the only series at all when Postgres is absent.
   */
  tokenStream: `${NS}:stream:tokens`,

  /**
   * Fleet kill switch. When set, every PreToolUse hook denies immediately
   * without consulting the queue. Value is the reason string shown to agents.
   */
  killSwitch: `${NS}:killswitch`,
  /** Per-agent pause flag; same semantics scoped to one machine. */
  agentPause: (agentId: string) => `${NS}:pause:${agentId}`,

  /** Directives queued for an agent daemon to act on (wake, stop, prompt). */
  commandQueue: (agentId: string) => `${NS}:cmd:${agentId}`,

  /** Pub/sub fanout so multiple server instances stay in sync. */
  pubsub: `${NS}:pubsub`,
} as const;

/** Guard used before any destructive Redis maintenance command. */
export function assertHiveDatabase(db: number): void {
  if (db === 0) {
    throw new Error(
      'Refusing to operate on Redis database 0: it is in use by an unrelated ' +
        'Django/Celery application. Set REDIS_DB to a dedicated index.',
    );
  }
}
