import { parseServerEnv } from '@conquest/shared';
import { createPool } from '../db/pool';
import { migrate } from '../db/migrations';
import { downloadGeonames } from '../geonames/download';
import { importGeonames } from '../geonames/import';

/**
 * Usage : node dist/cli/import-geonames.js [--if-empty] [--neutral]
 *   --if-empty : ne fait rien si la table cities contient déjà des villes (utilisé par deploy.sh)
 *   --neutral  : villes sans propriétaire au lieu de la faction de leur pays
 */
async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const env = parseServerEnv(process.env);
  const log = (m: string) => console.log(`[import] ${m}`);
  const pool = createPool(env.DATABASE_URL);
  try {
    await migrate(pool, log);
    if (args.has('--if-empty')) {
      const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM cities');
      if (Number(rows[0]?.n) > 0) {
        log('villes déjà présentes, rien à faire');
        return;
      }
    }
    const files = await downloadGeonames(log);
    const stats = await importGeonames(pool, files, {
      initialOwnership: args.has('--neutral') ? 'neutral' : 'country',
      log,
    });
    log(`terminé : ${JSON.stringify(stats)}`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
