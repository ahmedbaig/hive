#!/usr/bin/env node
/**
 * PreToolUse hook — the remote permission gate.
 *
 * Claude Code passes the pending tool call on stdin. We forward it to the hive
 * server, which parks the request until an operator decides on the dashboard,
 * then answer with a permission decision.
 *
 * Fail-open by design: any transport problem, timeout, or malformed reply
 * answers `ask`, which hands control back to the local terminal prompt. A
 * control plane that is down must not silently allow tool calls, and must not
 * brick every machine in the fleet either.
 *
 * Zero dependencies — this runs once per tool call and must start fast.
 */
import { AGENT_NAME, HIVE_URL, agentId, hiveHeaders, setting } from './hive-config.mjs';

// Stay under the Claude Code hook timeout so we answer rather than get killed.
const TIMEOUT_MS = Number(setting('HIVE_PERMISSION_TIMEOUT_MS', 'permissionTimeoutMs', 45_000));

function respond(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    respond('ask', 'hive: could not parse hook input');
  }

  const controller = new AbortController();
  // Give the HTTP call a little longer than the server-side wait so the server
  // gets to answer "expired" itself rather than us aborting mid-flight.
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS + 5_000);

  try {
    const res = await fetch(`${HIVE_URL}/api/permissions/request`, {
      method: 'POST',
      headers: hiveHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        agentId: agentId(),
        agentName: AGENT_NAME,
        toolName: payload.tool_name,
        toolInput: payload.tool_input ?? {},
        cwd: payload.cwd ?? process.cwd(),
        timeoutMs: TIMEOUT_MS,
      }),
    });

    if (!res.ok) respond('ask', `hive: server returned ${res.status}`);

    const body = await res.json();
    if (body.decision === 'allow') respond('allow', body.reason || 'approved via hive');
    if (body.decision === 'deny') respond('deny', body.reason || 'denied via hive');
    respond('ask', body.reason || 'hive: no decision');
  } catch (err) {
    respond('ask', `hive unreachable (${err?.name === 'AbortError' ? 'timeout' : err?.message})`);
  } finally {
    clearTimeout(timer);
  }
}

main().catch((err) => respond('ask', `hive gate crashed: ${err?.message}`));
