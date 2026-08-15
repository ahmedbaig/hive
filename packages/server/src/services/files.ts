/**
 * Shared file storage.
 *
 * Bytes live on disk, named by their sha256; Postgres and Redis hold metadata
 * rows that point at them. Blobs are deliberately not stored in Postgres: every
 * multi-megabyte bytea write doubles into the WAL, then into every base backup
 * and every replica stream, and a chat app quietly becomes a storage problem.
 * Small text artifacts are the exception — they are copied inline as well, so a
 * consumer reading Postgres directly (and a range read after a lost disk) still
 * has the content.
 *
 * Content-addressed naming makes dedupe free: agents re-share the same artifact
 * constantly — memory sync alone re-uploads on every edit — and two uploads of
 * identical bytes now produce two metadata rows over one blob.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FileTransfer, type FileChunk, ID, K } from '@hive/shared';
import { config } from '../config.js';
import { query, queueWrite } from '../db.js';
import { broadcast } from '../hub.js';
import { log } from '../log.js';
import { fileBytes, filesDeduped, filesUploaded } from '../metrics.js';
import { redis } from '../redis.js';

/** Hard ceiling per upload so one agent cannot fill the host disk. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Largest slice a single range read will return, whatever the caller asks for. */
export const MAX_RANGE_BYTES = 256 * 1024;

export async function ensureUploadDir(): Promise<void> {
  await mkdir(config.uploadDir, { recursive: true });
}

/** Mime types whose bytes are worth keeping a second copy of inside Postgres. */
function isTextual(mime: string, filename: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (/^application\/(json|xml|x-ndjson|javascript|typescript|x-yaml|yaml)$/.test(mime)) return true;
  return /\.(md|txt|json|jsonl|ya?ml|csv|tsv|log|ts|tsx|js|jsx|py|rs|go|sql|sh|toml|ini|env)$/i.test(
    filename,
  );
}

/**
 * Store a stream on disk under its content hash.
 *
 * The original filename is metadata only — it never touches the filesystem
 * path, so a hostile name like `../../.ssh/authorized_keys` cannot escape the
 * upload directory.
 */
export async function storeFile(input: {
  filename: string;
  mime: string;
  stream: NodeJS.ReadableStream;
  uploadedBy: string;
  uploadedByName: string;
  channelId: string | null;
}): Promise<FileTransfer> {
  await ensureUploadDir();
  const id = ID.file();
  // Hashing happens as the bytes arrive, so the final name is only known once
  // the upload finishes — it lands on a temp path and is renamed into place.
  const tempPath = path.join(config.uploadDir, `.incoming-${id}`);

  const hash = createHash('sha256');
  const inlineChunks: Buffer[] = [];
  let inlineBytes = 0;
  // Once the inline ceiling is passed the copy is abandoned for good; without a
  // latch a later small chunk would fit the budget again and restart it.
  let inlineDropped = false;
  let size = 0;
  let overflowed = false;

  const counter = async function* (source: NodeJS.ReadableStream) {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) {
        overflowed = true;
        throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit`);
      }
      hash.update(chunk);
      // Buffer only up to the inline ceiling, so a 64 MB upload never sits in
      // memory twice.
      if (!inlineDropped && inlineBytes + chunk.length <= config.inlineFileBytes) {
        inlineChunks.push(chunk);
        inlineBytes += chunk.length;
      } else if (!inlineDropped) {
        inlineDropped = true;
        inlineChunks.length = 0;
      }
      yield chunk;
    }
  };

  try {
    await pipeline(input.stream, counter, createWriteStream(tempPath));
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    if (overflowed) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit`);
    throw err;
  }

  const sha256 = hash.digest('hex');
  const filename = path.basename(input.filename) || 'unnamed';
  const mime = input.mime || 'application/octet-stream';

  const { storedPath, deduped } = await placeBlob(sha256, tempPath);

  const inline =
    !inlineDropped && size <= config.inlineFileBytes && isTextual(mime, filename)
      ? Buffer.concat(inlineChunks)
      : null;

  const record = FileTransfer.parse({
    id,
    filename,
    mime,
    size,
    sha256,
    uploadedBy: input.uploadedBy,
    uploadedByName: input.uploadedByName,
    uploadedAt: Date.now(),
    channelId: input.channelId,
    storedPath,
    deduped,
    inlineText: inline !== null,
  });

  await redis.hset(K.files, id, JSON.stringify(record));
  broadcast({ t: 'file', file: redact(record) });
  filesUploaded.inc();
  if (deduped) filesDeduped.inc();
  else fileBytes.inc(size);

  queueWrite(
    `insert into files
       (id, filename, mime, size, sha256, uploaded_by, uploaded_by_name, uploaded_at, channel_id, stored_path, content)
     values ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8/1000.0), $9, $10, $11)
     on conflict (id) do nothing`,
    [
      record.id,
      record.filename,
      record.mime,
      record.size,
      record.sha256,
      record.uploadedBy,
      record.uploadedByName,
      record.uploadedAt,
      record.channelId,
      record.storedPath,
      inline,
    ],
  );

  log.info({ fileId: id, filename: record.filename, size, deduped }, 'file stored');
  return record;
}

/**
 * Move a freshly written upload to its content-addressed home, or drop it when
 * those bytes are already on disk.
 *
 * The registry lookup is advisory — an entry pointing at a blob somebody
 * deleted by hand would otherwise strand every future upload of that content,
 * so a miss on disk falls through to a normal rename.
 */
async function placeBlob(
  sha256: string,
  tempPath: string,
): Promise<{ storedPath: string; deduped: boolean }> {
  const existing = await redis.hget(K.fileBlobs, sha256);
  if (existing) {
    try {
      await stat(existing);
      await unlink(tempPath).catch(() => {});
      return { storedPath: existing, deduped: true };
    } catch {
      log.warn({ sha256, existing }, 'blob registry pointed at a missing file; rewriting');
    }
  }

  const storedPath = path.join(config.uploadDir, `${sha256}.blob`);
  await rename(tempPath, storedPath);
  await redis.hset(K.fileBlobs, sha256, storedPath);
  return { storedPath, deduped: false };
}

/** Metadata as clients see it: never the server-side path. */
const redact = (file: FileTransfer): FileTransfer => ({ ...file, storedPath: '' });

export async function getFile(id: string): Promise<FileTransfer | null> {
  const raw = await redis.hget(K.files, id);
  if (!raw) return null;
  const parsed = FileTransfer.safeParse(JSON.parse(raw));
  if (!parsed.success) return null;
  if (parsed.data.deletedAt !== null) return null;
  // Guard against a metadata record whose backing blob was removed by hand.
  try {
    await stat(parsed.data.storedPath);
  } catch {
    return null;
  }
  return parsed.data;
}

export async function listFiles(
  channelId?: string,
  opts: { includeDeleted?: boolean } = {},
): Promise<FileTransfer[]> {
  const all = await redis.hgetall(K.files);
  const out: FileTransfer[] = [];
  for (const raw of Object.values(all)) {
    const parsed = FileTransfer.safeParse(JSON.parse(raw));
    if (!parsed.success) continue;
    if (!opts.includeDeleted && parsed.data.deletedAt !== null) continue;
    if (channelId && parsed.data.channelId !== channelId) continue;
    out.push(redact(parsed.data));
  }
  return out.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

/**
 * Soft delete. The blob stays: another metadata row may point at the same
 * content hash, and an agent's shared artifact is often the only copy of
 * something produced mid-run. Reclaiming disk is a deliberate, separate job.
 */
export async function deleteFile(id: string): Promise<FileTransfer | null> {
  const raw = await redis.hget(K.files, id);
  if (!raw) return null;
  const parsed = FileTransfer.safeParse(JSON.parse(raw));
  if (!parsed.success) return null;
  const next: FileTransfer = { ...parsed.data, deletedAt: Date.now() };
  await redis.hset(K.files, id, JSON.stringify(next));
  queueWrite('update files set deleted_at = now() where id = $1', [id]);
  broadcast({ t: 'file.remove', fileId: id });
  log.info({ fileId: id }, 'file soft-deleted');
  return redact(next);
}

/**
 * Read a window of a file.
 *
 * Ranges rather than whole files because the consumer is usually a model: one
 * 5 MB log read whole costs more context than the answer it was fetched for.
 * Callers page through with `offset`, and `eof` tells them when to stop.
 */
export async function readFileRange(
  id: string,
  offset: number,
  limit: number,
): Promise<FileChunk | null> {
  const file = await getFile(id);
  if (!file) return null;

  const start = Math.max(0, Math.min(offset, file.size));
  const length = Math.max(0, Math.min(limit, MAX_RANGE_BYTES, file.size - start));

  let buffer: Buffer | null = null;
  if (length > 0) {
    try {
      const chunks: Buffer[] = [];
      const stream = createReadStream(file.storedPath, { start, end: start + length - 1 });
      for await (const chunk of stream as AsyncIterable<Buffer>) chunks.push(chunk);
      buffer = Buffer.concat(chunks);
    } catch (err) {
      log.warn(
        { fileId: id, err: err instanceof Error ? err.message : String(err) },
        'range read from disk failed; trying inline copy',
      );
      buffer = await inlineSlice(id, start, length);
      if (!buffer) return null;
    }
  } else {
    buffer = Buffer.alloc(0);
  }

  return {
    fileId: file.id,
    filename: file.filename,
    offset: start,
    length: buffer.length,
    size: file.size,
    eof: start + buffer.length >= file.size,
    text: decodeText(buffer),
  };
}

/** Fallback path: the Postgres copy kept for small text artifacts. */
async function inlineSlice(id: string, start: number, length: number): Promise<Buffer | null> {
  const rows = await query<{ content: Buffer | null }>(
    'select content from files where id = $1 and content is not null',
    [id],
  );
  const content = rows[0]?.content;
  if (!content) return null;
  return content.subarray(start, start + length);
}

/**
 * Decode a slice as UTF-8, or refuse.
 *
 * A slice can end mid-codepoint, which is fine — that is one replacement char
 * at the boundary. A slice full of them is binary, and handing a model a wall
 * of `�` is worse than telling it the file is not text.
 */
function decodeText(buffer: Buffer): string | null {
  if (buffer.length === 0) return '';
  // A NUL byte early in the slice is the cheap, reliable "this is binary" tell.
  if (buffer.subarray(0, 1024).includes(0)) return null;
  const text = buffer.toString('utf8');
  const replacements = (text.match(/�/g) ?? []).length;
  if (replacements > 4 && replacements / text.length > 0.01) return null;
  return text;
}
