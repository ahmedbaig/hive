-- Hive schema. Everything lives in its own database (default `hive`), so this
-- never touches whatever else the Postgres server hosts.

create table if not exists agents (
  id            text primary key,
  name          text        not null,
  host          text        not null,
  platform      text        not null default '',
  cwd           text        not null default '',
  role          text        not null default 'worker',
  registered_at timestamptz not null default now(),
  last_seen     timestamptz not null default now()
);
create index if not exists agents_last_seen_idx on agents (last_seen desc);

create table if not exists channels (
  id         text primary key,
  name       text        not null,
  kind       text        not null default 'group',
  topic      text        not null default '',
  created_at timestamptz not null default now(),
  created_by text        not null default 'system'
);

create table if not exists messages (
  id          text primary key,
  channel_id  text        not null,
  ts          timestamptz not null default now(),
  author_type text        not null,
  author_id   text        not null,
  author_name text        not null,
  body        text        not null,
  reply_to    text,
  mentions    text[]      not null default '{}',
  attachments jsonb       not null default '[]'::jsonb,
  kind        text        not null default 'text',
  meta        jsonb       not null default '{}'::jsonb
);
-- The chat view always reads one channel newest-first; this covers it exactly.
create index if not exists messages_channel_ts_idx on messages (channel_id, ts desc);
create index if not exists messages_mentions_idx on messages using gin (mentions);

create table if not exists events (
  id         text primary key,
  ts         timestamptz not null default now(),
  agent_id   text        not null,
  agent_name text        not null default '',
  type       text        not null,
  subject    text,
  detail     jsonb       not null default '{}'::jsonb
);
create index if not exists events_ts_idx on events (ts desc);
create index if not exists events_agent_ts_idx on events (agent_id, ts desc);
create index if not exists events_type_ts_idx on events (type, ts desc);

-- Audit trail for every tool call that was gated. Kept forever: this is the
-- record of what the fleet was allowed to do and who allowed it.
create table if not exists permissions (
  id        text primary key,
  ts        timestamptz not null default now(),
  agent_id  text        not null,
  tool_name text        not null,
  status    text        not null,
  payload   jsonb       not null
);
create index if not exists permissions_ts_idx on permissions (ts desc);
create index if not exists permissions_agent_idx on permissions (agent_id, ts desc);
create index if not exists permissions_status_idx on permissions (status);

create table if not exists files (
  id          text primary key,
  filename    text        not null,
  mime        text        not null default 'application/octet-stream',
  size        bigint      not null default 0,
  sha256      text        not null,
  uploaded_by text        not null,
  uploaded_at timestamptz not null default now(),
  channel_id  text,
  stored_path text        not null
);
create index if not exists files_channel_idx on files (channel_id, uploaded_at desc);

create table if not exists councils (
  id         text primary key,
  channel_id text        not null,
  topic      text        not null,
  question   text        not null,
  phase      text        not null default 'gathering',
  created_at timestamptz not null default now(),
  payload    jsonb       not null
);
create index if not exists councils_created_idx on councils (created_at desc);
