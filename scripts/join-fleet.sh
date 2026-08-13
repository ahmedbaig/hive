#!/usr/bin/env bash
#
# Join this machine to an existing hive.
#
#   ./scripts/join-fleet.sh http://192.168.0.117:7777 workshop-pc
#
# Installs three things:
#   1. Claude Code hooks   — telemetry, approval gate, transcript mirroring
#   2. The hive MCP server — chat/roster/files/councils tools inside sessions
#   3. The agent daemon    — presence, chat replies, wake-on-command, memory sync
#
# Safe to re-run: the installer is idempotent and backs up settings.json first.
set -euo pipefail

HIVE_URL="${1:-${HIVE_URL:-}}"
AGENT_NAME="${2:-${HIVE_AGENT_NAME:-$(hostname)}}"

if [ -z "$HIVE_URL" ]; then
  echo "usage: $0 <hive-url> [agent-name]" >&2
  echo "   eg: $0 http://192.168.0.117:7777 workshop-pc" >&2
  exit 1
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "▸ hive:  $HIVE_URL"
echo "▸ agent: $AGENT_NAME"

# Fail early with a clear message rather than half-installing against a hive
# that is not actually reachable from this machine.
echo "▸ checking reachability…"
if ! curl -fsS --max-time 5 "$HIVE_URL/health" > /dev/null; then
  echo "✗ cannot reach $HIVE_URL/health from this machine." >&2
  echo "  Check the server is running and that no firewall blocks the port." >&2
  exit 1
fi
echo "  ok"

echo "▸ installing dependencies…"
npm ci --silent 2>/dev/null || npm install --silent

echo "▸ building…"
npm run build --silent

echo "▸ wiring Claude Code…"
HIVE_URL="$HIVE_URL" HIVE_AGENT_NAME="$AGENT_NAME" \
  node packages/agent/dist/install.js --apply

echo
echo "✔ Claude Code is wired. Restart any running Claude sessions to pick it up."
echo
echo "Now run the daemon so this machine can chat and be commanded:"
echo
echo "  HIVE_URL=$HIVE_URL HIVE_AGENT_NAME=$AGENT_NAME node $root/packages/agent/dist/daemon.js"
echo
echo "To run it permanently (Linux):"
echo "  sudo cp $root/ops/hive-agent.service /etc/systemd/system/"
echo "  sudo systemctl daemon-reload && sudo systemctl enable --now hive-agent"
