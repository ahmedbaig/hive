import pg from 'pg';
import { config } from './config.js';
import { log } from './log.js';
import { persistenceWrites, postgresUp } from './metrics.js';

const { Pool } = pg;

const rawPool: pg.Pool | null = config.postgres
  ? new Pool({ ...config.postgres, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 })
  : null;

/**
 * Persistence is verified at boot, not assumed from config. Credentials can be
 * present but wrong (or the database not created yet), and in that case the
 * fleet must still run: Redis carries the live bus, history is simply capped by
 * stream trimming until the database is reachable. Without this flag every
 * write would retry and log, drowning the server in noise.
 */
let enabled = false;

if (rawPool) {
  rawPool.on('error', (err) => log.error({ err: err.message }, 'postgres pool error'));
}

/** Probe once at startup. Safe to call again to re-check after provisioning. */
export async function initDb(): Promise<boolean> {
  if (!rawPool) {
    log.warn('Postgres not configured (PGHOST/PGUSER empty) — running Redis-only.');
    enabled = false;
    postgresUp.set(0);
    return false;
  }
  try {
    const client = await rawPool.connect();
    try {
      await client.query('select 1');
    } finally {
      client.release();
    }
    enabled = true;
    postgresUp.set(1);
    log.info({ database: config.postgres?.database }, 'postgres connected');
    return true;
  } catch (err) {
    enabled = false;
    postgresUp.set(0);
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Postgres unreachable — running Redis-only. History is capped until it is provisioned; ' +
        'run `npm run migrate -- --create` then restart.',
    );
    return false;
  }
}

export const hasDb = (): boolean => enabled;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  if (!rawPool || !enabled) return [];
  try {
    const res = await rawPool.query<T>(text, params as never[]);
    return res.rows;
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'query failed');
    return [];
  }
}

/** Fire-and-forget persistence: history must never stall the live bus. */
export function queueWrite(text: string, params: unknown[] = []): void {
  if (!rawPool || !enabled) {
    persistenceWrites.inc({ result: 'skipped' });
    return;
  }
  rawPool
    .query(text, params as never[])
    .then(() => persistenceWrites.inc({ result: 'ok' }))
    .catch((err) => {
      persistenceWrites.inc({ result: 'error' });
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'persistence write failed',
      );
    });
}

export async function closeDb(): Promise<void> {
  if (rawPool) await rawPool.end();
}
