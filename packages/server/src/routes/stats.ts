import { StatsReport } from '@hive/shared';
import type { FastifyInstance } from 'fastify';
import { getAgent } from '../services/agents.js';
import { fleetStats, recordUsage } from '../services/stats.js';
import { actorFrom } from './auth.js';

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats', async () => fleetStats());

  /**
   * Usage report from one machine.
   *
   * Answers 202 on a malformed body rather than 400, matching the events sink:
   * this is posted from a Claude Code hook, and a hook that sees an error can
   * surface it into a live session. Losing one usage row is strictly better
   * than interrupting a turn.
   */
  app.post('/api/agents/:id/stats', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await getAgent(id);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });

    const parsed = StatsReport.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(202).send({ ok: false, dropped: true });

    const actor = actorFrom(req);
    const stats = await recordUsage(id, actor.isAgent ? actor.name : agent.name, parsed.data);
    return reply.code(202).send({ ok: true, stats });
  });
}
