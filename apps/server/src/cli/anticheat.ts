import { parseServerEnv } from '@conquest/shared';
import { AntiCheatService } from '../anticheat/service';
import { createPool } from '../db/pool';

/**
 * Revue anti-triche.
 *   node dist/cli/anticheat.js report [n]      joueurs les plus suspects
 *   node dist/cli/anticheat.js unban <userId>   lève un shadow ban (faux positif)
 */
async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const env = parseServerEnv(process.env);
  const pool = createPool(env.DATABASE_URL);
  const ac = new AntiCheatService(pool, null);
  try {
    if (cmd === 'unban' && arg) {
      console.log((await ac.unban(arg)) ? `joueur ${arg} réhabilité` : 'joueur introuvable');
    } else if (cmd === 'report') {
      const rows = await ac.report(Number(arg ?? 20));
      console.table(
        rows.map((r) => ({
          id: r.user_id,
          pseudo: r.display_name,
          suspicion: Math.round(r.suspicion),
          parties_signalées: r.flag_count,
          shadow_ban: r.shadow_banned ? 'OUI' : '',
          raisons: r.last_reasons.join(' '),
        })),
      );
    } else {
      console.log('usage : anticheat report [n] | anticheat unban <userId>');
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
