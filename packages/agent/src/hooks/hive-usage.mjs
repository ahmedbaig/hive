#!/usr/bin/env node
/**
 * Usage hook — reports this machine's context pressure and token spend.
 *
 * Wired to Stop and SessionEnd. Claude Code hands us `transcript_path`; every
 * assistant entry in that JSONL carries the `usage` block the API returned, so
 * spend is derivable locally per session.
 *
 * What is NOT derivable here: the rate-limit reset time. Claude Code never
 * exposes HTTP response headers to the tool or hook layer, so `anthropic-
 * ratelimit-*` is unreadable from this side, and the hive server does not talk
 * to the API itself either. The dashboard therefore shows a rolling window
 * computed from observed spend and says so, rather than inventing a countdown.
 *
 * Context used is taken from the *last* request rather than summed: the prompt
 * of the most recent turn is, by definition, what is currently occupying the
 * window. Summing every turn would report cumulative traffic and read as a
 * context that is 40x over its limit.
 *
 * Like every hive hook this exits 0 unconditionally and never writes to stdout.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AGENT_NAME, HIVE_URL, agentId, hiveHeaders, setting } from './hive-config.mjs';

const ENABLED = String(setting('HIVE_USAGE', 'usage', '1')) !== '0';

/**
 * Context window per model family.
 *
 * The transcript records which model answered but not how large its window is,
 * so this is a lookup with a conservative default. Override with
 * HIVE_CONTEXT_MAX when running a long-context configuration — a wrong ceiling
 * only skews the percentage, never the token counts.
 */
const CONTEXT_WINDOWS = [
  // The long-context marker is checked first: it is a suffix on an otherwise
  // ordinary model id, so a family pattern would swallow it and report a 1M
  // window as 200k.
  [/\[1m\]/, 1_000_000],
  [/opus-5|sonnet-5|fable-5/, 200_000],
  [/opus-4|sonnet-4/, 200_000],
  [/haiku-4/, 200_000],
];
const DEFAULT_CONTEXT_MAX = Number(setting('HIVE_CONTEXT_MAX', 'contextMax', 200_000));

/** Known window sizes, ascending. An observed prompt picks the first that fits. */
const TIERS = [200_000, 500_000, 1_000_000];

/**
 * The window size to report a percentage against.
 *
 * The model name is a hint, not an answer: the transcript records which model
 * replied but never how large its window is, and a session can be configured
 * for long context without that showing up in the id. So the observed prompt
 * overrides the guess — if a request carried 383k tokens then the window is
 * demonstrably not 200k, and reporting 191% full is worse than useless.
 */
function contextMaxFor(model, observed) {
  let assumed = DEFAULT_CONTEXT_MAX;
  if (model) {
    for (const [pattern, size] of CONTEXT_WINDOWS) {
      if (pattern.test(model)) {
        assumed = size;
        break;
      }
    }
  }
  if (observed <= assumed) return assumed;
  const tier = TIERS.find((size) => size >= observed);
  // Past every known tier, round the observation up to the next 100k rather
  // than clamping — a bar pinned at 100% hides how much headroom is left.
  return tier ?? Math.ceil(observed / 100_000) * 100_000;
}

const stateDir = path.join(process.env.HOME || '.', '.hive');

function readState(sessionId) {
  try {
    return JSON.parse(readFileSync(path.join(stateDir, `usage-${sessionId}.json`), 'utf8'));
  } catch {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
  }
}

function writeState(sessionId, state) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, `usage-${sessionId}.json`), JSON.stringify(state));
  } catch {
    /* worst case the next run reports a delta it already reported */
  }
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
  const sessionId = payload.session_id || null;
  if (!transcriptPath) return;

  let lines;
  try {
    lines = readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return;
  }

  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
  let contextUsed = 0;
  let model = null;

  for (const line of lines) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant') continue;
    const usage = entry.message?.usage;
    if (!usage) continue;

    const input = usage.input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;

    totals.inputTokens += input;
    totals.outputTokens += usage.output_tokens ?? 0;
    totals.cacheReadTokens += cacheRead;
    totals.cacheWriteTokens += cacheWrite;
    totals.turns += 1;

    // Overwritten each iteration, so the loop ends holding the newest turn.
    contextUsed = input + cacheRead + cacheWrite;
    if (entry.message?.model) model = entry.message.model;
  }

  if (totals.turns === 0) return;

  const previous = readState(sessionId ?? 'unknown');
  const delta = {
    inputTokens: Math.max(0, totals.inputTokens - previous.inputTokens),
    outputTokens: Math.max(0, totals.outputTokens - previous.outputTokens),
    cacheReadTokens: Math.max(0, totals.cacheReadTokens - previous.cacheReadTokens),
    cacheWriteTokens: Math.max(0, totals.cacheWriteTokens - previous.cacheWriteTokens),
    turns: Math.max(0, totals.turns - previous.turns),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${HIVE_URL}/api/agents/${agentId()}/stats`, {
      method: 'POST',
      headers: hiveHeaders(),
      signal: controller.signal,
      body: JSON.stringify({
        contextUsed,
        contextMax: contextMaxFor(model, contextUsed),
        model,
        sessionId,
        ...delta,
        // Absolute session figures, so the record is replaced rather than
        // accumulated — a hook that runs twice on one turn cannot inflate it.
        sessionTotals: totals,
      }),
    });
    // Only checkpoint once the server has the delta; a failed post must be
    // retried on the next turn, not silently dropped.
    if (res.ok) writeState(sessionId ?? 'unknown', totals);
  } catch {
    // A hive that is down must never break the session.
  } finally {
    clearTimeout(timer);
  }
}

main().finally(() => process.exit(0));
