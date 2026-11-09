import pg from 'pg';

export type Db = Pick<pg.Pool, 'query' | 'connect'>;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  // Une erreur sur un client inactif ne doit pas faire tomber le process.
  pool.on('error', (err) => console.error('[pg] erreur client inactif :', err.message));
  return pool;
}
