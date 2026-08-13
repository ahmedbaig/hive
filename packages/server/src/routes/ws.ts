import { InboundFrame, type OutboundFrame } from '@hive/shared';
import type { FastifyInstance } from 'fastify';
import { addConnection, removeConnection, sendTo } from '../hub.js';
import { log } from '../log.js';
import { getAgent, listAgents, touch, updateAgent } from '../services/agents.js';
import { listChannels } from '../services/channels.js';
import { drainCommands } from '../services/commands.js';
import { getKillSwitch, listPending } from '../services/permissions.js';
import { checkToken } from './auth.js';

/** Drop a socket that never completes the hello handshake. */
const HELLO_TIMEOUT_MS = 10_000;

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const conn = addConnection(socket);
    let helloDone = false;

    const helloTimer = setTimeout(() => {
      if (!helloDone) {
        sendTo(conn, { t: 'error', message: 'hello frame required' });
        socket.close(4001, 'no hello');
      }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref();

    socket.on('message', (raw: Buffer) => {
      void (async () => {
        let frame: InboundFrame;
        try {
          frame = InboundFrame.parse(JSON.parse(raw.toString()));
        } catch {
          sendTo(conn, { t: 'error', message: 'malformed frame' });
          return;
        }

        switch (frame.t) {
          case 'hello': {
            // The header form covers browsers behind a proxy that strips custom
            // headers; the frame field covers agent daemons.
            if (!checkToken(frame.token ?? req.headers.authorization)) {
              sendTo(conn, { t: 'error', message: 'unauthorized' });
              socket.close(4003, 'unauthorized');
              return;
            }
            helloDone = true;
            clearTimeout(helloTimer);
            conn.kind = frame.as;
            conn.name = frame.name;

            if (frame.as === 'agent') {
              if (!frame.agentId || !(await getAgent(frame.agentId))) {
                sendTo(conn, { t: 'error', message: 'register before opening a socket' });
                socket.close(4004, 'unknown agent');
                return;
              }
              conn.agentId = frame.agentId;
              await touch(frame.agentId);
            }

            const welcome: OutboundFrame = {
              t: 'welcome',
              connectionId: conn.id,
              serverTime: Date.now(),
              agents: await listAgents(),
              channels: await listChannels(),
              pendingPermissions: await listPending(),
              killSwitch: await getKillSwitch(),
            };
            sendTo(conn, welcome);

            // Anything issued while this daemon was detached is replayed now.
            if (conn.agentId) {
              for (const command of await drainCommands(conn.agentId)) {
                sendTo(conn, { t: 'command', command });
              }
            }
            return;
          }

          case 'subscribe': {
            conn.channels = new Set(frame.channels);
            return;
          }

          case 'status': {
            if (!conn.agentId) return;
            await touch(conn.agentId);
            await updateAgent(conn.agentId, {
              status: frame.status,
              activity: frame.activity,
            });
            return;
          }

          case 'ping': {
            if (conn.agentId) await touch(conn.agentId);
            sendTo(conn, { t: 'pong', serverTime: Date.now() });
            return;
          }
        }
      })().catch((err) => log.error({ err: String(err) }, 'ws frame handling failed'));
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      const closed = removeConnection(conn.id);
      if (closed?.agentId) {
        log.info({ agentId: closed.agentId }, 'agent socket closed');
      }
    });

    socket.on('error', (err: Error) => {
      log.warn({ err: err.message }, 'ws error');
      removeConnection(conn.id);
    });
  });
}
