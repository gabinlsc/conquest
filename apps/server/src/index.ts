import { parseServerEnv } from '@conquest/shared';
import { buildApp } from './app';
import { createPool } from './db/pool';
import { migrate } from './db/migrations';
import { purgeExpiredSessions } from './auth/session';

async function main(): Promise<void> {
  const env = parseServerEnv(process.env);
  const pool = createPool(env.DATABASE_URL);
  await migrate(pool, (m) => console.log(`[db] ${m}`));
  const app = await buildApp(env, { db: pool });

  // Ménage horaire des sessions expirées (non bloquant, n'empêche pas l'arrêt du process).
  const purge = setInterval(() => {
    purgeExpiredSessions(pool).catch((err: unknown) => app.log.warn({ err }, 'purge des sessions'));
  }, 3_600_000);
  purge.unref();

  // Arrêt propre : Docker envoie SIGTERM, on laisse finir les requêtes en cours.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'arrêt demandé');
      app
        .close()
        .then(() => pool.end())
        .then(
          () => process.exit(0),
          () => process.exit(1),
        );
    });
  }

  await app.listen({ host: env.SERVER_HOST, port: env.SERVER_PORT });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
