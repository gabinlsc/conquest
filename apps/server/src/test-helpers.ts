import { parseServerEnv, type ServerEnv } from '@conquest/shared';

export const testEnv = (extra: Record<string, string> = {}): ServerEnv =>
  parseServerEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://x@localhost/x',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'x'.repeat(40),
    PUBLIC_URL: 'http://localhost:3000',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    ...extra,
  });

import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { EffectService } from './attacks/effects';
import { EventService } from './events/service';
import { attachGateway, type Gateway } from './realtime/gateway';
import { FactionDirectory } from './world/factions';
import { CityIndex } from './world/geo';
import { createRedis } from './world/redis';
import type { WorldServices } from './world/services';
import { WorldStore } from './world/store';

/** Assemble les services du monde sur un vrai Redis de test (base dédiée, vidée à chaque appel). */
export async function createTestWorld(
  pool: pg.Pool,
  redisUrl: string,
): Promise<WorldServices & { redisReady: Promise<void> }> {
  const redis = createRedis(redisUrl);
  const redisReady = new Promise<void>((resolve) => redis.once('ready', () => resolve()));
  await redisReady;
  await redis.flushdb();
  const geo = await CityIndex.load(pool);
  const factions = await FactionDirectory.load(pool);
  const store = new WorldStore(redis, geo);
  const events = new EventService(pool);
  const effects = new EffectService({ db: pool, store, geo, factions, events });
  await store.hydrateIfEmpty(pool);
  return { store, geo, factions, effects, events, redisReady };
}

export function attachTestGateway(
  app: FastifyInstance,
  pool: pg.Pool,
  world: WorldServices,
): Gateway {
  const gw = attachGateway(app, {
    env: testEnv(),
    db: pool,
    store: world.store,
    factions: world.factions,
    events: world.events,
    presenceIntervalMs: 200,
  });
  world.effects.publisher = gw;
  return gw;
}
