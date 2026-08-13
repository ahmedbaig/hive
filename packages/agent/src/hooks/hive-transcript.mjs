#!/usr/bin/env node
/**
 * Transcript hook — mirrors a live Claude Code conversation into the hive.
 *
 * Wired to Stop and SessionEnd. Claude Code hands us `transcript_path`, a JSONL
 * file of the whole session; we read the entries added since the last run and
 * post them into the `sessions` channel, plus emit token usage as an event.
 *
 * Progress is tracked per session in ~/.hive/transcript-<sessionId>.json so a
 * turn is never posted twice, and a long session does not re-upload its whole
 * history on every turn.
 *
 * PRIVACY: this ships prompt and reply text to the hive server. On an
 * unauthenticated LAN deployment, anything on the network can read it. Set
 * HIVE_TRANSCRIPT=0 to disable, or HIVE_TRANSCRIPT_MODE=summary to send only
 * turn metadata (tool names, token counts) without message bodies.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AGENT_NAME, HIVE_URL, agentId, hiveHeaders, setting } from './hive-config.mjs';

const ENABLED = String(setting('HIVE_TRANSCRIPT', 'transcript', '1')) !== '0';
const MODE = String(setting('HIVE_TRANSCRIPT_MODE', 'transcriptMode', 'full'));
const CHANNEL = String(setting('HIVE_TRANSCRIPT_CHANNEL', 'transcriptChannel', 'sessions'));
const MAX_CHARS = Number(setting('HIVE_TRANSCRIPT_MAX_CHARS', 'transcriptMaxChars', 6_000));

const stateDir = path.join(process.env.HOME || '.', '.hive');

async function post(pathname, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    await fetch(`${HIVE_URL}${pathname}`, {
      method: 'POST',
      headers: hiveHeaders(),
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } catch {
    // Best effort: a hive that is down must never break the session.
  } finally {
    clearTimeout(timer);
  }
}

function readState(sessionId) {
  try {
    return JSON.parse(readFileSync(path.join(stateDir, `transcript-${sessionId}.json`), 'utf8'));
  } catch {
    return { lastUuid: null, lines: 0 };
  }
}

function writeState(sessionId, state) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, `transcript-${sessionId}.json`), JSON.stringify(state));
  } catch {
    /* if we cannot checkpoint, worst case is a duplicate post next turn */
  }
}

const clip = (text) =>
  text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n\n…[${text.length} chars total]` : text;

/**
 * Strip Claude Code's own plumbing out of a user entry.
 *
 * A transcript's `user` entries carry more than what the human typed: injected
 * system reminders, slash-command envelopes, and the stdout of local commands.
 * Mirroring those into a chat channel makes the conversation unreadable and
 * leaks internal scaffolding, so they are removed and an entry that is nothing
 * but plumbing is dropped entirely.
 */
function cleanUserText(raw) {
  let text = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-\1>/g, '')
    .trim();

  // Whatever remains may still be a bare envelope with no human content.
  if (/^<[a-z-]+>[\s\S]*<\/[a-z-]+>$/.test(text)) text = '';
  return text;
}

/** Flatten a message content array into readable text plus a tool list. */
function render(content) {
  if (typeof content === 'string') return { text: content, tools: [] };
  if (!Array.isArray(content)) return { text: '', tools: [] };

  const parts = [];
  const tools = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (block.text) parts.push(block.text);
        break;
      case 'tool_use':
        // The call itself already reaches the hive through the telemetry hook;
        // here we only note it so the transcript reads coherently.
        tools.push(block.name);
        break;
      case 'tool_result':
        break; // results are noise in a chat view
      case 'thinking':
        break; // never mirrored: reasoning is not conversation
      default:
        break;
    }
  }
  return { text: parts.join('\n\n').trim(), tools };
}

async function main() {
  if (!ENABLED) return;

  let payload;
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return;
  }

  const transcriptPath = payload.transcript_path;
  const sessionId = payload.session_id || 'unknown';
  if (!transcriptPath) return;

  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return;
  }

  const state = readState(sessionId);

  // Resume from the last uuid we posted. Falling back to a line count keeps
  // things sane if the transcript was compacted or rewritten underneath us.
  let start = 0;
  if (state.lastUuid) {
    const index = lines.findIndex((line) => line.includes(`"uuid":"${state.lastUuid}"`));
    start = index >= 0 ? index + 1 : Math.min(state.lines, lines.length);
  }
  const fresh = lines.slice(start);
  if (fresh.length === 0) return;

  let lastUuid = state.lastUuid;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let model = null;
  const posts = [];

  for (const line of fresh) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.uuid) lastUuid = entry.uuid;

    if (entry.type === 'assistant') {
      const usage = entry.message?.usage;
      if (usage) {
        inputTokens += usage.input_tokens ?? 0;
        outputTokens += usage.output_tokens ?? 0;
        cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
      }
      if (entry.message?.model) model = entry.message.model;

      const { text, tools } = render(entry.message?.content);
      if (MODE === 'full' && text) {
        posts.push({ role: 'assistant', text, tools });
      } else if (tools.length > 0) {
        posts.push({ role: 'assistant', text: '', tools });
      }
      continue;
    }

    if (entry.type === 'user') {
      // Sidechain entries are subagent traffic, not the human conversation.
      if (entry.isSidechain) continue;
      const { text } = render(entry.message?.content);
      // A user entry with no text is a tool result being fed back to the model.
      const cleaned = cleanUserText(text);
      if (MODE === 'full' && cleaned) posts.push({ role: 'user', text: cleaned });
    }
  }

  for (const item of posts) {
    const label = item.role === 'user' ? '🧑 prompt' : '🤖 reply';
    const toolNote =
      item.tools && item.tools.length > 0
        ? `\n\n_tools: ${[...new Set(item.tools)].join(', ')}_`
        : '';
    const body = item.text ? `**${label}** · ${AGENT_NAME}\n\n${clip(item.text)}${toolNote}`
      : `**${label}** · ${AGENT_NAME}${toolNote}`;

    await post(`/api/channels/${encodeURIComponent(CHANNEL)}/messages`, {
      body,
      kind: 'result',
      meta: { sessionId, role: item.role, model, cwd: payload.cwd ?? null },
    });
  }

  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens > 0) {
    await post('/api/events', {
      agentId: agentId(),
      agentName: AGENT_NAME,
      type: 'usage',
      subject: model,
      detail: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        session_id: sessionId,
      },
    });
  }

  writeState(sessionId, { lastUuid, lines: lines.length });
}

main().finally(() => process.exit(0));
