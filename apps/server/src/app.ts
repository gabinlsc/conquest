import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { HealthResponse, ServerEnv } from '@conquest/shared';
import { AppError } from './http-error';
import { registerSession } from './plugins/session';
import type { WorldServices } from './world/services';
import { registerAttackRoutes } from './routes/attacks';
import { registerAuthRoutes } from './routes/auth';
import { registerClanRoutes } from './routes/clans';
import { registerEventRoutes } from './routes/events';
import { registerLeaderboardRoutes } from './routes/leaderboards';
import type { Db } from './db/pool';
import { registerCityRoutes } from './routes/cities';

const VERSION = process.env['APP_VERSION'] ?? 'dev';

export interface AppDeps {
  db: Db;
  /** Injectable pour tester le flow OAuth sans réseau. */
  fetchImpl?: typeof fetch;
  /** État chaud du monde (Redis). Absent : l'API sert Postgres en lecture seule. */
  world?: WorldServices;
}

/**
 * Fabrique l'application Fastify. Séparée de `index.ts` pour pouvoir
 * la tester avec `app.inject()` sans ouvrir de port.
 */
export async function buildApp(env: ServerEnv, deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      // Redaction systématique : aucun secret ni cookie dans les logs.
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    // Derrière Caddy : fait confiance à X-Forwarded-For pour l'IP réelle (rate limiting, Phase 5).
    trustProxy: true,
  });

  await app.register(helmet);
  // Plafond global ; des limites plus strictes sont posées route par route (création de compte, etc.).
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    // Par JOUEUR quand il est connecté (et non par IP : un campus ou un VPN partagé ne doit pas se bloquer
    // mutuellement), par IP sinon. `preHandler` : la session est alors déjà résolue.
    hook: 'preHandler',
    keyGenerator: (req) => req.userId ?? req.ip,
    // Compteurs partagés dans Redis (valables si on passe à plusieurs processus) ; sans Redis : mémoire locale.
    // Si Redis tombe en cours de route, on laisse passer plutôt que de refuser tout le trafic.
    ...(deps.world ? { redis: deps.world.store.redis, nameSpace: 'rl:' } : {}),
    skipOnError: true,
  });
  await registerSession(app, env, deps.db);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'requête invalide', issues: err.issues });
    }
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: err.message, code: err.code });
    }
    // Erreurs HTTP des plugins (rate limit 429, JSON invalide 400, etc.) : on garde leur statut.
    const { statusCode, message } = err as { statusCode?: number; message?: string };
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: message });
    req.log.error({ err }, 'erreur non gérée');
    return reply.code(500).send({ error: 'erreur interne' });
  });

  // Toutes les routes REST sont sous /api : le reverse proxy route ce préfixe vers ce service.
  await app.register(
    (api, _opts, done) => {
      api.get('/health', async (): Promise<HealthResponse> => {
        // Mode dégradé : on répond toujours, mais on signale la dépendance tombée.
        const dbUp = await deps.db.query('SELECT 1').then(
          () => true,
          () => false,
        );
        const redisUp = deps.world?.store.isUp() ?? false;
        return {
          status: dbUp && redisUp ? 'ok' : 'degraded',
          uptimeSeconds: Math.round(process.uptime()),
          version: VERSION,
          services: { db: dbUp ? 'up' : 'down', redis: redisUp ? 'up' : 'down' },
        };
      });
      registerCityRoutes(api, deps.db, deps.world);
      registerAuthRoutes(api, { db: deps.db, env, fetchImpl: deps.fetchImpl ?? fetch });
      registerClanRoutes(api, deps.db, deps.world);
      registerEventRoutes(api, deps.world?.events);
      registerLeaderboardRoutes(api, deps.world);
      registerAttackRoutes(api, { db: deps.db, env, world: deps.world });
      done();
    },
    { prefix: '/api' },
  );

  return app;
}
