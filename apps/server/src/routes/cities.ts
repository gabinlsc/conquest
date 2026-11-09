import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  citiesQuerySchema,
  type CityFeatureProps,
  type City,
  type CityListResponse,
  type Country,
  type Rarity,
  garrisonFor,
} from '@conquest/shared';
import type { Db } from '../db/pool';
import type { WorldServices } from '../world/services';

interface CityRowDb {
  geonames_id: number;
  name: string;
  ascii_name: string;
  country_code: string;
  country_name: string | null;
  admin1: string | null;
  population: number;
  rarity: Rarity;
  value: number;
  lon: number;
  lat: number;
  owner_faction_id: number | null;
}

const toCity = (r: CityRowDb): City => ({
  garrison: garrisonFor(r.value),
  ownerFaction: null,
  influence: [],
  ver: 0,
  id: r.geonames_id,
  name: r.name,
  asciiName: r.ascii_name,
  countryCode: r.country_code,
  countryName: r.country_name ?? r.country_code,
  admin1: r.admin1,
  population: r.population,
  rarity: r.rarity,
  value: r.value,
  lon: r.lon,
  lat: r.lat,
  ownerFactionId: r.owner_faction_id,
});

const CITY_SELECT = `
  SELECT c.geonames_id, c.name, c.ascii_name, c.country_code, co.name AS country_name, c.admin1,
         c.population, c.rarity, c.value, ST_X(c.geom) AS lon, ST_Y(c.geom) AS lat,
         s.owner_faction_id
  FROM cities c
  LEFT JOIN countries co ON co.code = c.country_code
  LEFT JOIN city_state s ON s.geonames_id = c.geonames_id`;

/** Échappe les jokers LIKE pour que la saisie utilisateur soit traitée littéralement. */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

interface GeoJsonCache {
  etag: string;
  body: string;
  checkedAt: number;
  version: string;
}

export function registerCityRoutes(
  api: FastifyInstance,
  db: Db,
  world: WorldServices | undefined,
): void {
  // ---- Géométrie statique, mise en cache mémoire + ETag ----
  // La géométrie ne change qu'à l'import GeoNames : on revalide la version au plus toutes les 60 s.
  let geoCache: GeoJsonCache | null = null;
  const GEO_TTL_MS = 60_000;

  api.get('/cities/geojson', async (req, reply) => {
    const now = Date.now();
    if (!geoCache || now - geoCache.checkedAt > GEO_TTL_MS) {
      const meta = await db.query<{ v: string }>(
        `SELECT count(*) || ':' || coalesce(max(updated_at)::text, '') AS v FROM cities`,
      );
      const version = meta.rows[0]?.v ?? '';
      if (geoCache?.version === version) {
        geoCache.checkedAt = now;
      } else {
        const { rows } = await db.query<{
          geonames_id: number;
          ascii_name: string;
          population: number;
          rarity: Rarity;
          value: number;
          lon: number;
          lat: number;
        }>(
          `SELECT geonames_id, ascii_name, population, rarity, value,
                  ST_X(geom) AS lon, ST_Y(geom) AS lat
           FROM cities ORDER BY population DESC`,
        );
        // Ordre par population décroissante : MapLibre dessine/étiquette les grandes villes en priorité.
        const features = rows.map((r) => ({
          type: 'Feature' as const,
          id: r.geonames_id,
          geometry: {
            type: 'Point' as const,
            coordinates: [Math.round(r.lon * 1e4) / 1e4, Math.round(r.lat * 1e4) / 1e4],
          },
          properties: {
            label: r.ascii_name,
            pop: r.population,
            rarity: r.rarity,
            value: r.value,
          } satisfies CityFeatureProps,
        }));
        const body = JSON.stringify({ type: 'FeatureCollection', features });
        geoCache = {
          body,
          version,
          checkedAt: now,
          etag: `"${createHash('sha1').update(body).digest('base64url')}"`,
        };
      }
    }
    reply.header('ETag', geoCache.etag).header('Cache-Control', 'public, max-age=300');
    if (req.headers['if-none-match'] === geoCache.etag) return reply.code(304).send();
    return reply.type('application/json').send(geoCache.body);
  });

  // ---- Liste / recherche paginée ----
  api.get('/cities', async (req): Promise<CityListResponse> => {
    const q = citiesQuerySchema.parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.country) add('c.country_code = ?', q.country);
    if (q.minPop !== undefined) add('c.population >= ?', q.minPop);
    if (q.q) add(`c.ascii_name ILIKE '%' || ? || '%'`, escapeLike(q.q));
    if (q.bbox) {
      const [w, s, e, n] = q.bbox;
      params.push(w, s, e, n);
      const i = params.length;
      where.push(`c.geom && ST_MakeEnvelope($${i - 3}, $${i - 2}, $${i - 1}, $${i}, 4326)`);
    }
    params.push(q.limit, q.offset);
    const { rows } = await db.query<CityRowDb & { total: string }>(
      `${CITY_SELECT.replace('SELECT', 'SELECT count(*) OVER () AS total,')}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY c.population DESC, c.geonames_id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: rows.map(toCity), total: Number(rows[0]?.total ?? 0) };
  });

  /**
   * Enrichit une ville avec son état chaud : propriétaire et influence viennent de Redis (à jour à la
   * milliseconde) ; si Redis est indisponible, de la dernière copie persistée dans Postgres.
   */
  async function withLive(city: City): Promise<City> {
    if (!world) return city;
    let owner = city.ownerFactionId;
    let ver = 0;
    let influence: Record<number, number>;
    try {
      if (!world.store.isUp()) throw new Error('redis indisponible');
      const live = await world.store.getCity(city.id);
      if (!live) throw new Error('inconnue de redis');
      owner = live.owner || null;
      ver = live.ver;
      influence = live.influence;
    } catch {
      const { rows } = await db.query<{ influence: { i?: Record<string, number> } }>(
        'SELECT influence FROM city_state WHERE geonames_id = $1',
        [city.id],
      );
      influence = Object.fromEntries(
        Object.entries(rows[0]?.influence?.i ?? {}).map(([f, v]) => [Number(f), v]),
      );
    }
    const list = await Promise.all(
      Object.entries(influence).map(async ([f, value]) => {
        const faction = await world.factions.get(Number(f));
        return faction
          ? { factionId: faction.id, name: faction.name, color: faction.color, value }
          : null;
      }),
    );
    const ownerFaction = owner ? await world.factions.get(owner) : null;
    return {
      ...city,
      ownerFactionId: owner,
      ownerFaction: ownerFaction
        ? { id: ownerFaction.id, name: ownerFaction.name, color: ownerFaction.color }
        : null,
      ver,
      influence: list
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => b.value - a.value),
    };
  }

  api.get<{ Params: { id: string } }>('/cities/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'id invalide' });
    const { rows } = await db.query<CityRowDb>(`${CITY_SELECT} WHERE c.geonames_id = $1`, [id]);
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'ville introuvable' });
    reply.header('Cache-Control', 'no-cache');
    return withLive(toCity(row));
  });

  api.get('/countries', async (_req, reply): Promise<Country[]> => {
    const { rows } = await db.query<Country>(
      'SELECT code, name, continent FROM countries ORDER BY name',
    );
    reply.header('Cache-Control', 'public, max-age=3600');
    return rows;
  });
}
