import { assertHiveDatabase } from '@hive/shared';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { log } from './log.js';

assertHiveDatabase(config.redis.db);

function make(role: string): Redis {
  const client = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    db: config.redis.db,
    password: config.redis.password,
    lazyConnect: false,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 250, 5_000),
  });
  client.on('error', (err) => log.error({ role, err: err.message }, 'redis error'));
  client.on('connect', () => log.info({ role, db: config.redis.db }, 'redis connected'));
  return client;
}

/** Request/response commands. Never blocks. */
export const redis = make('cmd');
/** Dedicated connection for SUBSCRIBE — a subscribed client cannot run commands. */
export const redisSub = make('sub');
/** Blocking reads (BLPOP/XREAD BLOCK) get their own connection for the same reason. */
export const redisBlocking = make('blocking');

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSub.quit(), redisBlocking.quit()]);
}
