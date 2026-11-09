import { colorForKey } from '@conquest/shared';
import type { Db } from '../db/pool';
import { migrate } from '../db/migrations';
import { parseAdmin1, parseCityLine, parseCountryInfo, type CityRow } from './parse';
import type { GeonamesFiles } from './download';

export interface ImportOptions {
  /** `country` : chaque ville appartient d'abord à la faction de son pays ; `neutral` : sans propriétaire. */
  initialOwnership?: 'country' | 'neutral';
  log?: (msg: string) => void;
}

export interface ImportStats {
  parsed: number;
  rejected: number;
  citiesTotal: number;
  statesCreated: number;
}

const BATCH = 2_000;

/**
 * Import idempotent : relançable à volonté.
 * - villes/pays/factions de pays : upsert (les champs GeoNames sont mis à jour seulement s'ils ont changé) ;
 * - city_state : `ON CONFLICT DO NOTHING` => un ré-import ne remet JAMAIS à zéro la propriété
 *   ni l'influence d'une partie en cours.
 * Tout se passe dans une transaction : un import interrompu ne laisse pas la base à moitié remplie.
 */
export async function importGeonames(
  db: Db,
  files: GeonamesFiles,
  opts: ImportOptions = {},
): Promise<ImportStats> {
  const log = opts.log ?? (() => {});
  await migrate(db, log);

  const countries = parseCountryInfo(files.countries);
  const admin1 = parseAdmin1(files.admin1);
  const cities: CityRow[] = [];
  let rejected = 0;
  for (const line of files.cities.split('\n')) {
    if (!line.trim()) continue;
    const row = parseCityLine(line);
    if (row) cities.push(row);
    else rejected++;
  }
  if (cities.length === 0) throw new Error('Aucune ville valide dans le fichier : import annulé');
  log(`${cities.length} villes, ${countries.length} pays (${rejected} lignes rejetées)`);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO countries (code, name, continent)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, continent = EXCLUDED.continent`,
      [
        countries.map((c) => c.code),
        countries.map((c) => c.name),
        countries.map((c) => c.continent),
      ],
    );

    await client.query(
      `INSERT INTO factions (kind, slug, name, color, country_code)
       SELECT 'country', 'country:' || lower(code), name, color, code
       FROM unnest($1::text[], $2::text[], $3::text[]) AS t(code, name, color)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name`,
      [
        countries.map((c) => c.code),
        countries.map((c) => c.name),
        countries.map((c) => colorForKey(c.code)),
      ],
    );

    for (let i = 0; i < cities.length; i += BATCH) {
      const b = cities.slice(i, i + BATCH);
      await client.query(
        `INSERT INTO cities (geonames_id, name, ascii_name, country_code, admin1, population, rarity, value, geom)
         SELECT id, name, ascii, cc, a1, pop, rarity, value, ST_SetSRID(ST_MakePoint(lon, lat), 4326)
         FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::int[],
                     $7::text[], $8::int[], $9::float8[], $10::float8[])
              AS t(id, name, ascii, cc, a1, pop, rarity, value, lon, lat)
         ON CONFLICT (geonames_id) DO UPDATE SET
           name = EXCLUDED.name, ascii_name = EXCLUDED.ascii_name, country_code = EXCLUDED.country_code,
           admin1 = EXCLUDED.admin1, population = EXCLUDED.population, rarity = EXCLUDED.rarity,
           value = EXCLUDED.value, geom = EXCLUDED.geom, updated_at = now()
         WHERE (cities.name, cities.ascii_name, cities.country_code, cities.admin1, cities.population,
                cities.rarity, cities.value, cities.geom::text)
               IS DISTINCT FROM
               (EXCLUDED.name, EXCLUDED.ascii_name, EXCLUDED.country_code, EXCLUDED.admin1,
                EXCLUDED.population, EXCLUDED.rarity, EXCLUDED.value, EXCLUDED.geom::text)`,
        [
          b.map((c) => c.geonamesId),
          b.map((c) => c.name),
          b.map((c) => c.asciiName),
          b.map((c) => c.countryCode),
          b.map((c) => admin1.get(`${c.countryCode}.${c.admin1Code}`) ?? null),
          b.map((c) => c.population),
          b.map((c) => c.rarity),
          b.map((c) => c.value),
          b.map((c) => c.lon),
          b.map((c) => c.lat),
        ],
      );
    }

    const owner = opts.initialOwnership ?? 'country';
    const states = await client.query(
      `INSERT INTO city_state (geonames_id, owner_faction_id)
       SELECT c.geonames_id, ${owner === 'country' ? 'f.id' : 'NULL::int'}
       FROM cities c
       LEFT JOIN factions f ON f.slug = 'country:' || lower(c.country_code)
       ON CONFLICT (geonames_id) DO NOTHING`,
    );

    const total = await client.query<{ n: string }>('SELECT count(*) AS n FROM cities');
    await client.query('COMMIT');
    return {
      parsed: cities.length,
      rejected,
      citiesTotal: Number(total.rows[0]?.n ?? 0),
      statesCreated: states.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
