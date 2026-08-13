/**
 * Migration runner.
 *
 *   npm run migrate                 apply pending migrations to PGDATABASE
 *   npm run migrate -- --create     create the role and database first, using
 *                                   PG_ADMIN_USER / PG_ADMIN_PASSWORD
 *
 * Migrations are plain .sql files applied in filename order and recorded in
 * `schema_migrations`, so re-running is a no-op.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { config } from './config.js';
import { log } from './log.js';

const { Client } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
// tsc does not copy .sql, and the build script's copy step can be skipped when
// running straight from a clone, so fall back to the source tree.
const foundMigrationsDir = [
  path.join(here, 'migrations'),
  path.resolve(here, '../src/migrations'),
].find((dir) => existsSync(dir));

if (!foundMigrationsDir) throw new Error('cannot locate migrations directory');
const migrationsDir: string = foundMigrationsDir;

async function createRoleAndDatabase(): Promise<void> {
  const adminUser = process.env.PG_ADMIN_USER || 'postgres';
  const adminPassword = process.env.PG_ADMIN_PASSWORD || '';
  const adminDatabase = process.env.PG_ADMIN_DATABASE || 'postgres';

  if (!config.postgres) throw new Error('PGHOST/PGUSER must be set before --create');
  if (!adminPassword) throw new Error('PG_ADMIN_PASSWORD required for --create');

  const admin = new Client({
    host: config.postgres.host,
    port: config.postgres.port,
    user: adminUser,
    password: adminPassword,
    database: adminDatabase,
  });
  await admin.connect();

  const { user, password, database } = config.postgres;

  const roleExists = await admin.query('select 1 from pg_roles where rolname = $1', [user]);
  if (roleExists.rowCount === 0) {
    // Identifiers cannot be parameterised, so they are quoted explicitly. The
    // password still goes through a literal escape rather than interpolation.
    await admin.query(`create role ${quoteIdent(user)} with login password ${quoteLiteral(password)}`);
    log.info({ user }, 'created role');
  } else {
    log.info({ user }, 'role already exists');
  }

  const dbExists = await admin.query('select 1 from pg_database where datname = $1', [database]);
  if (dbExists.rowCount === 0) {
    await admin.query(`create database ${quoteIdent(database)} owner ${quoteIdent(user)}`);
    log.info({ database }, 'created database');
  } else {
    log.info({ database }, 'database already exists');
  }

  await admin.end();
}

async function applyMigrations(): Promise<void> {
  if (!config.postgres) throw new Error('PGHOST/PGUSER not configured');

  const client = new Client(config.postgres);
  await client.connect();

  await client.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await client.query<{ name: string }>('select name from schema_migrations')).rows.map(
      (r) => r.name,
    ),
  );

  for (const file of files) {
    if (applied.has(file)) {
      log.debug({ file }, 'already applied');
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    // Each migration is one transaction: a failure halfway leaves no partial
    // schema behind.
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('insert into schema_migrations (name) values ($1)', [file]);
      await client.query('commit');
      log.info({ file }, 'migration applied');
    } catch (err) {
      await client.query('rollback');
      throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  await client.end();
  log.info({ database: config.postgres.database }, 'migrations up to date');
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`unsafe identifier: ${value}`);
  }
  return `"${value}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  if (process.argv.includes('--create')) await createRoleAndDatabase();
  await applyMigrations();
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.message : String(err) }, 'migration failed');
  process.exit(1);
});
