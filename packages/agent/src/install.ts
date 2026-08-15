#!/usr/bin/env node
/**
 * Wire this machine's Claude Code into the hive.
 *
 *   node dist/install.js            show what would change (default)
 *   node dist/install.js --apply    write the changes
 *   node dist/install.js --apply --no-gate    telemetry only, no permission gate
 *   node dist/install.js --apply --remove     unwire hive from settings.json
 *
 * Two things get installed:
 *   1. Hooks in settings.json — telemetry, plus the PreToolUse permission gate.
 *   2. The hive MCP server, so a session can chat, share files and join councils.
 *
 * Dry-run is the default on purpose: this edits a file the user relies on for
 * every session, so nothing is written until it is asked for explicitly.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hooksDir = path.join(here, 'hooks');
const gateScript = path.join(hooksDir, 'hive-gate.mjs');
const eventScript = path.join(hooksDir, 'hive-event.mjs');
const transcriptScript = path.join(hooksDir, 'hive-transcript.mjs');
const usageScript = path.join(hooksDir, 'hive-usage.mjs');
const mcpEntry = path.resolve(here, '../../mcp/dist/index.js');

const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
const settingsPath = path.join(configDir, 'settings.json');

const apply = process.argv.includes('--apply');
const remove = process.argv.includes('--remove');
const withGate = !process.argv.includes('--no-gate');
// Mirroring conversation text is opt-out because it sends prompts and replies
// to the hive, which on an open LAN deployment anything can read.
const withTranscript = !process.argv.includes('--no-transcript');

/** Marker so we can find and remove exactly our entries later. */
const MARKER = 'hive-';

interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookMatcher {
  matcher?: string;
  hooks: HookCommand[];
}
interface Settings {
  hooks?: Record<string, HookMatcher[]>;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  [key: string]: unknown;
}

function readSettings(): Settings {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8')) as Settings;
  } catch (err) {
    throw new Error(
      `${settingsPath} is not valid JSON (${err instanceof Error ? err.message : err}). ` +
        'Fix it before installing so nothing is lost.',
    );
  }
}

const isHiveHook = (entry: HookMatcher): boolean =>
  entry.hooks.some((h) => h.command.includes(MARKER));

/** Drop our entries from one event, leaving anything the user added intact. */
function stripHive(settings: Settings, event: string): void {
  const list = settings.hooks?.[event];
  if (!list) return;
  const kept = list.filter((entry) => !isHiveHook(entry));
  if (kept.length > 0) settings.hooks![event] = kept;
  else delete settings.hooks![event];
}

function addHook(settings: Settings, event: string, command: HookCommand, matcher?: string): void {
  settings.hooks ??= {};
  settings.hooks[event] ??= [];
  settings.hooks[event]!.push(matcher === undefined ? { hooks: [command] } : { matcher, hooks: [command] });
}

function main(): void {
  for (const script of [gateScript, eventScript, transcriptScript, usageScript]) {
    if (!existsSync(script)) {
      throw new Error(`hook script missing: ${script} — run \`npm run build\` first`);
    }
  }

  const settings = readSettings();
  const telemetryEvents = [
    'SessionStart',
    'SessionEnd',
    'UserPromptSubmit',
    'PostToolUse',
    'Stop',
    'Notification',
  ];

  // Always strip first so re-running is idempotent rather than duplicating.
  for (const event of [...telemetryEvents, 'PreToolUse']) stripHive(settings, event);
  if (settings.mcpServers?.hive) delete settings.mcpServers.hive;

  if (!remove) {
    const node = process.execPath;
    for (const event of telemetryEvents) {
      addHook(
        settings,
        event,
        { type: 'command', command: `"${node}" "${eventScript}"`, timeout: 5 },
        event === 'PostToolUse' ? '*' : undefined,
      );
    }

    if (withTranscript) {
      // Runs after the telemetry hook on the same events; reading and diffing a
      // transcript takes longer than a fire-and-forget POST, hence 20s.
      for (const event of ['Stop', 'SessionEnd']) {
        addHook(settings, event, {
          type: 'command',
          command: `"${node}" "${transcriptScript}"`,
          timeout: 20,
        });
      }
    }

    // Token and context accounting. Installed independently of the transcript
    // mirror: it reads the same file but posts only counts, so a fleet that has
    // turned message mirroring off for privacy still gets its usage numbers.
    for (const event of ['Stop', 'SessionEnd']) {
      addHook(settings, event, {
        type: 'command',
        command: `"${node}" "${usageScript}"`,
        timeout: 15,
      });
    }

    if (withGate) {
      addHook(
        settings,
        'PreToolUse',
        // The timeout must exceed HIVE_PERMISSION_TIMEOUT_MS or Claude Code
        // kills the hook before the operator's decision can arrive.
        { type: 'command', command: `"${node}" "${gateScript}"`, timeout: 55 },
        '*',
      );
    }

    if (existsSync(mcpEntry)) {
      settings.mcpServers ??= {};
      settings.mcpServers.hive = { command: node, args: [mcpEntry] };
    } else {
      console.warn(`! MCP entry not built at ${mcpEntry} — skipping MCP registration`);
    }
  }

  const rendered = `${JSON.stringify(settings, null, 2)}\n`;

  if (!apply) {
    console.log(`— dry run — would write ${settingsPath}:\n`);
    console.log(rendered);
    console.log('Re-run with --apply to write it.');
    return;
  }

  // Hooks are launched by Claude Code, not by the user's shell, so they cannot
  // count on exported environment variables. Persist the connection details
  // where every hook can find them.
  const hiveHome = path.join(homedir(), '.hive');
  mkdirSync(hiveHome, { recursive: true });
  const hiveConfig = {
    hiveUrl: (process.env.HIVE_URL || 'http://127.0.0.1:7777').replace(/\/$/, ''),
    token: process.env.HIVE_TOKEN || '',
    agentName: process.env.HIVE_AGENT_NAME || hostname(),
    sessionKey: process.env.HIVE_SESSION_KEY || hostname(),
    transcript: process.env.HIVE_TRANSCRIPT || '1',
    transcriptMode: process.env.HIVE_TRANSCRIPT_MODE || 'full',
  };
  if (!remove) {
    writeFileSync(path.join(hiveHome, 'config.json'), `${JSON.stringify(hiveConfig, null, 2)}\n`);
    console.log(`wrote ${path.join(hiveHome, 'config.json')}`);
  }

  mkdirSync(configDir, { recursive: true });
  if (existsSync(settingsPath)) {
    const backup = `${settingsPath}.hive-backup`;
    copyFileSync(settingsPath, backup);
    console.log(`backed up existing settings to ${backup}`);
  }
  writeFileSync(settingsPath, rendered, 'utf8');

  console.log(remove ? `removed hive wiring from ${settingsPath}` : `wired hive into ${settingsPath}`);
  if (!remove) {
    console.log(`  telemetry hooks: ${telemetryEvents.join(', ')}`);
    console.log(`  transcript sync: ${withTranscript ? 'Stop, SessionEnd' : 'disabled'}`);
    console.log('  usage reporting: Stop, SessionEnd');
    console.log(`  permission gate: ${withGate ? 'PreToolUse (remote approval)' : 'disabled'}`);
    console.log(`  MCP server:      ${existsSync(mcpEntry) ? 'hive' : 'skipped'}`);
    console.log('\nRestart Claude Code for the changes to take effect.');
  }
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
