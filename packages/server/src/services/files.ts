import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { FileTransfer, ID, K } from '@hive/shared';
import { config } from '../config.js';
import { queueWrite } from '../db.js';
import { broadcast } from '../hub.js';
import { log } from '../log.js';
import { fileBytes, filesUploaded } from '../metrics.js';
import { redis } from '../redis.js';

/** Hard ceiling per upload so one agent cannot fill the host disk. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function ensureUploadDir(): Promise<void> {
  await mkdir(config.uploadDir, { recursive: true });
}

/**
 * Store a stream on disk under an opaque id. The original filename is metadata
 * only — it never touches the filesystem path, so a hostile name like
 * `../../.ssh/authorized_keys` cannot escape the upload directory.
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
  const storedPath = path.join(config.uploadDir, id);

  const hash = createHash('sha256');
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
      yield chunk;
    }
  };

  try {
    await pipeline(input.stream, counter, createWriteStream(storedPath));
  } catch (err) {
    await unlink(storedPath).catch(() => {});
    if (overflowed) throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit`);
    throw err;
  }

  const record = FileTransfer.parse({
    id,
    filename: path.basename(input.filename) || 'unnamed',
    mime: input.mime || 'application/octet-stream',
    size,
    sha256: hash.digest('hex'),
    uploadedBy: input.uploadedBy,
    uploadedByName: input.uploadedByName,
    uploadedAt: Date.now(),
    channelId: input.channelId,
    storedPath,
  });

  await redis.hset(K.files, id, JSON.stringify(record));
  broadcast({ t: 'file', file: { ...record, storedPath: '' } });
  filesUploaded.inc();
  fileBytes.inc(size);
  queueWrite(
    `insert into files (id, filename, mime, size, sha256, uploaded_by, uploaded_at, channel_id, stored_path)
     values ($1,$2,$3,$4,$5,$6, to_timestamp($7/1000.0), $8, $9)
     on conflict (id) do nothing`,
    [
      record.id,
      record.filename,
      record.mime,
      record.size,
      record.sha256,
      record.uploadedBy,
      record.uploadedAt,
      record.channelId,
      record.storedPath,
    ],
  );

  log.info({ fileId: id, filename: record.filename, size }, 'file stored');
  return record;
}

export async function getFile(id: string): Promise<FileTransfer | null> {
  const raw = await redis.hget(K.files, id);
  if (!raw) return null;
  const parsed = FileTransfer.safeParse(JSON.parse(raw));
  if (!parsed.success) return null;
  // Guard against a metadata record whose backing blob was removed by hand.
  try {
    await stat(parsed.data.storedPath);
  } catch {
    return null;
  }
  return parsed.data;
}

export async function listFiles(channelId?: string): Promise<FileTransfer[]> {
  const all = await redis.hgetall(K.files);
  const out: FileTransfer[] = [];
  for (const raw of Object.values(all)) {
    const parsed = FileTransfer.safeParse(JSON.parse(raw));
    if (!parsed.success) continue;
    if (channelId && parsed.data.channelId !== channelId) continue;
    out.push({ ...parsed.data, storedPath: '' });
  }
  return out.sort((a, b) => b.uploadedAt - a.uploadedAt);
}
