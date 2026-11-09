import { parseServerEnv } from '@conquest/shared';
import { buildApp } from './app';

async function main(): Promise<void> {
  const env = parseServerEnv(process.env);
  const app = await buildApp(env);

  // Arrêt propre : Docker envoie SIGTERM, on laisse finir les requêtes en cours.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'arrêt demandé');
      app.close().then(
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
