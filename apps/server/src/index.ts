import { parseServerEnv } from '@conquest/shared';
import { buildApp } from './app';
import { createPool } from './db/pool';
import { migrate } from './db/migrations';
import { purgeExpiredSessions } from './auth/session';
import { AntiCheatService } from './anticheat/service';
import { EffectService } from './attacks/effects';
import { BotService } from './bots/service';
import { Metrics } from './metrics';
import { EventService } from './events/service';
import { attachGateway } from './realtime/gateway';
import { LeaderboardService } from './seasons/leaderboards';
import { SeasonService } from './seasons/service';
import { FactionDirectory } from './world/factions';
import { CityIndex } from './world/geo';
import { createRedis } from './world/redis';
import { WorldStore } from './world/store';

async function main(): Promise<void> {
  const env = parseServerEnv(process.env);
  const pool = createPool(env.DATABASE_URL);
  await migrate(pool, (m) => console.log(`[db] ${m}`));

  // ---- État chaud du monde ----
  const redis = createRedis(env.REDIS_URL, (m) => console.log(`[world] ${m}`));
  const geo = await CityIndex.load(pool);
  const factions = await FactionDirectory.load(pool);
  const store = new WorldStore(redis, geo);
  const events = new EventService(pool);
  const leaderboards = new LeaderboardService(redis, pool, factions);
  const metrics = new Metrics();
  const anticheat = new AntiCheatService(pool, redis, metrics);
  const seasons = new SeasonService({
    db: pool,
    store,
    geo,
    leaderboards,
    durationMs: env.SEASON_WEEKS * 7 * 86_400_000,
  });
  const effects = new EffectService({
    db: pool,
    store,
    geo,
    factions,
    events,
    leaderboards,
    seasons,
    anticheat,
    metrics,
  });
  const world = { store, geo, factions, effects, events, leaderboards, seasons, anticheat };
  await seasons.refresh(); // crée la première saison au tout premier démarrage

  const app = await buildApp(env, { db: pool, world, metrics });
  const gateway = attachGateway(app, { env, db: pool, store, factions, events });
  effects.publisher = gateway;
  seasons.publisher = gateway;
  metrics.bind({
    online: () => gateway.online(),
    redisUp: () => store.isUp(),
    pendingWrites: () => store.pendingCount(),
    seasonId: async () => (await seasons.current()).id,
  });

  // Bots d'animation (désactivés par défaut ; actifs en production via BOTS_ENABLED).
  const bots = new BotService({
    db: pool,
    store,
    geo,
    factions,
    effects,
    seasons,
    online: () => gateway.online(),
    metrics,
    config: {
      count: env.BOT_COUNT,
      intervalMs: env.BOT_INTERVAL_MS,
      maxOnline: env.BOT_MAX_ONLINE,
    },
  });
  if (env.BOTS_ENABLED) {
    const n = await bots.init();
    bots.start();
    app.log.info({ bots: n }, 'bots d’animation actifs');
  }

  // À chaque (re)connexion de Redis : recharge l'état depuis Postgres s'il a été perdu.
  const hydrate = () =>
    store.hydrateIfEmpty(pool).then(
      (done) => done && app.log.info('état du monde chargé dans Redis'),
      (err: unknown) => app.log.warn({ err }, 'hydratation impossible'),
    );
  redis.on('ready', () => void hydrate());
  // Redis a pu devenir prêt pendant le chargement des index ci-dessus : l'événement 'ready' est alors déjà passé.
  if (store.isUp()) void hydrate();

  // ---- Tâches de fond (non bloquantes, n'empêchent pas l'arrêt) ----
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let running = false;
    const t = setInterval(() => {
      if (running) return; // pas de chevauchement si une passe est lente
      running = true;
      fn()
        .catch((err: unknown) => app.log.warn({ err }, `tâche ${name}`))
        .finally(() => {
          running = false;
        });
    }, ms);
    t.unref();
    return t;
  };
  every(3_600_000, 'purge sessions', () => purgeExpiredSessions(pool));
  // Write-behind : Redis -> Postgres toutes les 2 s (seulement les villes modifiées).
  every(2_000, 'persistance', async () => {
    if (store.isUp()) while ((await store.persistDirty(pool)) === 500);
  });
  // Classements : persistance Redis -> Postgres (write-behind) et clôture/ouverture des saisons.
  every(5_000, 'classements', async () => {
    if (leaderboards.isUp()) while ((await leaderboards.flush()) === 500);
  });
  every(30_000, 'saisons', () => seasons.tick());
  // Mode dégradé : rejoue les attaques validées pendant une panne de Redis.
  every(10_000, 'réconciliation', () => effects.reconcile());

  // ---- Arrêt propre ----
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'arrêt demandé');
      void (async () => {
        try {
          bots.stop();
          await gateway.close();
          await app.close();
          // Dernière vidange : rien de ce qui est en attente dans Redis ne doit être perdu.
          if (store.isUp()) {
            while ((await store.persistDirty(pool)) > 0);
            while ((await leaderboards.flush()) > 0);
          }
          redis.disconnect();
          await pool.end();
          process.exit(0);
        } catch {
          process.exit(1);
        }
      })();
    });
  }

  await app.listen({ host: env.SERVER_HOST, port: env.SERVER_PORT });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
