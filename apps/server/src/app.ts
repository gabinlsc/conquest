import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import type { HealthResponse, ServerEnv } from '@conquest/shared';

const VERSION = process.env['APP_VERSION'] ?? 'dev';

/**
 * Fabrique l'application Fastify. Séparée de `index.ts` pour pouvoir
 * la tester avec `app.inject()` sans ouvrir de port.
 */
export async function buildApp(
  env: Pick<ServerEnv, 'NODE_ENV' | 'LOG_LEVEL'>,
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

  // Toutes les routes REST sont sous /api : le reverse proxy route ce préfixe vers ce service.
  await app.register(
    (api, _opts, done) => {
      api.get('/health', (): HealthResponse => ({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        version: VERSION,
      }));
      done();
    },
    { prefix: '/api' },
  );

  return app;
}
