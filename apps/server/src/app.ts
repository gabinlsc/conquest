import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import { ZodError } from 'zod';
import type { HealthResponse, ServerEnv } from '@conquest/shared';
import type { Db } from './db/pool';
import { registerCityRoutes } from './routes/cities';

const VERSION = process.env['APP_VERSION'] ?? 'dev';

export interface AppDeps {
  db: Db;
}

/**
 * Fabrique l'application Fastify. Séparée de `index.ts` pour pouvoir
 * la tester avec `app.inject()` sans ouvrir de port.
 */
export async function buildApp(
  env: Pick<ServerEnv, 'NODE_ENV' | 'LOG_LEVEL'>,
  deps: AppDeps,
): Promise<FastifyInstance> {
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

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'requête invalide', issues: err.issues });
    }
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
        return {
          status: dbUp ? 'ok' : 'degraded',
          uptimeSeconds: Math.round(process.uptime()),
          version: VERSION,
          services: { db: dbUp ? 'up' : 'down' },
        };
      });
      registerCityRoutes(api, deps.db);
      done();
    },
    { prefix: '/api' },
  );

  return app;
}
