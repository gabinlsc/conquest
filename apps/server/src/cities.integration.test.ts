import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { City, CityListResponse, WorldState } from '@conquest/shared';
import { buildApp } from './app';
import { importGeonames } from './geonames/import';
import { FIXTURE_ADMIN1, FIXTURE_CITIES, FIXTURE_COUNTRIES } from './geonames/fixtures';

/**
 * Test d'intégration contre un vrai Postgres+PostGIS.
 * Lancé uniquement si TEST_DATABASE_URL est défini (CI : service postgis).
 * ATTENTION : la base ciblée est vidée (DROP SCHEMA public).
 */
const url = process.env['TEST_DATABASE_URL'];
const files = { cities: FIXTURE_CITIES, countries: FIXTURE_COUNTRIES, admin1: FIXTURE_ADMIN1 };

describe.skipIf(!url)('import GeoNames + API villes', () => {
  const pool = new pg.Pool({ connectionString: url });
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await importGeonames(pool, files);
    app = await buildApp({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }, { db: pool });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it("l'import est idempotent et ne réinitialise pas la propriété", async () => {
    const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM cities');
    await pool.query(
      `UPDATE city_state SET owner_faction_id = (SELECT id FROM factions WHERE slug = 'country:de')
       WHERE geonames_id = 2988507`,
    );
    const stats = await importGeonames(pool, files);
    const after = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM cities');
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(stats.statesCreated).toBe(0);
    const paris = await app.inject({ url: '/api/cities/2988507' });
    const factions = (await app.inject({ url: '/api/world/state' })).json<WorldState>().factions;
    const de = factions.find((f) => f.countryCode === 'DE');
    expect(paris.json<City>().ownerFactionId).toBe(de?.id); // capture simulée toujours là
  });

  it('GET /cities/geojson : FeatureCollection triée par population, ETag/304', async () => {
    const res = await app.inject({ url: '/api/cities/geojson' });
    const body = res.json<{ features: { id: number; properties: { pop: number } }[] }>();
    expect(body.features).toHaveLength(7);
    expect(body.features[0]?.properties.pop).toBeGreaterThanOrEqual(
      body.features[1]!.properties.pop,
    );
    const etag = res.headers['etag'] as string;
    const again = await app.inject({
      url: '/api/cities/geojson',
      headers: { 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
  });

  it('GET /cities : filtres pays, recherche, bbox, pagination', async () => {
    const fr = (await app.inject({ url: '/api/cities?country=fr' })).json<CityListResponse>();
    expect(fr.total).toBe(3);
    expect(fr.items[0]?.name).toBe('Paris');
    expect(fr.items[0]?.admin1).toBe("Provence-Alpes-Côte d'Azur");

    const q = (
      await app.inject({ url: '/api/cities?q=cugat%20del%20valles' })
    ).json<CityListResponse>();
    expect(q.items.map((c) => c.name)).toEqual(['Sant Cugat del Vallès']);

    // % est littéral, pas un joker.
    const wild = (await app.inject({ url: '/api/cities?q=%25%25' })).json<CityListResponse>();
    expect(wild.total).toBe(0);

    const bbox = (
      await app.inject({ url: '/api/cities?bbox=-10,40,10,52' })
    ).json<CityListResponse>();
    expect(bbox.items.map((c) => c.countryCode).sort()).toEqual(['ES', 'FR', 'FR', 'FR']);

    const page = (
      await app.inject({ url: '/api/cities?limit=2&offset=2' })
    ).json<CityListResponse>();
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(7);
  });

  it('GET /cities/:id : 200, 404, 400', async () => {
    expect((await app.inject({ url: '/api/cities/1850147' })).json<City>()).toMatchObject({
      name: 'Tokyo',
      countryName: 'Japan',
      rarity: 'legendary',
    });
    expect((await app.inject({ url: '/api/cities/1' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/cities/abc' })).statusCode).toBe(400);
  });

  it('GET /world/state : factions de pays et propriétaires', async () => {
    const state = (await app.inject({ url: '/api/world/state' })).json<WorldState>();
    expect(state.factions.length).toBe(5);
    expect(Object.keys(state.owners)).toHaveLength(7);
  });
});
