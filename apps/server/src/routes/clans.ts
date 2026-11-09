import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clansQuerySchema, createClanSchema, joinClanSchema } from '@conquest/shared';
import type { Db } from '../db/pool';
import { AppError } from '../http-error';
import { createClan, getClan, joinClan, leaveClan, listClans } from '../factions/service';
import { requireUser } from '../plugins/session';
import type { WorldServices } from '../world/services';

const idParam = z.coerce.number().int().positive();

export function registerClanRoutes(
  api: FastifyInstance,
  db: Db,
  world: WorldServices | undefined,
): void {
  api.get('/clans', async (req) => listClans(db, clansQuerySchema.parse(req.query)));

  api.get<{ Params: { id: string } }>('/clans/:id', async (req) => {
    const clan = await getClan(db, idParam.parse(req.params.id));
    if (!clan) throw new AppError(404, 'clan introuvable');
    return clan;
  });

  api.post(
    '/clans',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const userId = requireUser(req);
      const id = await createClan(db, userId, createClanSchema.parse(req.body));
      return reply.code(201).send({ id });
    },
  );

  api.post<{ Params: { id: string } }>(
    '/clans/:id/join',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, // freine le brute-force des codes d'invitation
    async (req, reply) => {
      const userId = requireUser(req);
      const body = joinClanSchema.parse(req.body ?? {});
      await joinClan(db, userId, idParam.parse(req.params.id), body.inviteCode);
      return reply.code(204).send();
    },
  );

  api.post('/clans/leave', async (req) => {
    const userId = requireUser(req);
    const { disbanded, clanId } = await leaveClan(db, userId);
    // Clan dissous : ses villes reviennent à leur pays dans l'état chaud (Redis) et sur les cartes ouvertes.
    if (disbanded && world) await world.effects.onFactionDisbanded(clanId).catch(() => undefined);
    return { disbanded };
  });
}
