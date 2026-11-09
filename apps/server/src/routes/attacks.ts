import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MINIGAME_IDS, type ServerEnv } from '@conquest/shared';
import type { Db } from '../db/pool';
import { getAttack, hashIp, startAttack, submitAttack } from '../attacks/service';
import { AppError } from '../http-error';
import type { Metrics } from '../metrics';
import { requireUser } from '../plugins/session';
import type { WorldServices } from '../world/services';

const startSchema = z.object({
  cityId: z.number().int().positive(),
  minigame: z.enum(MINIGAME_IDS).default('reflex'),
});
const uuid = z.string().uuid();

export function registerAttackRoutes(
  api: FastifyInstance,
  {
    db,
    env,
    world,
    metrics,
  }: {
    db: Db;
    env: Pick<ServerEnv, 'SESSION_SECRET'>;
    world: WorldServices | undefined;
    metrics?: Metrics | undefined;
  },
): void {
  api.post('/attacks', async (req, reply) => {
    const userId = requireUser(req);
    const body = startSchema.parse(req.body);
    // Remise à zéro de saison en cours : on ne lance pas de partie sur une carte qui va changer.
    if (world?.seasons.paused)
      throw new AppError(
        503,
        'changement de saison en cours, réessaie dans un instant',
        'season_rollover',
      );
    reply.header('Cache-Control', 'no-store');
    const started = await startAttack(db, env.SESSION_SECRET, userId, body);
    metrics?.attack('started');
    return reply.code(201).send(started);
  });

  // Le corps est la preuve brute du client (ex. { clicks: [...] }), jamais un score.
  api.post<{ Params: { id: string } }>('/attacks/:id/submit', async (req, reply) => {
    const userId = requireUser(req);
    reply.header('Cache-Control', 'no-store');
    const body = z.object({ input: z.unknown() }).parse(req.body ?? {});
    const attackId = uuid.parse(req.params.id);
    const result = await submitAttack(
      db,
      userId,
      attackId,
      body.input,
      hashIp(env.SESSION_SECRET, req.ip),
    );
    metrics?.attack(result.validated ? 'validated' : 'invalid');
    if (!result.validated || !world) return result;
    // L'effet est appliqué après l'enregistrement du score, de façon idempotente : un client qui réessaie
    // (réponse perdue) ne double jamais l'influence. Si Redis est tombé, l'effet reste « en attente ».
    const effect = await world.effects.applyById(attackId).catch(() => null);
    return { ...result, effect };
  });

  api.get<{ Params: { id: string } }>('/attacks/:id', async (req, reply) => {
    const userId = requireUser(req);
    reply.header('Cache-Control', 'no-store');
    return getAttack(db, userId, uuid.parse(req.params.id));
  });
}
