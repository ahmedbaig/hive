import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// Walk up from src/ or dist/ to the repo root so `.env` is found whether we run
// from source (dev) or compiled output (docker).
for (const candidate of ['../../../../.env', '../../../.env', '../../.env', '../.env']) {
  const p = path.resolve(here, candidate);
  if (existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const Env = z.object({
  HIVE_HOST: z.string().default('0.0.0.0'),
  HIVE_PORT: z.coerce.number().int().default(7777),
  HIVE_PUBLIC_URL: z.string().default(''),
  HIVE_TOKEN: z.string().default(''),

  REDIS_HOST: z.string().default('192.168.0.117'),
  REDIS_PORT: z.coerce.number().int().default(6379),
  REDIS_DB: z.coerce.number().int().default(3),
  REDIS_PASSWORD: z.string().default(''),

  PGHOST: z.string().default(''),
  PGPORT: z.coerce.number().int().default(5432),
  PGDATABASE: z.string().default('hive'),
  PGUSER: z.string().default(''),
  PGPASSWORD: z.string().default(''),

  HIVE_PERMISSION_TIMEOUT_MS: z.coerce.number().int().default(45_000),
  HIVE_AUTO_ALLOW: z.string().default('Read,Glob,Grep,TodoWrite,NotebookRead'),

  HIVE_UPLOAD_DIR: z.string().default(''),
  HIVE_LOG_LEVEL: z.string().default('info'),
  /** Agents whose heartbeat is older than this are marked offline. */
  HIVE_PRESENCE_TTL_MS: z.coerce.number().int().default(30_000),
});

const parsed = Env.parse(process.env);

const uploadDir =
  parsed.HIVE_UPLOAD_DIR || path.resolve(here, '../../../uploads');

export const config = {
  host: parsed.HIVE_HOST,
  port: parsed.HIVE_PORT,
  publicUrl: parsed.HIVE_PUBLIC_URL || `http://localhost:${parsed.HIVE_PORT}`,
  token: parsed.HIVE_TOKEN,
  logLevel: parsed.HIVE_LOG_LEVEL,

  redis: {
    host: parsed.REDIS_HOST,
    port: parsed.REDIS_PORT,
    db: parsed.REDIS_DB,
    password: parsed.REDIS_PASSWORD || undefined,
  },

  /**
   * Postgres is optional at boot. Without credentials the server runs on Redis
   * alone: everything still works live, but history is capped by stream
   * trimming and lost on a Redis restart. This keeps the fleet usable before
   * the database is provisioned.
   */
  postgres:
    parsed.PGHOST && parsed.PGUSER
      ? {
          host: parsed.PGHOST,
          port: parsed.PGPORT,
          database: parsed.PGDATABASE,
          user: parsed.PGUSER,
          password: parsed.PGPASSWORD,
        }
      : null,

  permissionTimeoutMs: parsed.HIVE_PERMISSION_TIMEOUT_MS,
  autoAllow: parsed.HIVE_AUTO_ALLOW.split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  uploadDir,
  presenceTtlMs: parsed.HIVE_PRESENCE_TTL_MS,

  /** Stream retention. Redis is the hot cache; Postgres holds the long tail. */
  streamMaxLen: 5_000,
} as const;

export type Config = typeof config;
