import { parseServerEnv } from '@conquest/shared';
import { buildApp } from './app';
import { createPool } from './db/pool';
import { migrate } from './db/migrations';

async function main(): Promise<void> {
  const env = parseServerEnv(process.env);
  const pool = createPool(env.DATABASE_URL);
  await migrate(pool, (m) => console.log(`[db] ${m}`));
  const app = await buildApp(env, { db: pool });

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
