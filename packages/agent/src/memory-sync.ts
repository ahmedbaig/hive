import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import path from 'node:path';

/**
 * Collect this machine's Claude memory into the hive.
 *
 * Two kinds of file matter: the memory store under
 * `~/.claude/projects/<project>/memory/*.md`, and the CLAUDE.md instruction
 * files that shape how every session behaves. Seeing both for every machine in
 * one place is what makes a fleet legible — otherwise each box has its own
 * private notion of the rules.
 *
 * Uploads are content-addressed: a file whose sha256 is unchanged since the
 * last sweep is skipped, so a five-minute interval costs nothing when nothing
 * has changed.
 */

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
const MAX_BYTES = 512 * 1024;

export interface MemoryFile {
  /** Path as seen on this machine, used as the stable identity of the file. */
  source: string;
  name: string;
  kind: 'memory' | 'instructions' | 'index';
  content: string;
  sha256: string;
  modified: number;
}

async function walk(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
      out.push(...(await walk(full, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

function classify(file: string): MemoryFile['kind'] {
  const base = path.basename(file);
  if (base === 'MEMORY.md') return 'index';
  if (base === 'CLAUDE.md') return 'instructions';
  return 'memory';
}

/** Gather every memory and instruction file this machine exposes. */
export async function collectMemory(extraRoots: string[] = []): Promise<MemoryFile[]> {
  const candidates = new Set<string>();

  // Per-project memory stores.
  const projectsDir = path.join(CONFIG_DIR, 'projects');
  if (existsSync(projectsDir)) {
    for (const file of await walk(projectsDir)) {
      if (file.includes(`${path.sep}memory${path.sep}`)) candidates.add(file);
    }
  }

  // Global and project instruction files.
  const globalClaudeMd = path.join(CONFIG_DIR, 'CLAUDE.md');
  if (existsSync(globalClaudeMd)) candidates.add(globalClaudeMd);
  for (const root of extraRoots) {
    const candidate = path.join(root, 'CLAUDE.md');
    if (existsSync(candidate)) candidates.add(candidate);
  }

  const files: MemoryFile[] = [];
  for (const source of candidates) {
    try {
      const info = await stat(source);
      if (info.size > MAX_BYTES) continue;
      const content = await readFile(source, 'utf8');
      files.push({
        source,
        name: path.basename(source),
        kind: classify(source),
        content,
        sha256: createHash('sha256').update(content).digest('hex'),
        modified: info.mtimeMs,
      });
    } catch {
      // A file that vanished mid-sweep is simply skipped.
    }
  }
  return files.sort((a, b) => a.source.localeCompare(b.source));
}

export interface SyncDeps {
  upload: (file: MemoryFile) => Promise<{ id: string; size: number } | null>;
  post: (body: string, attachments: unknown[], meta: Record<string, unknown>) => Promise<void>;
  event: (type: string, subject: string | null, detail: Record<string, unknown>) => Promise<void>;
  log: (message: string, extra?: Record<string, unknown>) => void;
}

/**
 * One sweep. `seen` maps source path to the sha256 last uploaded, so callers
 * keep it across sweeps and only changed files move.
 */
export async function syncMemory(
  seen: Map<string, string>,
  deps: SyncDeps,
  extraRoots: string[] = [],
): Promise<number> {
  const files = await collectMemory(extraRoots);
  let changed = 0;

  for (const file of files) {
    if (seen.get(file.source) === file.sha256) continue;

    const stored = await deps.upload(file);
    if (!stored) continue;
    seen.set(file.source, file.sha256);
    changed += 1;

    const isNew = !seen.has(file.source);
    await deps.post(
      `**${file.kind}** \`${file.name}\` ${isNew ? 'added' : 'updated'} on ${hostname()}\n\n` +
        `\`${file.source}\``,
      [
        {
          fileId: stored.id,
          filename: file.name,
          size: stored.size,
          mime: 'text/markdown',
          sha256: file.sha256,
        },
      ],
      { source: file.source, kind: file.kind, host: hostname() },
    );
  }

  await deps.event('memory.sync', hostname(), {
    files: files.length,
    changed,
    kinds: files.reduce<Record<string, number>>((acc, f) => {
      acc[f.kind] = (acc[f.kind] ?? 0) + 1;
      return acc;
    }, {}),
  });

  if (changed > 0) deps.log('memory synced', { files: files.length, changed });
  return changed;
}
