#!/usr/bin/env node
/**
 * Telemetry hook — feeds the live dashboard feed.
 *
 * Wired to SessionStart, UserPromptSubmit, PostToolUse, Stop and Notification.
 * The hook event name arrives in the stdin payload, so one script covers all of
 * them.
 *
 * This must never interfere with the session: it exits 0 no matter what, keeps
 * a hard 3-second ceiling on the network call, and prints nothing on stdout.
 */
import { AGENT_NAME, HIVE_URL, agentId, hiveHeaders } from './hive-config.mjs';

const EVENT_TYPES = {
  SessionStart: 'session.start',
  SessionEnd: 'session.end',
  UserPromptSubmit: 'prompt.submit',
  PreToolUse: 'tool.pre',
  PostToolUse: 'tool.post',
  Stop: 'turn.stop',
  SubagentStop: 'turn.stop',
  Notification: 'notification',
};

/** Keep the payload small — the server truncates too, but not before transit. */
function summarise(payload) {
  const input = payload.tool_input ?? {};
  const detail = {};
  if (typeof input.command === 'string') detail.command = input.command.slice(0, 500);
  if (typeof input.file_path === 'string') detail.file_path = input.file_path;
  if (typeof input.url === 'string') detail.url = input.url;
  if (typeof payload.prompt === 'string') detail.prompt = payload.prompt.slice(0, 500);
  if (typeof payload.message === 'string') detail.message = payload.message.slice(0, 500);
  if (payload.tool_response && typeof payload.tool_response === 'object') {
    detail.ok = payload.tool_response.success !== false;
  }
  if (typeof payload.source === 'string') detail.source = payload.source;
  return detail;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const type = EVENT_TYPES[payload.hook_event_name];
  if (!type) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    await fetch(`${HIVE_URL}/api/events`, {
      method: 'POST',
      headers: hiveHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        agentId: agentId(),
        agentName: AGENT_NAME,
        type,
        subject: payload.tool_name ?? payload.hook_event_name ?? null,
        detail: summarise(payload),
      }),
    });
  } catch {
    // Telemetry is best-effort. A hive that is down must not break the session.
  } finally {
    clearTimeout(timer);
  }
}

main().finally(() => process.exit(0));
