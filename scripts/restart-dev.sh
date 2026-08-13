#!/usr/bin/env bash
# Restart the local hive server and agent daemon for development.
#
# Uses pgrep on the node process only — matching the full command line would
# also match this script's own invocation and kill the calling shell.
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log_dir="${HIVE_LOG_DIR:-/tmp/hive-logs}"
mkdir -p "$log_dir"

stop() {
  local pattern="$1" name="$2"
  local pids
  # Match the node process by script path only. The path may be absolute or
  # relative depending on how it was launched, so anchor on "node " plus any
  # prefix — but never match a shell whose command line merely mentions it.
  pids="$(pgrep -f "^node .*packages/${pattern}$" || true)"
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    echo "stopped $name ($pids)"
  fi
}

stop "agent/dist/daemon.js" "agent"
stop "server/dist/index.js" "server"

cd "$root"
nohup node "$root/packages/server/dist/index.js" > "$log_dir/server.log" 2>&1 &
echo "server pid $!"

for _ in $(seq 1 15); do
  if curl -sf --max-time 1 http://127.0.0.1:7777/health > /dev/null; then break; fi
  sleep 1
done

if [ "${1:-}" != "--server-only" ]; then
  nohup node "$root/packages/agent/dist/daemon.js" > "$log_dir/agent.log" 2>&1 &
  echo "agent pid $!"
  sleep 2
fi

curl -s http://127.0.0.1:7777/health
echo
echo "logs: $log_dir"
