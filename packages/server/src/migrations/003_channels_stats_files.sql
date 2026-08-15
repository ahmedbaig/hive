-- Channel lifecycle, per-agent telemetry, and durable file sharing.
--
-- Three unrelated concerns land in one migration because they ship together;
-- each block is independent and safe to re-run.

/* ── Channels ─────────────────────────────────────────────────────────────── */

-- `description` is the standing charter injected into agent prompts; `topic`
-- stays the mutable current focus. Archival and deletion are timestamps rather
-- than booleans so the UI can show *when* something was retired and offer undo.
alter table channels add column if not exists description text        not null default '';
alter table channels add column if not exists archived_at timestamptz;
alter table channels add column if not exists deleted_at  timestamptz;

-- The sidebar reads live channels on every load; archived and deleted rows are
-- the long tail nobody scrolls.
create index if not exists channels_live_idx
  on channels (created_at)
  where deleted_at is null and archived_at is null;

/* ── Per-agent telemetry ──────────────────────────────────────────────────── */

-- Last-value columns, overwritten on every heartbeat. No history here on
-- purpose: "how full is this context right now" has no useful past, and keeping
-- one would mean a write amplification of one row per turn per agent for data
-- that is never read back.
alter table agents add column if not exists context_used  bigint      not null default 0;
alter table agents add column if not exists context_max   bigint      not null default 200000;
alter table agents add column if not exists model         text;
alter table agents add column if not exists session_id    text;
alter table agents add column if not exists stats_at      timestamptz;

-- Append-only spend series. Separate table from `agents` because the write
-- rates differ by orders of magnitude and an UPDATE-heavy row next to an
-- INSERT-only series would bloat the former's heap for no benefit.
create table if not exists token_events (
  id                 text primary key,
  ts                 timestamptz not null default now(),
  agent_id           text        not null,
  agent_name         text        not null default '',
  session_id         text,
  model              text,
  input_tokens       bigint      not null default 0,
  output_tokens      bigint      not null default 0,
  cache_read_tokens  bigint      not null default 0,
  cache_write_tokens bigint      not null default 0
);
-- Every query is "spend since T", optionally for one agent.
create index if not exists token_events_ts_idx on token_events (ts desc);
create index if not exists token_events_agent_ts_idx on token_events (agent_id, ts desc);

/* ── Files ────────────────────────────────────────────────────────────────── */

-- Soft delete, matching channels: a shared artifact is often the only copy of
-- something an agent produced mid-run.
alter table files add column if not exists deleted_at timestamptz;

-- Small text artifacts live inline so a range read is one query and needs no
-- filesystem hop. Everything larger stays on disk with `stored_path` pointing
-- at it: multi-megabyte bytea doubles into WAL, then into every base backup and
-- replica stream, which is how a chat app quietly becomes a storage problem.
alter table files add column if not exists content bytea;

alter table files add column if not exists uploaded_by_name text not null default '';

-- Dedupe lookups go through this; agents re-upload identical bytes constantly.
create index if not exists files_sha_idx on files (sha256);
create index if not exists files_live_idx on files (uploaded_at desc) where deleted_at is null;
