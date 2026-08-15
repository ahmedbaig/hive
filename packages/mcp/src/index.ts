#!/usr/bin/env node
/**
 * Hive MCP server — the surface a Claude Code session uses to take part in the
 * fleet: read the roster, chat, share files, and join councils.
 *
 * Wire it up with:
 *   claude mcp add hive -- node /path/to/hive/packages/mcp/dist/index.js
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type {
  AgentRecord,
  Channel,
  Council,
  FileChunk,
  FileTransfer,
  FleetStats,
  Message,
} from '@hive/shared';
import { z } from 'zod';
import { AGENT_NAME, HIVE_URL, ensureIdentity, hiveFetch, hivePost } from './client.js';

const server = new McpServer({ name: 'hive', version: '0.1.0' });

/** Every tool returns text; keep the shape in one place. */
const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });
const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: `error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

/* ── Identity and roster ─────────────────────────────────────────────────── */

server.registerTool(
  'hive_whoami',
  {
    title: 'Who am I in the hive',
    description:
      'Register this Claude session with the hive (idempotent) and return its agent id and name. ' +
      'Call this once before using other hive tools if you want the id.',
    inputSchema: {},
  },
  async () => {
    try {
      const me = await ensureIdentity();
      return text(JSON.stringify({ ...me, server: HIVE_URL }, null, 2));
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_roster',
  {
    title: 'List fleet agents',
    description:
      'List every Claude agent known to the hive, with host, status (idle/working/waiting_approval/paused/offline) ' +
      'and what each is currently doing.',
    inputSchema: {
      onlineOnly: z.boolean().default(false).describe('Skip agents whose heartbeat has expired'),
    },
  },
  async ({ onlineOnly }) => {
    try {
      await ensureIdentity();
      const { agents } = await hiveFetch<{ agents: AgentRecord[] }>('/api/agents');
      const list = onlineOnly ? agents.filter((a) => a.status !== 'offline') : agents;
      return text(
        JSON.stringify(
          list.map((a) => ({
            id: a.id,
            name: a.name,
            host: a.host,
            status: a.status,
            role: a.role,
            cwd: a.cwd,
            activity: a.activity,
            tags: a.tags,
          })),
          null,
          2,
        ),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

/* ── Chat ────────────────────────────────────────────────────────────────── */

server.registerTool(
  'hive_channels',
  {
    title: 'List channels',
    description:
      'List hive chat channels with what each one is for: id, name, kind (group/direct/council/system), ' +
      'purpose (the standing charter) and topic (the current focus). Read the purpose before posting — ' +
      'it is what the channel is actually for.',
    inputSchema: {
      includeArchived: z.boolean().default(false).describe('Include archived channels'),
    },
  },
  async ({ includeArchived }) => {
    try {
      await ensureIdentity();
      const { channels } = await hiveFetch<{ channels: Channel[] }>('/api/channels');
      const list = includeArchived ? channels : channels.filter((c) => !c.archived);
      return text(
        JSON.stringify(
          list.map((c) => ({
            id: c.id,
            name: c.name,
            kind: c.kind,
            purpose: c.description,
            topic: c.topic,
            archived: c.archived,
          })),
          null,
          2,
        ),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_channel_context',
  {
    title: 'What is this channel for',
    description:
      'Return the standing context block for a channel — its purpose, current topic and participants. ' +
      'Call this before answering in a channel you have not spoken in, so your reply is on-topic.',
    inputSchema: { channel: z.string().describe('Channel id or name') },
  },
  async ({ channel }) => {
    try {
      await ensureIdentity();
      const { context } = await hiveFetch<{ context: string }>(
        `/api/channels/${encodeURIComponent(channel)}/context`,
      );
      return text(context);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_channel_topic',
  {
    title: 'Set the current topic of a channel',
    description:
      "Update a channel's current topic — what the fleet is working on in it right now. The purpose " +
      '(the standing charter) is the operator\'s to set and is deliberately not editable here.',
    inputSchema: {
      channel: z.string().describe('Channel id or name'),
      topic: z.string().max(300).describe('Short line describing the current focus'),
    },
  },
  async ({ channel, topic }) => {
    try {
      await ensureIdentity();
      await hiveFetch(`/api/channels/${encodeURIComponent(channel)}`, {
        method: 'PATCH',
        body: JSON.stringify({ topic }),
      });
      return text(`topic set on ${channel}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_send',
  {
    title: 'Send a message',
    description:
      'Post a message to a hive channel so other Claude agents and the human operator see it. ' +
      'Use mentions to address specific agents by name or id; "@all" reaches everyone in the channel.',
    inputSchema: {
      channel: z.string().default('lobby').describe('Channel id or name, e.g. "lobby" or "ops"'),
      body: z.string().min(1).describe('Message text (markdown is fine)'),
      mentions: z
        .array(z.string())
        .default([])
        .describe('Agent names or ids to address directly, or ["@all"]'),
      replyTo: z.string().nullable().default(null).describe('Message id this replies to'),
    },
  },
  async ({ channel, body, mentions, replyTo }) => {
    try {
      await ensureIdentity();
      const { message } = await hivePost<{ message: Message }>(
        `/api/channels/${encodeURIComponent(channel)}/messages`,
        { body, mentions, replyTo },
      );
      return text(`sent (${message.id}) to ${channel}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_read',
  {
    title: 'Read channel history',
    description:
      'Read recent messages from a hive channel, oldest first. The channel\'s purpose and current ' +
      'topic are included first, so you know what the conversation is for before you read it.',
    inputSchema: {
      channel: z.string().default('lobby').describe('Channel id or name'),
      limit: z.number().int().min(1).max(200).default(50),
      withContext: z.boolean().default(true).describe('Prepend the channel purpose block'),
    },
  },
  async ({ channel, limit, withContext }) => {
    try {
      await ensureIdentity();
      const [{ messages }, context] = await Promise.all([
        hiveFetch<{ messages: Message[] }>(
          `/api/channels/${encodeURIComponent(channel)}/messages?limit=${limit}`,
        ),
        withContext
          ? hiveFetch<{ context: string }>(`/api/channels/${encodeURIComponent(channel)}/context`)
              .then((r) => r.context)
              // The transcript is the point; a missing charter must not fail the read.
              .catch(() => '')
          : Promise.resolve(''),
      ]);
      const body =
        messages.length === 0
          ? '(no messages)'
          : messages
              .map((m) => `[${new Date(m.ts).toISOString()}] ${m.authorName}: ${m.body}`)
              .join('\n');
      return text(context ? `${context}\n\n---\n\n${body}` : body);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_inbox',
  {
    title: 'Read my unread messages',
    description:
      'Drain this agent\'s unread hive messages — anything addressed to it or posted in a channel it belongs to. ' +
      'Reading clears the queue unless peek is true. Call this when you want to know what the fleet has said to you.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).default(50),
      peek: z.boolean().default(false).describe('Leave messages in the queue'),
    },
  },
  async ({ limit, peek }) => {
    try {
      const me = await ensureIdentity();
      const { messages, remaining } = await hiveFetch<{ messages: Message[]; remaining: number }>(
        `/api/agents/${me.agentId}/inbox?limit=${limit}&peek=${peek ? 1 : 0}`,
      );
      if (messages.length === 0) return text('(inbox empty)');
      const rendered = messages
        .map((m) => `[${m.channelId}] ${m.authorName}: ${m.body}`)
        .join('\n');
      return text(`${rendered}\n\n(${remaining} still queued)`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_wait',
  {
    title: 'Wait for a message',
    description:
      'Block until a new message arrives for this agent, or the timeout expires. Use this to sit in a listening ' +
      'loop instead of polling hive_inbox. Returns the messages received, or "(timeout)" if none arrived.',
    inputSchema: {
      timeoutSeconds: z.number().int().min(5).max(280).default(60),
    },
  },
  async ({ timeoutSeconds }) => {
    try {
      const me = await ensureIdentity();
      const deadline = Date.now() + timeoutSeconds * 1_000;
      // Poll rather than hold a socket: an MCP tool call is short-lived and a
      // dropped connection here would surface as a tool error to the model.
      while (Date.now() < deadline) {
        const { messages } = await hiveFetch<{ messages: Message[] }>(
          `/api/agents/${me.agentId}/inbox?limit=50`,
        );
        if (messages.length > 0) {
          return text(messages.map((m) => `[${m.channelId}] ${m.authorName}: ${m.body}`).join('\n'));
        }
        await sleep(Math.min(2_000, Math.max(0, deadline - Date.now())));
      }
      return text('(timeout)');
    } catch (err) {
      return fail(err);
    }
  },
);

/* ── Files ───────────────────────────────────────────────────────────────── */

server.registerTool(
  'hive_share_file',
  {
    title: 'Share a file with the fleet',
    description:
      'Upload a local file to the hive so other agents and the operator can download it. Returns the file id.',
    inputSchema: {
      filePath: z.string().describe('Absolute path of the file to share'),
      channel: z.string().nullable().default(null).describe('Channel to attach it to, optional'),
      note: z.string().default('').describe('Message to post alongside the file'),
    },
  },
  async ({ filePath, channel, note }) => {
    try {
      await ensureIdentity();
      const bytes = await readFile(filePath);
      const form = new FormData();
      if (channel) form.append('channelId', channel);
      form.append('file', new Blob([new Uint8Array(bytes)]), path.basename(filePath));

      const res = await hiveFetch<{ file: FileTransfer }>('/api/files', {
        method: 'POST',
        body: form,
      });

      if (channel) {
        await hivePost(`/api/channels/${encodeURIComponent(channel)}/messages`, {
          body: note || `shared ${res.file.filename}`,
          attachments: [
            {
              fileId: res.file.id,
              filename: res.file.filename,
              size: res.file.size,
              mime: res.file.mime,
              sha256: res.file.sha256,
            },
          ],
        });
      }
      return text(`shared ${res.file.filename} as ${res.file.id} (${res.file.size} bytes)`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_fetch_file',
  {
    title: 'Download a shared file',
    description: 'Download a file another agent shared, by id, writing it to a local path.',
    inputSchema: {
      fileId: z.string().describe('File id from hive_list_files or a message attachment'),
      destination: z.string().describe('Absolute path to write the file to'),
    },
  },
  async ({ fileId, destination }) => {
    try {
      await ensureIdentity();
      const res = await fetch(`${HIVE_URL}/api/files/${encodeURIComponent(fileId)}`);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      await writeFile(destination, buffer);
      return text(`wrote ${buffer.length} bytes to ${destination}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_file_read',
  {
    title: 'Read part of a shared file',
    description:
      'Read a window of a shared file as text, without downloading it. Use this instead of ' +
      'hive_fetch_file when you only need to look at the content: one large log read whole costs ' +
      'more context than the answer you are after. Page through with `offset` until `eof` is true.',
    inputSchema: {
      fileId: z.string().describe('File id from hive_list_files or a message attachment'),
      offset: z.number().int().min(0).default(0).describe('Byte offset to start at'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(256 * 1024)
        .default(32_768)
        .describe('Bytes to read, capped server-side'),
    },
  },
  async ({ fileId, offset, limit }) => {
    try {
      await ensureIdentity();
      const { chunk } = await hiveFetch<{ chunk: FileChunk }>(
        `/api/files/${encodeURIComponent(fileId)}/range?offset=${offset}&limit=${limit}`,
      );
      if (chunk.text === null) {
        return text(
          `${chunk.filename}: bytes ${chunk.offset}–${chunk.offset + chunk.length} of ${chunk.size} ` +
            'are binary, not text. Use hive_fetch_file to write it to disk instead.',
        );
      }
      const header =
        `${chunk.filename} · bytes ${chunk.offset}–${chunk.offset + chunk.length} of ${chunk.size}` +
        `${chunk.eof ? ' · end of file' : ` · continue at offset ${chunk.offset + chunk.length}`}`;
      return text(`${header}\n\n${chunk.text}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_file_delete',
  {
    title: 'Remove a shared file',
    description:
      'Soft-delete a shared file so it stops appearing in the fleet\'s file list. The bytes are kept ' +
      'server-side, so this is reversible by the operator.',
    inputSchema: { fileId: z.string() },
  },
  async ({ fileId }) => {
    try {
      await ensureIdentity();
      await hiveFetch(`/api/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
      return text(`removed ${fileId}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_list_files',
  {
    title: 'List shared files',
    description: 'List files shared into the hive, newest first.',
    inputSchema: { channel: z.string().nullable().default(null) },
  },
  async ({ channel }) => {
    try {
      await ensureIdentity();
      const { files } = await hiveFetch<{ files: FileTransfer[] }>(
        `/api/files${channel ? `?channelId=${encodeURIComponent(channel)}` : ''}`,
      );
      return text(
        JSON.stringify(
          files.map((f) => ({
            id: f.id,
            filename: f.filename,
            size: f.size,
            sha256: f.sha256,
            by: f.uploadedByName,
          })),
          null,
          2,
        ),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

/* ── Council ─────────────────────────────────────────────────────────────── */

server.registerTool(
  'hive_council_list',
  {
    title: 'List councils',
    description:
      'List hive councils — structured debates the fleet holds on a decision — with their current phase and votes.',
    inputSchema: { openOnly: z.boolean().default(true) },
  },
  async ({ openOnly }) => {
    try {
      await ensureIdentity();
      const { councils } = await hiveFetch<{ councils: Council[] }>('/api/councils');
      const list = openOnly ? councils.filter((c) => c.phase !== 'closed') : councils;
      return text(
        JSON.stringify(
          list.map((c) => ({
            id: c.id,
            topic: c.topic,
            question: c.question,
            phase: c.phase,
            round: `${c.round}/${c.maxRounds}`,
            options: c.options,
            channelId: c.channelId,
            votes: c.votes.map((v) => ({ by: v.agentName, option: v.option })),
            verdict: c.verdict,
          })),
          null,
          2,
        ),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_council_open',
  {
    title: 'Convene a council',
    description:
      'Open a new council so the fleet can debate a question and vote on it. Creates a dedicated channel.',
    inputSchema: {
      topic: z.string().min(1).max(60).describe('Short slug, e.g. "db-choice"'),
      question: z.string().min(1).describe('The question to debate'),
      options: z.array(z.string()).default([]).describe('Vote options, blank for free-form'),
      participants: z.array(z.string()).default([]).describe('Agent ids to invite'),
      maxRounds: z.number().int().min(1).max(10).default(3),
    },
  },
  async (args) => {
    try {
      await ensureIdentity();
      const { council } = await hivePost<{ council: Council }>('/api/councils', args);
      return text(`council ${council.id} opened in channel ${council.channelId}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_council_join',
  {
    title: 'Join a council',
    description: 'Add this agent to a council so it can speak and vote.',
    inputSchema: { councilId: z.string() },
  },
  async ({ councilId }) => {
    try {
      const me = await ensureIdentity();
      await hivePost(`/api/councils/${councilId}/join`, { agentId: me.agentId });
      return text(`joined ${councilId}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_council_speak',
  {
    title: 'Speak in a council',
    description:
      'Contribute an argument to a council debate. Posts into the council transcript attributed to this agent.',
    inputSchema: { councilId: z.string(), body: z.string().min(1) },
  },
  async ({ councilId, body }) => {
    try {
      await ensureIdentity();
      await hivePost(`/api/councils/${councilId}/speak`, { body });
      return text('spoken');
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_council_vote',
  {
    title: 'Vote in a council',
    description:
      'Cast this agent\'s vote in a council. One vote per agent — voting again replaces the earlier vote.',
    inputSchema: {
      councilId: z.string(),
      option: z.string().min(1),
      rationale: z.string().default(''),
    },
  },
  async ({ councilId, option, rationale }) => {
    try {
      await ensureIdentity();
      await hivePost(`/api/councils/${councilId}/vote`, { option, rationale });
      return text(`voted ${option}`);
    } catch (err) {
      return fail(err);
    }
  },
);

/* ── Commanding other machines ───────────────────────────────────────────── */

server.registerTool(
  'hive_command',
  {
    title: 'Send a command to another agent',
    description:
      'Direct another machine in the fleet. "wake" starts a fresh headless Claude run there with your ' +
      'prompt and reports the result back into a channel; "stop" interrupts its current run; "ping" checks ' +
      'it is alive. Use hive_roster first to get agent ids. Waking a machine spends real tokens on it, so ' +
      'send a specific, self-contained prompt.',
    inputSchema: {
      agentId: z.string().describe('Target agent id from hive_roster'),
      kind: z.enum(['wake', 'stop', 'pause', 'resume', 'ping']).default('ping'),
      payload: z.string().default('').describe('Prompt text for wake, reason for pause/stop'),
      replyChannel: z
        .string()
        .default('lobby')
        .describe('Channel the target reports its result into'),
    },
  },
  async ({ agentId, kind, payload, replyChannel }) => {
    try {
      await ensureIdentity();
      if (kind === 'wake' && !payload.trim()) {
        return fail(new Error('wake needs a prompt in `payload`'));
      }
      await hivePost(`/api/agents/${encodeURIComponent(agentId)}/commands`, {
        kind,
        payload,
        replyChannelId: replyChannel,
      });
      return text(
        kind === 'wake'
          ? `wake sent to ${agentId}; it will report into #${replyChannel} when finished`
          : `${kind} sent to ${agentId}`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_memory',
  {
    title: 'Read memory collected from the fleet',
    description:
      'List the CLAUDE.md and memory files the hive has collected from every machine, so you can see what ' +
      'rules and context the other agents are operating under. Use hive_fetch_file to read one.',
    inputSchema: {},
  },
  async () => {
    try {
      await ensureIdentity();
      const { files } = await hiveFetch<{ files: FileTransfer[] }>('/api/files?channelId=chn_memory');
      if (files.length === 0) return text('(no memory files collected yet)');
      return text(
        JSON.stringify(
          files.map((f) => ({
            id: f.id,
            filename: f.filename,
            from: f.uploadedByName,
            size: f.size,
            uploadedAt: new Date(f.uploadedAt).toISOString(),
          })),
          null,
          2,
        ),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

/* ── Status ──────────────────────────────────────────────────────────────── */

server.registerTool(
  'hive_status',
  {
    title: 'Report what I am doing',
    description:
      'Update this agent\'s status line on the operator dashboard so the human can see what it is working on.',
    inputSchema: {
      status: z.enum(['idle', 'working', 'waiting_approval', 'paused']).default('working'),
      activity: z.string().max(200).describe('Short description of current work'),
    },
  },
  async ({ status, activity }) => {
    try {
      const me = await ensureIdentity();
      await hivePost(`/api/agents/${me.agentId}/heartbeat`, { status, activity });
      return text('status updated');
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  'hive_stats',
  {
    title: 'Fleet context and token usage',
    description:
      'How much context each machine in the fleet is holding, and what the fleet has spent in the ' +
      'current rolling window. Useful before waking another agent: a machine already near its ' +
      'context ceiling will do a worse job of a large task than one that just started.',
    inputSchema: {},
  },
  async () => {
    try {
      await ensureIdentity();
      const stats = await hiveFetch<FleetStats>('/api/stats');
      return text(
        JSON.stringify(
          {
            window: {
              hours: Math.round(stats.window.windowMs / 3_600_000),
              totalTokens: stats.window.totalTokens,
              turns: stats.window.turns,
              resetsAt: stats.window.resetsAt
                ? new Date(stats.window.resetsAt).toISOString()
                : null,
              note: 'derived from observed spend, not from API rate-limit headers',
            },
            memory: stats.memory,
            agents: stats.agents.map((a) => ({
              name: a.agentName,
              status: a.status,
              contextUsed: a.stats?.contextUsed ?? null,
              contextMax: a.stats?.contextMax ?? null,
              contextPct: a.stats
                ? Math.round((a.stats.contextUsed / a.stats.contextMax) * 100)
                : null,
              model: a.stats?.model ?? null,
              windowTokens: a.window.totalTokens,
            })),
          },
          null,
          2,
        ),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP transport — every diagnostic must go to stderr.
  process.stderr.write(`hive-mcp connected to ${HIVE_URL} as ${AGENT_NAME}\n`);
}

main().catch((err) => {
  process.stderr.write(`hive-mcp failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
