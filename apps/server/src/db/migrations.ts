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
  {
    id: '002_users_sessions_clans',
    sql: `
      CREATE TABLE users (
        id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind               text NOT NULL CHECK (kind IN ('guest', 'oauth')),
        display_name       text NOT NULL,
        avatar_url         text,
        country_code       char(2) REFERENCES countries(code),
        country_changed_at timestamptz,
        created_at         timestamptz NOT NULL DEFAULT now(),
        last_seen_at       timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE oauth_accounts (
        provider         text NOT NULL,
        provider_user_id text NOT NULL,
        user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at       timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, provider_user_id)
      );
      CREATE INDEX oauth_accounts_user_idx ON oauth_accounts (user_id);

      -- Sessions serveur : seul le hash SHA-256 du jeton est stocké (une fuite de la base
      -- ne permet pas d'usurper une session). Le jeton clair n'existe que dans le cookie.
      CREATE TABLE sessions (
        token_hash bytea PRIMARY KEY,
        user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX sessions_user_idx ON sessions (user_id);
      CREATE INDEX sessions_expires_idx ON sessions (expires_at);

      -- user_id en clé primaire : un joueur appartient à EXACTEMENT une faction
      -- (son pays par défaut, ou un clan). Garanti par la base, pas seulement par le code.
      CREATE TABLE faction_members (
        user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        faction_id integer NOT NULL REFERENCES factions(id) ON DELETE CASCADE,
        role       text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'owner')),
        joined_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX faction_members_faction_idx ON faction_members (faction_id);

      ALTER TABLE factions
        ADD COLUMN open boolean NOT NULL DEFAULT true,
        ADD COLUMN invite_code text UNIQUE;
      CREATE UNIQUE INDEX factions_clan_name_idx ON factions (lower(name)) WHERE kind = 'clan';
    `,
  },
  {
    id: '003_attacks',
    sql: `
      CREATE TABLE attacks (
        id           uuid PRIMARY KEY,
        user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- Faction du joueur AU MOMENT de l'attaque (il peut en changer ensuite).
        faction_id   integer REFERENCES factions(id) ON DELETE SET NULL,
        city_id      integer NOT NULL REFERENCES cities(geonames_id),
        minigame     text NOT NULL,
        seed         text NOT NULL,
        status       text NOT NULL CHECK (status IN ('started', 'submitted', 'abandoned')),
        score        integer,
        max_score    integer,
        validated    boolean,
        stats        jsonb,
        -- Drapeaux d'analyse (hard:/soft:) : jamais exposés, servent à la détection d'anomalies.
        flags        text[] NOT NULL DEFAULT '{}',
        -- Preuve brute envoyée par le client, conservée pour audit et rejeu.
        input        jsonb,
        started_at   timestamptz NOT NULL DEFAULT now(),
        submitted_at timestamptz
      );
      -- Un seul jeu actif par joueur, garanti par la base (pas de course entre deux onglets).
      CREATE UNIQUE INDEX attacks_one_active_idx ON attacks (user_id) WHERE status = 'started';
      CREATE INDEX attacks_user_idx ON attacks (user_id, started_at DESC);
      CREATE INDEX attacks_city_idx ON attacks (city_id, started_at DESC);
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
