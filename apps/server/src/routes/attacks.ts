import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MINIGAME_IDS, type ServerEnv } from '@conquest/shared';
import type { Db } from '../db/pool';
import { getAttack, startAttack, submitAttack } from '../attacks/service';
import { requireUser } from '../plugins/session';

const startSchema = z.object({
  cityId: z.number().int().positive(),
  minigame: z.enum(MINIGAME_IDS).default('reflex'),
});
const uuid = z.string().uuid();

export function registerAttackRoutes(
  api: FastifyInstance,
  { db, env }: { db: Db; env: Pick<ServerEnv, 'SESSION_SECRET'> },
): void {
  api.post('/attacks', async (req, reply) => {
    const userId = requireUser(req);
    const body = startSchema.parse(req.body);
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(await startAttack(db, env.SESSION_SECRET, userId, body));
  });

  // Le corps est la preuve brute du client (ex. { clicks: [...] }), jamais un score.
  api.post<{ Params: { id: string } }>('/attacks/:id/submit', async (req, reply) => {
    const userId = requireUser(req);
    reply.header('Cache-Control', 'no-store');
    const body = z.object({ input: z.unknown() }).parse(req.body ?? {});
    return submitAttack(db, userId, uuid.parse(req.params.id), body.input);
  });

  api.get<{ Params: { id: string } }>('/attacks/:id', async (req, reply) => {
    const userId = requireUser(req);
    reply.header('Cache-Control', 'no-store');
    return getAttack(db, userId, uuid.parse(req.params.id));
  });
}
