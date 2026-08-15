import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { PermissionReply } from '@hive/shared';
import Fastify from 'fastify';
import { refreshGauges } from './collectors.js';
import { config } from './config.js';
import { closeDb, hasDb, initDb } from './db.js';
import { setDecisionHandler, startPubSub } from './hub.js';
import { log } from './log.js';
import {
  httpDuration,
  httpRequests,
  registry,
  routeLabel,
  startBusySampler,
} from './metrics.js';
import { closeRedis, redis } from './redis.js';
import { agentRoutes } from './routes/agents.js';
import { requireAuth } from './routes/auth.js';
import { chatRoutes } from './routes/chat.js';
import { councilRoutes } from './routes/council.js';
import { eventRoutes } from './routes/events.js';
import { fileRoutes } from './routes/files.js';
import { permissionRoutes } from './routes/permissions.js';
import { statsRoutes } from './routes/stats.js';
import { wsRoutes } from './routes/ws.js';
import { listAgents, startPresenceSweep } from './services/agents.js';
import { ensureDefaultChannels } from './services/channels.js';
import { ensureUploadDir } from './services/files.js';
import { resolveLocalWaiter } from './services/permissions.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const app = Fastify({
    logger: false,
    // Agents post whole file contents in messages; the default 1 MB is tight.
    bodyLimit: 8 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  await app.register(multipart);

  // Auth guards the API surface. The WebSocket route checks its own token in
  // the hello frame, and /health stays open so a container probe works.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/api/')) await requireAuth(req, reply);
  });

  // Request-level metrics. The route label comes from Fastify's matched path,
  // so `/api/agents/agt_abc/inbox` collapses to `/api/agents/:id/inbox` and a
  // scanner hitting random URLs cannot explode the series count.
  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/metrics')) return;
    const labels = {
      method: req.method,
      route: routeLabel(req.url, req.routeOptions?.url),
      status: String(reply.statusCode),
    };
    httpRequests.inc(labels);
    httpDuration.observe(labels, reply.elapsedTime / 1000);
  });

  /**
   * Prometheus scrape target. Left unauthenticated even when HIVE_TOKEN is set:
   * Prometheus scrape configs commonly carry no credentials, and the exposed
   * data is operational metadata — agent names, tool names, counts — not
   * message bodies or tool arguments.
   */
  app.get('/metrics', async (_req, reply) => {
    await refreshGauges();
    return reply
      .header('content-type', registry.contentType)
      .send(await registry.metrics());
  });

  app.get('/health', async () => {
    let redisOk = false;
    try {
      redisOk = (await redis.ping()) === 'PONG';
    } catch {
      redisOk = false;
    }
    return {
      ok: redisOk,
      redis: { ok: redisOk, db: config.redis.db, host: config.redis.host },
      postgres: { configured: hasDb() },
      uptimeSeconds: Math.round(process.uptime()),
    };
  });

  await app.register(agentRoutes);
  await app.register(chatRoutes);
  await app.register(permissionRoutes);
  await app.register(councilRoutes);
  await app.register(fileRoutes);
  await app.register(eventRoutes);
  await app.register(statsRoutes);
  await app.register(wsRoutes);

  // Serve the built SPA when it exists, so one process covers API and UI in
  // production. In dev the Vite server proxies here instead.
  const webDist = path.resolve(here, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/ws')) {
        return reply.code(404).send({ error: 'not found' });
      }
      return reply.sendFile('index.html');
    });
    log.info({ webDist }, 'serving built SPA');
  } else {
    log.info('web/dist not built — API only, run the Vite dev server for the UI');
  }

  // Permission decisions taken on a sibling instance arrive over pub/sub and
  // are handed to whichever process holds the blocked hook.
  setDecisionHandler((permissionId, reply) => {
    const parsed = PermissionReply.safeParse(reply);
    if (parsed.success) resolveLocalWaiter(permissionId, parsed.data);
  });

  await initDb();
  await ensureUploadDir();
  await ensureDefaultChannels();
  await startPubSub();
  const sweep = startPresenceSweep();
  const busySampler = startBusySampler(async () =>
    (await listAgents()).map((a) => ({ id: a.id, status: a.status })),
  );

  await app.listen({ host: config.host, port: config.port });
  log.info(
    {
      url: `http://${config.host}:${config.port}`,
      publicUrl: config.publicUrl,
      redisDb: config.redis.db,
      postgres: hasDb() ? 'connected' : 'disabled',
      auth: config.token ? 'token required' : 'open (LAN trust)',
    },
    'hive server listening',
  );

  const shutdown = async (signal: string): Promise<void> => {
    log.info({ signal }, 'shutting down');
    clearInterval(sweep);
    clearInterval(busySampler);
    await app.close();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error({ err: err instanceof Error ? err.stack : String(err) }, 'server failed to start');
  process.exit(1);
});
