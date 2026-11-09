import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  reflexGame,
  type AttackResult,
  type AttackStartResponse,
  type CityAlert,
  type ClientToServerEvents,
  type GameEvent,
  type LeaderboardResponse,
  type ReflexInput,
  type ReflexParams,
  type ServerToClientEvents,
} from '@conquest/shared';
import { buildApp } from './app';
import { BotService } from './bots/service';
import { importGeonames } from './geonames/import';
import { FIXTURE_ADMIN1, FIXTURE_CITIES, FIXTURE_COUNTRIES } from './geonames/fixtures';
import { K } from './world/store';
import { attachTestGateway, createTestWorld, testEnv } from './test-helpers';

/** Phase 6 : alertes personnelles, bots d'animation, métriques Prometheus. */
const dbUrl = process.env['TEST_DATABASE_URL'];
const redisUrl = process.env['TEST_REDIS_URL'];
const PARIS = 2988507;
const BERLIN = 2950159;
const SANT_CUGAT = 3128760;

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe.skipIf(!dbUrl || !redisUrl)('alertes, bots, métriques', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });
  const env = testEnv({ METRICS_TOKEN: 'jeton-de-test-0123456789' });
  let world: Awaited<ReturnType<typeof createTestWorld>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let gateway: ReturnType<typeof attachTestGateway>;
  let baseUrl = '';
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await importGeonames(pool, {
      cities: FIXTURE_CITIES,
      countries: FIXTURE_COUNTRIES,
      admin1: FIXTURE_ADMIN1,
    });
    world = await createTestWorld(pool, redisUrl!);
    app = await buildApp(env, { db: pool, world, metrics: world.metrics });
    gateway = attachTestGateway(app, pool, world);
    world.metrics.bind({
      online: () => gateway.online(),
      redisUp: () => world.store.isUp(),
      pendingWrites: () => world.store.pendingCount(),
      seasonId: async () => (await world.seasons.current()).id,
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    for (const s of sockets) s.close();
    await gateway.close();
    await app.close();
    world.store.redis.disconnect();
    await pool.end();
  });

  const factionId = async (cc: string) =>
    (
      await pool.query<{ id: number }>('SELECT id FROM factions WHERE slug = $1', [
        `country:${cc.toLowerCase()}`,
      ])
    ).rows[0]!.id;
  const resetCity = async (cityId: number, owner: number) => {
    await world.store.redis.del(K.city(cityId));
    await world.store.redis.hset(K.owners, cityId, owner);
  };

  // ------------------------------------------------------------ joueurs & sockets
  let n = 0;
  interface Player {
    id: string;
    cookie: string;
    call: (
      m: 'GET' | 'POST' | 'PATCH',
      path: string,
      payload?: unknown,
    ) => Promise<LightMyRequestResponse>;
  }
  async function newPlayer(country: string): Promise<Player> {
    const ip = `10.6.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/guest',
      headers: { 'x-forwarded-for': ip },
      payload: { countryCode: country },
    });
    const cookie = res.cookies.find((c) => c.name === 'conquest_sid')!.value;
    const call: Player['call'] = (method, path, payload) =>
      app.inject({
        method,
        url: `/api${path}`,
        headers: { 'x-forwarded-for': ip },
        cookies: { conquest_sid: cookie },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    return {
      id: (await call('GET', '/me')).json<{ user: { id: string } }>().user.id,
      cookie,
      call,
    };
  }
  const humanInput = (seed: string, salt: number): ReflexInput => ({
    clicks: reflexGame.generate(seed).targets.map((t, i) => ({
      t: t.appearAt + 280 + ((i * 37 + salt * 53) % 150),
      x: t.x + t.radius * 0.2 * (((i * 13) % 7) / 7 - 0.5),
      y: t.y,
    })),
  });
  let salt = 100;
  async function play(p: Player, cityId: number): Promise<AttackResult> {
    await pool.query(`UPDATE attacks SET started_at = started_at - interval '10 seconds'`);
    const start = (await p.call('POST', '/attacks', { cityId, minigame: 'reflex' })).json<
      AttackStartResponse<ReflexParams>
    >();
    await pool.query(
      `UPDATE attacks SET started_at = now() - interval '31 seconds' WHERE id = $1`,
      [start.attackId],
    );
    return (
      await p.call('POST', `/attacks/${start.attackId}/submit`, {
        input: { ...humanInput(start.seed, salt++) },
      })
    ).json<AttackResult>();
  }
  async function client(cookie?: string): Promise<{ s: ClientSocket; alerts: CityAlert[] }> {
    const s: ClientSocket = connect(baseUrl, {
      path: '/ws',
      transports: ['websocket'],
      extraHeaders: cookie ? { cookie: `conquest_sid=${cookie}` } : {},
      reconnection: false,
    });
    sockets.push(s);
    const alerts: CityAlert[] = [];
    s.on('alert', (a) => alerts.push(a));
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    return { s, alerts };
  }
  const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------ alertes
  describe('alertes « ta ville est attaquée »', () => {
    it('préviennent les membres de la faction attaquée, et eux seuls', async () => {
      await resetCity(PARIS, await factionId('FR'));
      const defender = await newPlayer('FR');
      const attacker = await newPlayer('DE');
      const bystander = await newPlayer('JP');
      const def = await client(defender.cookie);
      const other = await client(bystander.cookie);
      const spectator = await client(); // anonyme : jamais d'alerte
      await play(attacker, PARIS);
      await settle();
      expect(def.alerts).toHaveLength(1);
      expect(def.alerts[0]).toMatchObject({
        cityId: PARIS,
        cityName: 'Paris',
        captured: false,
        by: { name: 'Germany' },
      });
      expect(def.alerts[0]!.gain).toBeGreaterThan(0);
      expect(other.alerts).toHaveLength(0);
      expect(spectator.alerts).toHaveLength(0);
    });

    it('sont limitées (anti-spam) pour la pression, mais une capture est toujours signalée', async () => {
      await resetCity(PARIS, await factionId('FR'));
      await world.store.redis.del(`alert:${PARIS}:${await factionId('FR')}`);
      const defender = await newPlayer('FR');
      const def = await client(defender.cookie);
      const attackers = await Promise.all(Array.from({ length: 5 }, () => newPlayer('DE')));
      for (const a of attackers) await play(a, PARIS);
      await settle();
      const pressure = def.alerts.filter((a) => !a.captured);
      const captures = def.alerts.filter((a) => a.captured);
      expect(pressure.length).toBeLessThanOrEqual(1); // un seul avertissement dans la fenêtre de 20 s
      expect(captures).toHaveLength(1); // et la chute de la ville, elle, n'est jamais filtrée
      expect(captures[0]).toMatchObject({ cityName: 'Paris', by: { name: 'Germany' } });
    });

    it('suivent le joueur quand sa faction change (faction:refresh)', async () => {
      await resetCity(BERLIN, await factionId('DE'));
      await resetCity(PARIS, await factionId('FR'));
      await world.store.redis.del(
        `alert:${BERLIN}:${await factionId('DE')}`,
        `alert:${PARIS}:${await factionId('FR')}`,
      );
      const mover = await newPlayer('FR');
      const attacker = await newPlayer('US');
      const { s, alerts } = await client(mover.cookie);
      expect((await mover.call('PATCH', '/me', { countryCode: 'DE' })).statusCode).toBe(200);
      s.emit('faction:refresh');
      await settle();
      await play(attacker, BERLIN); // Berlin = nouvelle faction du joueur
      await settle();
      expect(alerts.map((a) => a.cityName)).toEqual(['Berlin']);
      await world.store.redis.del(`alert:${PARIS}:${await factionId('FR')}`);
      await resetCity(PARIS, await factionId('FR'));
      await play(await newPlayer('US'), PARIS); // Paris = ancienne faction : plus d'alerte
      await settle();
      expect(alerts.map((a) => a.cityName)).toEqual(['Berlin']);
    });
  });

  // ------------------------------------------------------------ bots
  describe('bots d’animation', () => {
    const makeBots = (opts: Partial<{ online: number; seed: number; count: number }> = {}) => {
      let seed = opts.seed ?? 7;
      const random = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
      return new BotService({
        db: pool,
        store: world.store,
        geo: world.geo,
        factions: world.factions,
        effects: world.effects,
        seasons: world.seasons,
        online: () => opts.online ?? 0,
        metrics: world.metrics,
        config: { count: opts.count ?? 6, intervalMs: 1_000, maxOnline: 10 },
        random,
      });
    };

    it('crée des comptes marqués « bot » (idempotent), répartis sur plusieurs pays', async () => {
      const bots = makeBots({ count: 6 });
      expect(await bots.init()).toBe(6);
      expect(await makeBots({ count: 6 }).init()).toBe(6); // second démarrage : aucun doublon
      const { rows } = await pool.query<{ n: number; countries: number }>(
        `SELECT count(*)::int AS n, count(DISTINCT country_code)::int AS countries FROM users WHERE is_bot`,
      );
      expect(rows[0]!.n).toBe(6);
      expect(rows[0]!.countries).toBeGreaterThan(1);
    });

    it('lancent de vraies attaques : effet sur la carte, deltas et événements, mais aucun point de classement', async () => {
      const bots = makeBots({ seed: 11 });
      await bots.init();
      const watcher = await client();
      const deltas: number[] = [];
      watcher.s.on('delta', (d) => deltas.push(d.id));
      await new Promise<void>((r) =>
        watcher.s.emit('sub', ['8:5', '8:6', '11:6', '4:5', '15:5'], () => r()),
      );
      const before = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM attacks WHERE flags @> ARRAY['bot']`,
      );
      let launched = 0;
      for (let i = 0; i < 80 && launched < 6; i++) {
        if (await bots.tick()) launched++;
        await pool.query(`UPDATE attacks SET started_at = started_at - interval '1 minute'`);
      }
      expect(launched).toBeGreaterThan(0);
      await settle();
      const after = await pool.query<{ n: number; applied: number }>(
        `SELECT count(*)::int AS n, count(applied_at)::int AS applied FROM attacks WHERE flags @> ARRAY['bot']`,
      );
      expect(after.rows[0]!.n - before.rows[0]!.n).toBe(launched);
      expect(after.rows[0]!.applied).toBe(after.rows[0]!.n); // toutes appliquées au monde
      expect(deltas.length).toBeGreaterThan(0); // la carte s'est animée

      // Les bots n'entrent jamais dans les classements de joueurs.
      const board = (
        await app.inject({ url: '/api/leaderboards/players' })
      ).json<LeaderboardResponse>();
      const botIds = (
        await pool.query<{ id: string }>('SELECT id FROM users WHERE is_bot')
      ).rows.map((r) => r.id);
      expect(board.entries.some((e) => botIds.includes(e.id))).toBe(false);
      // ... ni dans l'analyse anti-triche.
      expect(
        (
          await pool.query('SELECT 1 FROM anticheat_state WHERE user_id = ANY($1::uuid[])', [
            botIds,
          ])
        ).rowCount,
      ).toBe(0);
    });

    it('se taisent quand assez de vrais joueurs sont connectés, ou pendant un changement de saison', async () => {
      const crowded = makeBots({ online: 50 });
      await crowded.init();
      for (let i = 0; i < 10; i++) expect(await crowded.tick()).toBe(false);
      const quiet = makeBots({ online: 0, seed: 3 });
      await quiet.init();
      world.seasons.paused = true;
      for (let i = 0; i < 10; i++) expect(await quiet.tick()).toBe(false);
      world.seasons.paused = false;
    });

    it('alimentent le flux d’événements quand ils capturent une ville', async () => {
      await resetCity(SANT_CUGAT, await factionId('ES'));
      await world.store.redis.del(K.city(SANT_CUGAT));
      const bots = makeBots({ seed: 5, count: 30 });
      await bots.init();
      const spectator = await client();
      const events: GameEvent[] = [];
      spectator.s.on('events', (list) => events.push(...list));
      for (let i = 0; i < 400 && events.length === 0; i++) {
        await bots.tick();
        await pool.query(`UPDATE attacks SET started_at = started_at - interval '1 minute'`);
      }
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]).toMatchObject({ type: 'capture' });
    });
  });

  // ------------------------------------------------------------ métriques
  describe('métriques Prometheus', () => {
    it('exposent le trafic, les parties, les captures, les alertes et l’état des services', async () => {
      const res = await app.inject({ url: '/metrics' }); // IP locale = réseau privé
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      const text = res.body;
      expect(text).toMatch(
        /conquest_http_request_duration_seconds_count\{[^}]*route="\/api\/attacks"[^}]*\} \d+/,
      );
      expect(text).toMatch(/conquest_attacks_total\{outcome="started"\} [1-9]/);
      expect(text).toMatch(/conquest_attacks_total\{outcome="validated"\} [1-9]/);
      expect(text).toMatch(/conquest_captures_total [1-9]/);
      expect(text).toMatch(/conquest_alerts_total\{kind="sent"\} [1-9]/);
      expect(text).toMatch(/conquest_alerts_total\{kind="throttled"\} [1-9]/);
      expect(text).toMatch(/conquest_bot_actions_total\{kind="(attack|defend)"\} [1-9]/);
      expect(text).toMatch(/conquest_redis_up 1/);
      expect(text).toMatch(/conquest_season_id \d+/);
      expect(text).toMatch(/conquest_ws_clients \d+/);
      expect(text).toContain('conquest_process_cpu_user_seconds_total');
    });

    it('utilisent le motif de route (cardinalité bornée), pas l’URL brute', async () => {
      await app.inject({ url: '/api/cities/2988507' });
      await app.inject({ url: '/api/cities/2950159' });
      const text = (await app.inject({ url: '/metrics' })).body;
      expect(text).toContain('route="/api/cities/:id"');
      expect(text).not.toContain('route="/api/cities/2988507"');
    });

    it('refusent l’accès depuis Internet, sauf avec le jeton', async () => {
      const pub = { 'x-forwarded-for': '8.8.8.8' }; // derrière Caddy : IP publique du visiteur
      expect((await app.inject({ url: '/metrics', headers: pub })).statusCode).toBe(403);
      expect(
        (
          await app.inject({
            url: '/metrics',
            headers: { ...pub, authorization: 'Bearer mauvais' },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            url: '/metrics',
            headers: { ...pub, authorization: 'Bearer jeton-de-test-0123456789' },
          })
        ).statusCode,
      ).toBe(200);
      // Un réseau privé (Prometheus dans Docker) passe sans jeton.
      expect(
        (await app.inject({ url: '/metrics', headers: { 'x-forwarded-for': '172.18.0.5' } }))
          .statusCode,
      ).toBe(200);
    });
  });
});
