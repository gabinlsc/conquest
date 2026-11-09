import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { countryCodeSchema, type LeaderboardResponse, type MyRanks } from '@conquest/shared';
import { AppError } from '../http-error';
import { requireUser } from '../plugins/session';
import type { WorldServices } from '../world/services';

const querySchema = z.object({
  country: countryCodeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export function registerLeaderboardRoutes(
  api: FastifyInstance,
  world: WorldServices | undefined,
): void {
  const need = (): WorldServices => {
    if (!world) throw new AppError(503, 'classements indisponibles', 'no_world');
    return world;
  };

  api.get('/season', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=10');
    return need().seasons.current();
  });

  api.get('/seasons', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=60');
    return need().seasons.past();
  });

  for (const board of ['players', 'nations', 'clans'] as const) {
    api.get(`/leaderboards/${board}`, async (req, reply): Promise<LeaderboardResponse> => {
      const w = need();
      const q = querySchema.parse(req.query);
      const season = await w.seasons.current();
      const { entries, total } = await w.leaderboards.top(season.id, board, {
        country: board === 'players' ? q.country : undefined,
        limit: q.limit,
        offset: q.offset,
      });
      reply.header('Cache-Control', 'public, max-age=5');
      return { season, entries, total };
    });
  }

  // Mon rang (joueur + faction) : nécessite une session.
  api.get('/leaderboards/me', async (req, reply): Promise<MyRanks> => {
    const w = need();
    const userId = requireUser(req);
    const season = await w.seasons.current();
    const { rows } = await w.leaderboards.db.query<{
      country_code: string | null;
      faction_id: number | null;
      kind: 'country' | 'clan' | null;
      name: string | null;
    }>(
      `SELECT u.country_code, m.faction_id, f.kind, f.name FROM users u
       LEFT JOIN faction_members m ON m.user_id = u.id LEFT JOIN factions f ON f.id = m.faction_id
       WHERE u.id = $1`,
      [userId],
    );
    const me = rows[0];
    reply.header('Cache-Control', 'no-store');
    const player = await w.leaderboards.rankOf(season.id, 'players', userId);
    const faction =
      me?.faction_id && me.kind && me.name
        ? await w.leaderboards.rankOf(
            season.id,
            me.kind === 'clan' ? 'clans' : 'nations',
            String(me.faction_id),
          )
        : null;
    return {
      player,
      faction: faction && me?.kind && me.name ? { ...faction, kind: me.kind, name: me.name } : null,
    };
  });
}
