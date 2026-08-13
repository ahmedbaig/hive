import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { resolveChannel } from '../services/channels.js';
import { MAX_FILE_BYTES, getFile, listFiles, storeFile } from '../services/files.js';
import { actorFrom } from './auth.js';

/**
 * Callers reference channels by name (`memory`) or id (`chn_memory`)
 * interchangeably everywhere else, so files must too — otherwise an upload tagged
 * by name is invisible to a filter by id.
 */
async function channelIdOf(value: string | null | undefined): Promise<string | null> {
  if (!value) return null;
  const channel = await resolveChannel(value);
  return channel?.id ?? value;
}

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/files', async (req) => {
    const { channelId } = req.query as { channelId?: string };
    return { files: await listFiles((await channelIdOf(channelId)) ?? undefined) };
  });

  app.post('/api/files', async (req, reply) => {
    const part = await req.file({ limits: { fileSize: MAX_FILE_BYTES } });
    if (!part) return reply.code(400).send({ error: 'multipart file field required' });

    const actor = actorFrom(req);
    const channelField = part.fields?.channelId;
    const rawChannel =
      channelField && 'value' in channelField && typeof channelField.value === 'string'
        ? channelField.value
        : null;
    const channelId = await channelIdOf(rawChannel);

    try {
      const file = await storeFile({
        filename: part.filename,
        mime: part.mimetype,
        stream: part.file,
        uploadedBy: actor.id,
        uploadedByName: actor.name,
        channelId,
      });
      return { file: { ...file, storedPath: undefined } };
    } catch (err) {
      return reply.code(413).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/files/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = await getFile(id);
    if (!file) return reply.code(404).send({ error: 'unknown file' });

    // Force a download rather than inline rendering — uploads come from agents
    // and rendering arbitrary HTML on the dashboard origin would be a hole.
    await reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', file.size)
      .header(
        'content-disposition',
        `attachment; filename="${file.filename.replace(/["\\]/g, '_')}"`,
      )
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(file.storedPath));
  });

  /** Metadata only, for agents that want the hash before fetching bytes. */
  app.get('/api/files/:id/meta', async (req, reply) => {
    const { id } = req.params as { id: string };
    const file = await getFile(id);
    if (!file) return reply.code(404).send({ error: 'unknown file' });
    return { file: { ...file, storedPath: undefined } };
  });
}
