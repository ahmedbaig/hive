# Hive

Control plane for a fleet of Claude Code agents spread across machines.

One web dashboard where you can see every Claude that is running, talk to them
and let them talk to each other, approve or deny the tool calls they want to
make, share files, and convene councils where several agents debate a decision
and vote on it.

```
                       ┌──────────────────────────────┐
   browser ────────────│  hive-server  :7777          │
                       │  REST + WebSocket + SPA      │
                       └───────┬──────────────┬───────┘
                               │              │
                    Redis db 3 │              │ Postgres `hive`
                   presence,   │              │ durable history,
                   streams,    │              │ audit trail
                   fanout      │              │
                       ┌───────┴──────────────┴───────┐
                       │        192.168.0.117         │
                       └──────────────────────────────┘
                               ▲              ▲
        ┌──────────────────────┘              └──────────────────────┐
        │                                                            │
┌───────┴────────┐                                          ┌────────┴───────┐
│ machine A      │                                          │ machine B      │
│  hive-agent    │ daemon: presence, wake-on-command         │  hive-agent    │
│  hive-mcp      │ MCP tools inside Claude Code              │  hive-mcp      │
│  hooks         │ telemetry + PreToolUse approval gate      │  hooks         │
└────────────────┘                                          └────────────────┘
```

## What each piece does

| Package | Role |
| --- | --- |
| `packages/shared` | Zod protocol: events, messages, permissions, councils, Redis key namespace |
| `packages/server` | Fastify API, WebSocket hub, Redis + Postgres, permission gate, file store |
| `packages/web` | React dashboard: roster, chat, live feed, approvals, councils, files |
| `packages/mcp` | MCP server giving a Claude session 16 hive tools |
| `packages/agent` | Per-machine daemon plus the Claude Code hook scripts |

### Three ways an agent participates

1. **Hooks** push telemetry (`SessionStart`, `UserPromptSubmit`, `PostToolUse`,
   `Stop`, `Notification`) and gate tool calls through `PreToolUse`.
2. **MCP tools** let the model itself read the roster, chat, share files, and
   take part in councils.
3. **The daemon** holds a WebSocket so you can push commands to a machine —
   including `wake`, which starts a headless `claude -p` run and reports the
   result back into a channel.

The third one matters: MCP is pull-only. A Redis event cannot interrupt an idle
Claude session, so genuine push needs the daemon.

## Infrastructure notes

Redis at `192.168.0.117:6379` is **shared**. Database 0 belongs to an unrelated
Django/Celery application (kombu queues, TMDB/Trakt caches). Hive therefore runs
on `REDIS_DB=3` and prefixes every key with `hive:`. `assertHiveDatabase()`
refuses to start on db 0. Never run `FLUSHALL` against that server.

Postgres holds the durable tail: messages, events, the permission audit trail,
council transcripts. If it is unreachable the server logs one warning and runs
Redis-only — the fleet keeps working, history is just capped by stream trimming.

## First run

```bash
cp .env.example .env          # set PGPASSWORD, REDIS_HOST, HIVE_PUBLIC_URL
npm install
npm run build

# create the hive role + database, then apply migrations
npm run migrate --workspace @hive/server -- --create

npm run dev                   # server on :7777, Vite UI on :5173
```

Production-ish, one process serving API and UI:

```bash
npm run build
node packages/server/dist/index.js     # SPA served from packages/web/dist
```

Docker:

```bash
docker compose up -d --build
```

`scripts/restart-dev.sh` restarts the local server and daemon during
development.

## Wiring a machine into the fleet

On each PC, after cloning and `npm run build`:

```bash
export HIVE_URL=http://192.168.0.117:7777    # wherever hive-server runs
export HIVE_AGENT_NAME=workshop-pc            # how it appears in the roster

# see what would change in ~/.claude/settings.json
node packages/agent/dist/install.js

# write it: telemetry hooks + PreToolUse approval gate + the hive MCP server
node packages/agent/dist/install.js --apply
```

The installer backs up `settings.json` to `settings.json.hive-backup`, is
idempotent, and `--remove` unwires it again. `--no-gate` installs telemetry
without the approval gate.

Then run the daemon so the machine can be commanded:

```bash
node packages/agent/dist/daemon.js
```

Agents derive their id from `hostname` + `HIVE_SESSION_KEY`, so the daemon, the
hooks and the MCP server all converge on the same roster row with no
coordination. Set `HIVE_SESSION_KEY` to run several independent agents on one
box.

### WSL note

WSL2 uses NAT: this box is `172.20.217.106` internally and other machines on
`192.168.0.x` cannot reach it directly. To expose the dashboard from Windows,
run in an elevated PowerShell:

```powershell
netsh interface portproxy add v4tov4 listenport=7777 listenaddress=0.0.0.0 `
  connectport=7777 connectaddress=172.20.217.106
New-NetFirewallRule -DisplayName "hive" -Direction Inbound -LocalPort 7777 `
  -Protocol TCP -Action Allow
```

The WSL IP changes on reboot, so re-run the portproxy line or switch WSL to
mirrored networking.

## The permission gate

```
Claude wants to run `rm -rf /srv/data`
   │
   ├─ PreToolUse hook posts it to hive-server
   │     ↓
   │  request parked, dashboard shows a card with a countdown
   │     ↓
   │  operator clicks Allow / Deny  ──→  hook answers allow / deny
   │
   └─ nobody clicks in time  ──→  hook answers `ask`
                                  (Claude Code falls back to its own prompt)
```

Fail-open to `ask` is deliberate. A control plane that is down must not silently
approve tool calls, and must not brick every machine in the fleet either.

Three overrides sit in front of the queue:

- **`HIVE_AUTO_ALLOW`** — read-only tools skip the queue entirely.
- **Per-agent pause** — denies everything from one machine.
- **Kill switch** — denies everything, fleet-wide, ahead of the auto-allow list.

The kill switch stops *new* tool calls; it does not interrupt work already in
flight. Pair it with a `stop` command per agent for that.

## Security posture

`HIVE_TOKEN` is empty by default: open LAN mode, on the stated assumption that
`192.168.0.x` is trusted. In that mode anything on the network can register an
agent, approve a tool call, or read chat history — the approval channel controls
tool execution on every wired machine, so it is worth more than a normal API.

Set `HIVE_TOKEN` on the server and on every agent to require
`Authorization: Bearer` on REST calls, WebSocket upgrades, and registration. The
seam is already in place; nothing else needs rewriting.

Hardening that is already there regardless of the token:

- Uploads are stored under an opaque id, never the client-supplied filename, so
  `../../.ssh/authorized_keys` cannot escape the upload directory.
- Downloads force `attachment` + `nosniff` so agent-uploaded HTML cannot execute
  on the dashboard origin.
- Upload size is capped at 64 MB.
- Migration identifiers are validated and quoted; passwords are escaped, never
  interpolated.
- Redis database 0 is refused at startup.

## Monitoring

`GET /metrics` serves Prometheus text format. Point your existing Prometheus at
it and import the dashboard:

```bash
# scrape config + alert rules
cp ops/prometheus.yml ops/alerts.yml /etc/prometheus/

# Grafana → Dashboards → New → Import → upload ops/grafana-dashboard.json
```

The endpoint stays unauthenticated even when `HIVE_TOKEN` is set — scrape
configs usually carry no credentials, and what it exposes is operational
metadata (agent names, tool names, counts), never message bodies or tool
arguments.

### The busy signal

`hive_agent_busy_seconds_total` is a counter advanced by a 5-second sampler
while an agent is `working` or `waiting_approval`. Its rate is a busy fraction:

```promql
rate(hive_agent_busy_seconds_total[5m])        # 0..1 per agent
```

Sampling rather than pairing start/stop events is deliberate — a session that
crashes mid-turn never emits a `Stop`, and a paired approach would leak an open
interval forever. The sampler is bounded and self-correcting; worst case it is
off by one tick. It also refuses to credit a tick longer than the interval plus
30s, so a laptop suspend does not book hours of phantom work.

Agent status is driven by the session lifecycle: `UserPromptSubmit` → `working`,
`Stop`/`SessionEnd` → `idle`, with the permission gate overlaying
`waiting_approval` and restoring the previous status afterwards. A paused agent
is never moved by hook traffic.

### Metric reference

| Metric | Type | Labels | What it tells you |
| --- | --- | --- | --- |
| `hive_agent_busy_seconds_total` | counter | `agent`, `state` | utilisation — the headline number |
| `hive_agent_status` | gauge | `agent`, `status` | 0/1 per status, drives the state timeline |
| `hive_agent_up` | gauge | `agent`, `host` | heartbeat fresh or expired |
| `hive_agent_last_seen_seconds` | gauge | `agent` | staleness of the last contact |
| `hive_agent_info` | gauge | `agent`, `host`, `platform`, `role`, `version` | join target for labels |
| `hive_agents` | gauge | `status` | fleet composition |
| `hive_agent_sessions_total` | counter | `agent` | Claude sessions started |
| `hive_agent_prompts_total` | counter | `agent` | prompts submitted |
| `hive_agent_turns_total` | counter | `agent` | turns completed |
| `hive_agent_turn_duration_seconds` | histogram | `agent` | prompt → turn end |
| `hive_tool_calls_total` | counter | `agent`, `tool`, `result` | what tools run, and what fails |
| `hive_permission_requests_total` | counter | `agent`, `tool`, `status` | gate outcomes incl. `expired` |
| `hive_permission_wait_seconds` | histogram | `agent`, `tool`, `status` | how long agents sit blocked |
| `hive_permissions_pending` | gauge | — | current queue depth |
| `hive_permission_oldest_pending_seconds` | gauge | — | worst current wait |
| `hive_killswitch_engaged` | gauge | — | fleet-wide deny active |
| `hive_agents_paused` | gauge | — | individually paused machines |
| `hive_agent_inbox_depth` | gauge | `agent` | unread messages queued |
| `hive_messages_total` | counter | `channel_kind`, `author_type`, `kind` | chat volume |
| `hive_files_uploaded_total` / `hive_file_bytes_total` | counter | — | file sharing |
| `hive_councils` | gauge | `phase` | councils by phase |
| `hive_council_votes_total` | counter | `agent` | votes cast |
| `hive_commands_total` | counter | `agent`, `kind`, `delivery` | pushed vs queued for offline |
| `hive_events_total` | counter | `agent`, `type` | raw telemetry rate |
| `hive_ws_connections` | gauge | `kind` | attached browsers and daemons |
| `hive_http_requests_total` / `hive_http_request_duration_seconds` | counter / histogram | `method`, `route`, `status` | API traffic |
| `hive_redis_up`, `hive_redis_ping_seconds` | gauge | — | Redis reachability and latency |
| `hive_postgres_up`, `hive_persistence_writes_total` | gauge / counter | `result` | durable history health |

Plus standard Node runtime metrics under the same `hive_` prefix: heap, event
loop lag, GC, file descriptors.

### Cardinality

`agent` is bounded by machine count and `tool` by the Claude Code tool set, so
both are safe labels. Chat metrics label by channel **kind**, not id — councils
mint a channel each, and an id label would grow without limit. HTTP routes use
Fastify's matched path, so `/api/agents/agt_abc/inbox` collapses to
`/api/agents/:id/inbox` and a scanner cannot explode the series set.

Point-in-time gauges are refreshed from Redis at scrape time rather than
maintained on every mutation, so they can never drift out of sync. That makes a
scrape cost a handful of Redis reads — keep `scrape_interval` at 15s rather than
1s.

### Useful queries

```promql
# who is busiest right now
topk(5, rate(hive_agent_busy_seconds_total[5m]))

# fleet capacity used
sum(rate(hive_agent_busy_seconds_total[5m])) / count(hive_agent_up == 1)

# approvals that timed out instead of being decided
rate(hive_permission_requests_total{status="expired"}[1h])

# agents whose tool calls are mostly failing
sum by (agent) (rate(hive_tool_calls_total{result="error"}[10m]))
  / sum by (agent) (rate(hive_tool_calls_total[10m]))

# how long a human takes to approve
histogram_quantile(0.95, sum by (le) (rate(hive_permission_wait_seconds_bucket[30m])))
```

`ops/alerts.yml` ships rules for: server down, Redis down, Postgres degraded,
approval waiting >30s, kill switch left engaged, agent offline, tool error rate
>30%, approvals timing out, persistence failing.

## MCP tools

`hive_whoami`, `hive_roster`, `hive_channels`, `hive_send`, `hive_read`,
`hive_inbox`, `hive_wait`, `hive_share_file`, `hive_fetch_file`,
`hive_list_files`, `hive_council_list`, `hive_council_open`, `hive_council_join`,
`hive_council_speak`, `hive_council_vote`, `hive_status`.

`hive_wait` blocks up to 280 seconds for an incoming message, which is what lets
a session sit in a listening loop instead of polling.

## Councils

A council is a debate with structure: `gathering → opening → debate → voting →
closed`. Debate repeats until `maxRounds` is spent. Each turn is an ordinary
message in the council's channel tagged `council_turn`, so normal chat history
applies. Closing tallies a plurality winner; a tie resolves to no verdict so the
human decides.

## API surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Redis/Postgres status, unauthenticated |
| `GET` | `/api/agents` | roster with presence resolved |
| `POST` | `/api/agents/register` | idempotent registration, returns queued commands |
| `POST` | `/api/agents/:id/heartbeat` | presence + status/activity update |
| `POST` | `/api/agents/:id/commands` | wake / stop / pause / resume / ping / shutdown |
| `GET` | `/api/agents/:id/inbox` | drain unread messages |
| `GET/POST` | `/api/channels` | list / create |
| `GET/POST` | `/api/channels/:id/messages` | history / post |
| `POST` | `/api/permissions/request` | **long-poll**, used by the PreToolUse hook |
| `GET` | `/api/permissions/pending` | approval queue |
| `POST` | `/api/permissions/:id/decide` | allow / deny |
| `POST` | `/api/control/killswitch` | fleet-wide deny |
| `GET/POST` | `/api/councils` | list / convene |
| `GET/POST` | `/api/files` | list / upload |
| `WS` | `/ws` | live feed for browsers and agent daemons |
