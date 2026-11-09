import { Redis } from 'ioredis';

export type { Redis };

/**
 * Client Redis configuré pour le MODE DÉGRADÉ :
 *  - `enableOfflineQueue: false` : si Redis est injoignable, les commandes échouent immédiatement
 *    (au lieu de s'empiler et de bloquer les requêtes HTTP) ; l'appelant bascule sur Postgres.
 *  - reconnexion automatique avec attente croissante, plafonnée à 2 s.
 */
export function createRedis(url: string, log: (msg: string) => void = () => {}): Redis {
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2_000),
    connectTimeout: 3_000,
  });
  redis.on('error', (err: Error) => log(`redis: ${err.message}`));
  redis.on('ready', () => log('redis: connecté'));
  redis.on('close', () => log('redis: connexion perdue'));
  return redis;
}
