import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  advanceCouncil,
  castVote,
  getCouncil,
  joinCouncil,
  listCouncils,
  openCouncil,
  speak,
} from '../services/council.js';
import { actorFrom } from './auth.js';

export async function councilRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/councils', async () => ({ councils: await listCouncils() }));

  app.get('/api/councils/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const council = await getCouncil(id);
    if (!council) return reply.code(404).send({ error: 'unknown council' });
    return { council };
  });

  app.post('/api/councils', async (req, reply) => {
    const parsed = z
      .object({
        topic: z.string().min(1).max(60),
        question: z.string().min(1).max(2_000),
        options: z.array(z.string()).default([]),
        participants: z.array(z.string()).default([]),
        maxRounds: z.number().int().min(1).max(10).default(3),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid council', detail: parsed.error.flatten() });
    }
    const actor = actorFrom(req);
    const council = await openCouncil({ ...parsed.data, createdBy: actor.name });
    return { council };
  });

  app.post('/api/councils/:id/join', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ agentId: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'agentId required' });
    const council = await joinCouncil(id, parsed.data.agentId);
    if (!council) return reply.code(404).send({ error: 'unknown council' });
    return { council };
  });

  app.post('/api/councils/:id/advance', async (req, reply) => {
    const { id } = req.params as { id: string };
    const council = await advanceCouncil(id);
    if (!council) return reply.code(404).send({ error: 'unknown council' });
    return { council };
  });

  app.post('/api/councils/:id/speak', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z.object({ body: z.string().min(1).max(32_000) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'body required' });
    const actor = actorFrom(req);
    try {
      const council = await speak({
        councilId: id,
        agentId: actor.id,
        agentName: actor.name,
        body: parsed.data.body,
      });
      if (!council) return reply.code(404).send({ error: 'unknown council' });
      return { council };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/councils/:id/vote', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = z
      .object({ option: z.string().min(1), rationale: z.string().default('') })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'option required' });
    const actor = actorFrom(req);
    try {
      const council = await castVote({
        councilId: id,
        agentId: actor.id,
        agentName: actor.name,
        option: parsed.data.option,
        rationale: parsed.data.rationale,
      });
      if (!council) return reply.code(404).send({ error: 'unknown council' });
      return { council };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
