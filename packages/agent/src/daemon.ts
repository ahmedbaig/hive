#!/usr/bin/env node
/**
 * Per-machine hive daemon.
 *
 * Responsibilities:
 *   1. Register this machine in the fleet roster and keep its heartbeat alive.
 *   2. Hold a WebSocket to the hive so the operator can reach it instantly.
 *   3. Execute commands: wake (headless Claude run), stop, pause, ping.
 *
 * This is the piece that makes push work. MCP tools are pull-only — a Redis
 * event cannot interrupt an idle Claude session — so wake-on-event runs a fresh
 * headless `claude -p` here and reports the result back into a channel.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import path from 'node:path';
import type { AgentCommand, OutboundFrame } from '@hive/shared';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import { type MemoryFile, syncMemory } from './memory-sync.js';

for (const candidate of ['.env', '../.env', '../../.env', '../../../.env', '../../../../.env']) {
  const p = path.resolve(process.cwd(), candidate);
  if (existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const HIVE_URL = (process.env.HIVE_URL || process.env.HIVE_PUBLIC_URL || 'http://127.0.0.1:7777').replace(
  /\/$/,
  '',
);
const TOKEN = process.env.HIVE_TOKEN || '';
const SESSION_KEY = process.env.HIVE_SESSION_KEY || hostname();
const AGENT_NAME = process.env.HIVE_AGENT_NAME || hostname();
const HEARTBEAT_MS = Number(process.env.HIVE_HEARTBEAT_MS || 10_000);
const CLAUDE_BIN = process.env.HIVE_CLAUDE_BIN || 'claude';
const WAKE_ENABLED = process.env.HIVE_WAKE_ENABLED !== '0';
const WAKE_CWD = process.env.HIVE_WAKE_CWD || process.cwd();
const MEMORY_SYNC_ENABLED = process.env.HIVE_MEMORY_SYNC !== '0';
const MEMORY_SYNC_MS = Number(process.env.HIVE_MEMORY_SYNC_MS || 300_000);
const MEMORY_CHANNEL = process.env.HIVE_MEMORY_CHANNEL || 'memory';
const MEMORY_ROOTS = (process.env.HIVE_MEMORY_ROOTS || WAKE_CWD)
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

let agentId = '';
let socket: WebSocket | null = null;
let running: ChildProcess | null = null;
let shuttingDown = false;

const log = (msg: string, extra: Record<string, unknown> = {}): void => {
  const detail = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[hive-agent] ${msg}${detail}`);
};

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json', ...extra };
  if (TOKEN) out.authorization = `Bearer ${TOKEN}`;
  if (agentId) {
    out['x-hive-agent'] = agentId;
    out['x-hive-agent-name'] = AGENT_NAME;
  }
  return out;
}

async function register(): Promise<void> {
  const res = await fetch(`${HIVE_URL}/api/agents/register`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      name: AGENT_NAME,
      host: hostname(),
      platform: platform(),
      pid: process.pid,
      cwd: WAKE_CWD,
      sessionKey: SESSION_KEY,
      sessionId: null,
      model: null,
      role: process.env.HIVE_AGENT_ROLE || 'worker',
      tags: (process.env.HIVE_AGENT_TAGS || '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      wakeEnabled: WAKE_ENABLED,
      version: '0.1.0',
    }),
  });
  if (!res.ok) throw new Error(`register failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as {
    agent: { id: string };
    pendingCommands: AgentCommand[];
  };
  agentId = body.agent.id;
  log('registered', { agentId, name: AGENT_NAME, hive: HIVE_URL });

  for (const command of body.pendingCommands ?? []) await handleCommand(command);
}

async function heartbeat(status?: string, activity?: string | null): Promise<void> {
  if (!agentId) return;
  try {
    await fetch(`${HIVE_URL}/api/agents/${agentId}/heartbeat`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        ...(status ? { status } : {}),
        ...(activity !== undefined ? { activity } : {}),
      }),
    });
  } catch (err) {
    log('heartbeat failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

async function say(channelId: string | null, body: string): Promise<void> {
  const channel = channelId || 'lobby';
  try {
    await fetch(`${HIVE_URL}/api/channels/${encodeURIComponent(channel)}/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ body, kind: 'result' }),
    });
  } catch (err) {
    log('post failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/* ── Conversational replies ──────────────────────────────────────────────── */

const REPLY_ENABLED = process.env.HIVE_REPLY !== '0';
const REPLY_TIMEOUT_MS = Number(process.env.HIVE_REPLY_TIMEOUT_MS || 180_000);
/** Channels the agent answers in even without being named. */
const REPLY_CHANNELS = (process.env.HIVE_REPLY_CHANNELS || 'lobby,ops')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

let replying = false;

/**
 * Decide whether a chat message is addressed to this machine.
 *
 * Two rules keep the fleet from talking itself into an infinite loop: never
 * answer our own messages, and only answer another *agent* when it names us
 * explicitly. Humans get answered in the general channels without ceremony,
 * which is what makes the dashboard feel like a chat rather than a log.
 */
function shouldReply(message: {
  authorId: string;
  authorType: string;
  channelId: string;
  mentions: string[];
  kind: string;
  body: string;
}): boolean {
  if (!REPLY_ENABLED) return false;
  if (message.authorId === agentId) return false;
  // `result` messages are our own transcript and wake output coming back.
  if (message.kind !== 'text') return false;

  const named =
    message.mentions.includes(agentId) ||
    message.mentions.some((m) => m.toLowerCase() === AGENT_NAME.toLowerCase());
  if (named) return true;
  if (message.authorType === 'agent') return false; // agents must name us
  if (message.mentions.includes('@all')) return true;

  // Human message in a general channel with nobody else named: answer it.
  const channelName = channelNames.get(message.channelId) ?? message.channelId;
  const addressedToSomeoneElse = message.mentions.length > 0;
  return !addressedToSomeoneElse && REPLY_CHANNELS.includes(channelName);
}

/** channelId → name, so reply rules can be written against readable names. */
const channelNames = new Map<string, string>();

async function loadChannelNames(): Promise<void> {
  try {
    const res = await fetch(`${HIVE_URL}/api/channels`, { headers: headers() });
    if (!res.ok) return;
    const body = (await res.json()) as { channels: Array<{ id: string; name: string }> };
    for (const channel of body.channels) channelNames.set(channel.id, channel.name);
  } catch {
    /* names are a convenience; ids still work */
  }
}

/**
 * Answer a chat message by running a headless Claude turn and posting the
 * result back into the same channel.
 *
 * The prompt carries recent channel history so the reply has context, and the
 * run is capped: one at a time, with a hard timeout, so a wedged turn cannot
 * pin the machine or flood the channel.
 */
async function replyToMessage(message: {
  channelId: string;
  authorName: string;
  body: string;
}): Promise<void> {
  if (replying) {
    log('reply skipped, already answering');
    return;
  }
  replying = true;
  await heartbeat('working', `answering ${message.authorName}`);

  try {
    const history = await recentHistory(message.channelId);
    const prompt = [
      `You are "${AGENT_NAME}", a Claude Code agent on host ${hostname()}, taking part in a team chat`,
      `called Hive alongside a human operator and other Claude agents.`,
      ``,
      `Recent messages in this channel:`,
      history,
      ``,
      `${message.authorName} just said: ${message.body}`,
      ``,
      `Reply directly and concisely as a chat message. Do not greet or sign off.`,
      `You may use your tools to check things on this machine before answering.`,
    ].join('\n');

    const answer = await runClaude(prompt, REPLY_TIMEOUT_MS);
    await postTo(message.channelId, answer || '(no output)');
  } catch (err) {
    await postTo(
      message.channelId,
      `⚠️ ${AGENT_NAME} could not answer: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    replying = false;
    await heartbeat('idle', null);
  }
}

async function recentHistory(channelId: string, limit = 12): Promise<string> {
  try {
    const res = await fetch(
      `${HIVE_URL}/api/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}`,
      { headers: headers() },
    );
    if (!res.ok) return '(unavailable)';
    const body = (await res.json()) as {
      messages: Array<{ authorName: string; body: string }>;
    };
    return body.messages
      .slice(-limit)
      .map((m) => `${m.authorName}: ${m.body.slice(0, 400)}`)
      .join('\n');
  } catch {
    return '(unavailable)';
  }
}

async function postTo(channelId: string, body: string): Promise<void> {
  try {
    await fetch(`${HIVE_URL}/api/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ body, kind: 'text' }),
    });
  } catch (err) {
    log('reply post failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/** Run `claude -p` and return its text, killed hard if it overruns. */
function runClaude(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, ['-p', prompt], {
      cwd: WAKE_CWD,
      env: {
        ...process.env,
        HIVE_SESSION_KEY: SESSION_KEY,
        HIVE_AGENT_NAME: AGENT_NAME,
        // A chat reply should not sit for 45s on an approval nobody is
        // watching; fall back to the local prompt quickly instead.
        HIVE_PERMISSION_TIMEOUT_MS: '20000',
        // Mirroring a headless reply into #sessions would echo the chat back
        // into itself.
        HIVE_TRANSCRIPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running = child;

    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => {
      if (out.length < 20_000) out += c.toString('utf8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      if (err.length < 4_000) err += c.toString('utf8');
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.on('error', (spawnErr) => {
      clearTimeout(timer);
      running = null;
      reject(spawnErr);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      running = null;
      if (code === 0) resolve(out.trim().slice(0, 8_000));
      else reject(new Error(err.trim().slice(0, 500) || `claude exited ${code}`));
    });
  });
}

/** sha256 of each memory file as last uploaded, so unchanged files are skipped. */
const memorySeen = new Map<string, string>();

async function runMemorySync(): Promise<void> {
  if (!MEMORY_SYNC_ENABLED) return;
  try {
    await syncMemory(
      memorySeen,
      {
        upload: async (file: MemoryFile) => {
          const form = new FormData();
          form.append('channelId', MEMORY_CHANNEL);
          form.append('file', new Blob([file.content], { type: 'text/markdown' }), file.name);
          // FormData sets its own multipart content-type boundary; passing ours
          // would corrupt the body.
          const { 'content-type': _drop, ...rest } = headers();
          const res = await fetch(`${HIVE_URL}/api/files`, {
            method: 'POST',
            headers: rest,
            body: form,
          });
          if (!res.ok) return null;
          const body = (await res.json()) as { file: { id: string; size: number } };
          return { id: body.file.id, size: body.file.size };
        },
        post: async (body, attachments, meta) => {
          await fetch(`${HIVE_URL}/api/channels/${encodeURIComponent(MEMORY_CHANNEL)}/messages`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ body, attachments, kind: 'result', meta }),
          });
        },
        event: async (type, subject, detail) => {
          await fetch(`${HIVE_URL}/api/events`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ agentId, agentName: AGENT_NAME, type, subject, detail }),
          });
        },
        log,
      },
      MEMORY_ROOTS,
    );
  } catch (err) {
    log('memory sync failed', { err: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Run a one-shot headless Claude session. Output is capped: a runaway run must
 * not push a megabyte of text into the chat channel.
 */
async function wake(prompt: string, replyChannelId: string | null): Promise<void> {
  if (!WAKE_ENABLED) {
    await say(replyChannelId, `wake ignored — HIVE_WAKE_ENABLED=0 on ${AGENT_NAME}`);
    return;
  }
  if (running) {
    await say(replyChannelId, `busy — ${AGENT_NAME} is already running a woken task`);
    return;
  }

  log('waking', { prompt: prompt.slice(0, 80) });
  await heartbeat('working', `woken: ${prompt.slice(0, 80)}`);

  const child = spawn(CLAUDE_BIN, ['-p', prompt], {
    cwd: WAKE_CWD,
    env: { ...process.env, HIVE_SESSION_KEY: SESSION_KEY, HIVE_AGENT_NAME: AGENT_NAME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running = child;

  const MAX_OUTPUT = 12_000;
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    if (out.length < MAX_OUTPUT) out += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (err.length < 2_000) err += chunk.toString('utf8');
  });

  child.on('error', (spawnErr) => {
    running = null;
    void say(replyChannelId, `wake failed to start on ${AGENT_NAME}: ${spawnErr.message}`);
    void heartbeat('idle', null);
  });

  child.on('close', (code) => {
    running = null;
    const trimmed = out.trim().slice(0, MAX_OUTPUT);
    const body =
      code === 0
        ? `**${AGENT_NAME}** finished:\n\n${trimmed || '(no output)'}`
        : `**${AGENT_NAME}** exited ${code}:\n\n${(err || trimmed).slice(0, 4_000) || '(no output)'}`;
    void say(replyChannelId, body);
    void heartbeat('idle', null);
    log('wake finished', { code });
  });
}

async function handleCommand(command: AgentCommand): Promise<void> {
  log('command', { kind: command.kind, by: command.issuedBy });
  switch (command.kind) {
    case 'wake':
      await wake(command.payload, command.replyChannelId);
      return;
    case 'stop':
      if (running) {
        running.kill('SIGTERM');
        // SIGTERM first, then insist — a wedged run should not survive a stop.
        setTimeout(() => running?.kill('SIGKILL'), 5_000).unref();
        await say(command.replyChannelId, `${AGENT_NAME}: stopped current run`);
      }
      await heartbeat('idle', null);
      return;
    case 'pause':
      await heartbeat('paused', command.payload || 'paused by operator');
      return;
    case 'resume':
      await heartbeat('idle', null);
      return;
    case 'ping':
      await say(command.replyChannelId, `${AGENT_NAME}: pong`);
      await heartbeat();
      return;
    case 'shutdown':
      log('shutdown requested');
      shuttingDown = true;
      running?.kill('SIGTERM');
      socket?.close();
      process.exit(0);
  }
}

function connect(): void {
  const wsUrl = `${HIVE_URL.replace(/^http/, 'ws')}/ws`;
  socket = new WebSocket(wsUrl, TOKEN ? { headers: { authorization: `Bearer ${TOKEN}` } } : undefined);

  socket.on('open', () => {
    log('socket open');
    socket?.send(
      JSON.stringify({ t: 'hello', as: 'agent', agentId, name: AGENT_NAME, token: TOKEN || null }),
    );
  });

  socket.on('message', (raw: Buffer) => {
    let frame: OutboundFrame;
    try {
      frame = JSON.parse(raw.toString()) as OutboundFrame;
    } catch {
      return;
    }
    if (frame.t === 'command') void handleCommand(frame.command);
    if (frame.t === 'error') log('server error', { message: frame.message });
    if (frame.t === 'channel') channelNames.set(frame.channel.id, frame.channel.name);
    if (frame.t === 'welcome') {
      for (const channel of frame.channels) channelNames.set(channel.id, channel.name);
    }
    if (frame.t === 'message' && shouldReply(frame.message)) {
      log('answering chat', { from: frame.message.authorName });
      void replyToMessage(frame.message);
    }
  });

  socket.on('close', () => {
    if (shuttingDown) return;
    log('socket closed, retrying in 5s');
    setTimeout(connect, 5_000).unref();
  });

  socket.on('error', (err: Error) => log('socket error', { err: err.message }));
}

async function main(): Promise<void> {
  // Registration must succeed before the socket opens: the server rejects a
  // hello from an agent id it does not know.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await register();
      break;
    } catch (err) {
      const delay = Math.min(attempt * 2_000, 15_000);
      log('register failed, retrying', {
        err: err instanceof Error ? err.message : String(err),
        delayMs: delay,
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  await loadChannelNames();
  connect();
  const timer = setInterval(() => void heartbeat(), HEARTBEAT_MS);

  // Sweep once at startup so a freshly deployed machine publishes its rules
  // immediately, then on a slow interval — content hashing makes a no-change
  // sweep almost free.
  await runMemorySync();
  const memoryTimer = setInterval(() => void runMemorySync(), MEMORY_SYNC_MS);

  const shutdown = (): void => {
    shuttingDown = true;
    clearInterval(timer);
    clearInterval(memoryTimer);
    running?.kill('SIGTERM');
    socket?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log('daemon failed', { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
