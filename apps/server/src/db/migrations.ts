import type { Db } from './pool';

interface Migration {
  id: string;
  sql: string;
}

/**
 * Migrations embarquées dans le bundle (pas de fichiers à copier dans l'image Docker).
 * Règle : on n'édite JAMAIS une migration déjà publiée, on en ajoute une nouvelle.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: '001_cities_factions',
    sql: `
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE EXTENSION IF NOT EXISTS pg_trgm;

      CREATE TABLE countries (
        code      char(2) PRIMARY KEY,
        name      text NOT NULL,
        continent char(2) NOT NULL
      );

      CREATE TABLE factions (
        id           serial PRIMARY KEY,
        kind         text NOT NULL CHECK (kind IN ('country', 'clan')),
        slug         text NOT NULL UNIQUE,
        name         text NOT NULL,
        color        char(7) NOT NULL,
        country_code char(2) REFERENCES countries(code),
        created_at   timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE cities (
        geonames_id  integer PRIMARY KEY,
        name         text NOT NULL,
        ascii_name   text NOT NULL,
        country_code char(2) NOT NULL,
        admin1       text,
        population   integer NOT NULL,
        rarity       text NOT NULL CHECK (rarity IN ('common', 'rare', 'epic', 'legendary')),
        value        smallint NOT NULL,
        geom         geometry(Point, 4326) NOT NULL,
        updated_at   timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX cities_geom_idx ON cities USING gist (geom);
      CREATE INDEX cities_country_pop_idx ON cities (country_code, population DESC);
      CREATE INDEX cities_pop_idx ON cities (population DESC);
      CREATE INDEX cities_ascii_trgm_idx ON cities USING gin (ascii_name gin_trgm_ops);

      -- État persistant du monde. En production l'état chaud vit dans Redis (phase 4) ;
      -- cette table en est la copie durable (write-behind + snapshots).
      CREATE TABLE city_state (
        geonames_id      integer PRIMARY KEY REFERENCES cities(geonames_id) ON DELETE CASCADE,
        owner_faction_id integer REFERENCES factions(id),
        influence        jsonb NOT NULL DEFAULT '{}',
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX city_state_owner_idx ON city_state (owner_faction_id);
    `,
  },
];

const LOCK_KEY = 727_001; // verrou advisory : un seul process migre à la fois

/** Applique les migrations manquantes, dans une transaction par migration. Idempotent. */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<string[]> {
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set(
      (await client.query<{ id: string }>('SELECT id FROM schema_migrations')).rows.map(
        (r) => r.id,
      ),
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      log(`migration ${m.id}`);
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
        await client.query('COMMIT');
        applied.push(m.id);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
  return applied;
}
