import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  influenceGain,
  reflexGame,
  resolveAttack,
  tileOf,
  type AttackResult,
  type AttackStartResponse,
  type City,
  type CityDelta,
  type CityInfluenceState,
  type ClientToServerEvents,
  type GameEvent,
  type ReflexInput,
  type ReflexParams,
  type ServerToClientEvents,
  type TileSnapshot,
} from '@conquest/shared';
import { buildApp } from './app';
import { importGeonames } from './geonames/import';
import { FIXTURE_ADMIN1, FIXTURE_CITIES, FIXTURE_COUNTRIES } from './geonames/fixtures';
import { K } from './world/store';
import { attachTestGateway, createTestWorld, testEnv } from './test-helpers';

/**
 * Intégration du monde temps réel : Redis (Lua), write-behind Postgres, passerelle Socket.IO,
 * mode dégradé. Nécessite TEST_DATABASE_URL et TEST_REDIS_URL (la base Redis ciblée est vidée).
 */
const dbUrl = process.env['TEST_DATABASE_URL'];
const redisUrl = process.env['TEST_REDIS_URL'];
const SANT_CUGAT = 3128760; // ES, valeur 3 -> garnison 100
const PARIS = 2988507;
const BERLIN = 2950159;
const TOKYO = 1850147;

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe.skipIf(!dbUrl || !redisUrl)('monde temps réel', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });
  const env = testEnv();
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
    app = await buildApp(env, { db: pool, world });
    gateway = attachTestGateway(app, pool, world);
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

  // ---------------------------------------------------------------- hydratation
  describe('hydratation', () => {
    it('charge Postgres dans Redis une seule fois (idempotent)', async () => {
      expect(await world.store.redis.hlen(K.owners)).toBe(7);
      expect(await world.store.hydrateIfEmpty(pool)).toBe(false);
      const fr = await factionId('FR');
      expect(await world.store.redis.hget(K.owners, String(PARIS))).toBe(String(fr));
    });
  });

  // ---------------------------------------------------------------- Lua vs référence TS
  describe('script Lua atomique', () => {
    it('est équivalent à resolveAttack sur des scénarios aléatoires (test différentiel)', async () => {
      // Générateur pseudo-aléatoire déterministe pour des échecs reproductibles.
      let seed = 12345;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
      const cityIds = [PARIS, BERLIN, TOKYO, SANT_CUGAT];
      const factions = [101, 102, 103]; // ids arbitraires : le script ne consulte pas Postgres
      const t0 = 1_700_000_000_000;

      for (let scenario = 0; scenario < 60; scenario++) {
        const cityId = cityIds[scenario % cityIds.length]!;
        const value = world.geo.get(cityId)!.value;
        // Repart d'un état propre pour cette ville.
        await world.store.redis.del(K.city(cityId));
        const initialOwner = Number(await world.store.redis.hget(K.owners, String(cityId)));
        let now = t0 + scenario * 1_000_000;
        let model: CityInfluenceState = {
          owner: initialOwner,
          influence: {},
          lastTouch: now,
          shieldUntil: 0,
        };

        for (let step = 0; step < 25; step++) {
          now += Math.floor(rnd() * 3 * 3_600_000 * (rnd() < 0.3 ? 1 : 0.01));
          const attacker =
            rnd() < 0.2 ? model.owner || factions[0]! : factions[Math.floor(rnd() * 3)]!;
          const gain = Math.floor(rnd() * 101);
          const expected = resolveAttack(model, attacker, gain, now, value);
          const got = await world.store.applyAttack({
            attackId: `diff-${scenario}-${step}`,
            cityId,
            factionId: attacker,
            gain,
            now,
          });
          const label = `scénario ${scenario} étape ${step}`;
          expect(got.owner, label).toBe(expected.state.owner);
          expect([got.captured, got.defended, got.shielded], label).toEqual([
            expected.captured,
            expected.defended,
            expected.shielded,
          ]);
          expect(got.ownerInfluence, label).toBe(expected.ownerInfluence);
          expect(got.shieldUntil, label).toBe(expected.state.shieldUntil);
          const expectedInf = Object.entries(expected.state.influence)
            .map(([f, v]) => [Number(f), v] as [number, number])
            .sort((a, b) => a[0] - b[0]);
          expect(got.influence, label).toEqual(expectedInf);
          model = expected.state;
        }
      }
    });

    it('est idempotent : rejouer la même attaque ne compte pas deux fois', async () => {
      const cityId = SANT_CUGAT;
      await world.store.redis.del(K.city(cityId));
      const args = { attackId: 'idem-1', cityId, factionId: 201, gain: 30, now: Date.now() };
      const first = await world.store.applyAttack(args);
      const again = await world.store.applyAttack(args);
      expect(first.replay).toBe(false);
      expect(again.replay).toBe(true);
      expect(again.ver).toBe(first.ver);
      expect(again.influence).toEqual(first.influence);
      const live = await world.store.getCity(cityId);
      expect(live?.influence[201]).toBe(30); // et non 60
    });

    it('résout des attaques simultanées sans perte : versions uniques et capture unique', async () => {
      const cityId = SANT_CUGAT;
      await world.store.redis.del(K.city(cityId));
      await world.store.redis.hset(K.owners, cityId, 301); // propriétaire connu : faction 301
      const now = Date.now();
      // 2 factions rivales, 20 attaques chacune, toutes lancées en même temps.
      const jobs = Array.from({ length: 40 }, (_, i) =>
        world.store.applyAttack({
          attackId: `race-${i}`,
          cityId,
          factionId: i % 2 === 0 ? 302 : 303,
          gain: 15,
          now,
        }),
      );
      const results = await Promise.all(jobs);
      // Une seule capture : le bouclier interdit au rival de reprendre la ville dans la foulée.
      expect(results.filter((r) => r.captured)).toHaveLength(1);
      // Chaque attaque a obtenu un numéro de version distinct et consécutif : aucune écriture perdue.
      const vers = results.map((r) => r.ver).sort((a, b) => a - b);
      expect(new Set(vers).size).toBe(40);
      expect(vers.at(-1)! - vers[0]!).toBe(39);
      const live = await world.store.getCity(cityId);
      expect([302, 303]).toContain(live?.owner);
    });
  });

  // ---------------------------------------------------------------- write-behind
  describe('persistance Redis -> Postgres', () => {
    it('persiste les villes modifiées puis restaure l’état après une perte totale de Redis', async () => {
      const cityId = BERLIN;
      const de = await factionId('DE');
      const jp = await factionId('JP');
      // État de départ explicite : Berlin à l'Allemagne, sans influence résiduelle d'un test précédent.
      await world.store.redis.del(K.city(cityId));
      await world.store.redis.hset(K.owners, cityId, de);
      await world.store.applyAttack({
        attackId: 'persist-1',
        cityId,
        factionId: jp,
        gain: 100,
        now: Date.now(),
      });
      await world.store.applyAttack({
        attackId: 'persist-2',
        cityId,
        factionId: jp,
        gain: 100,
        now: Date.now(),
      });
      expect(await world.store.pendingCount()).toBeGreaterThan(0);
      while ((await world.store.persistDirty(pool)) > 0);
      expect(await world.store.pendingCount()).toBe(0);

      const row = await pool.query<{
        owner_faction_id: number;
        influence: { i: Record<string, number> };
      }>('SELECT owner_faction_id, influence FROM city_state WHERE geonames_id = $1', [cityId]);
      expect(row.rows[0]?.owner_faction_id).toBe(jp);
      expect(row.rows[0]?.influence.i[String(jp)]).toBeGreaterThan(0);
      expect(row.rows[0]?.influence.i[String(de)]).toBeDefined();

      // Perte totale de Redis -> ré-hydratation depuis Postgres : même propriétaire, même influence.
      const before = await world.store.getCity(cityId);
      await world.store.redis.flushdb();
      expect(await world.store.hydrateIfEmpty(pool)).toBe(true);
      const after = await world.store.getCity(cityId);
      expect(after?.owner).toBe(before?.owner);
      expect(after?.influence).toEqual(before?.influence);
      // La séquence repart de l'horloge : les versions restent croissantes pour les clients déjà connectés.
      expect(after!.ver).toBeGreaterThanOrEqual(before!.ver);
    });
  });

  async function client(cookie?: string): Promise<ClientSocket> {
    const s: ClientSocket = connect(baseUrl, {
      path: '/ws',
      transports: ['websocket'],
      extraHeaders: cookie ? { cookie: `conquest_sid=${cookie}` } : {},
      reconnection: false,
    });
    sockets.push(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    return s;
  }
  const waitFor = <T>(
    s: ClientSocket,
    event: 'delta' | 'tiles' | 'presence' | 'feed:init',
    pick?: (v: T) => boolean,
  ) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`délai dépassé : ${event}`)), 4000);
      const handler = (v: T) => {
        if (pick && !pick(v)) return;
        clearTimeout(timer);
        (s as Socket).off(event, handler);
        resolve(v);
      };
      (s as Socket).on(event, handler);
    });
  /** Attend un événement du flux (livré par lots) satisfaisant `pick`. */
  const waitEvent = (s: ClientSocket, pick: (e: GameEvent) => boolean) =>
    new Promise<GameEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('délai dépassé : events')), 4000);
      const handler = (list: GameEvent[]) => {
        const hit = list.find(pick);
        if (!hit) return;
        clearTimeout(timer);
        (s as Socket).off('events', handler);
        resolve(hit);
      };
      (s as Socket).on('events', handler);
    });
  const subscribe = (s: ClientSocket, tiles: string[]) =>
    new Promise<string[]>((resolve) => s.emit('sub', tiles, (r) => resolve(r.tiles)));
  const collect = (s: ClientSocket) => {
    const got: CityDelta[] = [];
    s.on('delta', (d) => got.push(d));
    return got;
  };

  // ---------------------------------------------------------------- joueurs & parties
  let n = 0;
  interface Player {
    cookie: string;
    ip: string;
    call: (m: 'GET' | 'POST', path: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  }
  async function newPlayer(country: string): Promise<Player> {
    const ip = `10.2.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/guest',
      headers: { 'x-forwarded-for': ip },
      payload: { countryCode: country },
    });
    const cookie = res.cookies.find((c) => c.name === 'conquest_sid')!.value;
    return {
      cookie,
      ip,
      call: (method, path, payload) =>
        app.inject({
          method,
          url: `/api${path}`,
          headers: { 'x-forwarded-for': ip },
          cookies: { conquest_sid: cookie },
          ...(payload === undefined ? {} : { payload: payload as object }),
        }),
    };
  }
  const humanInput = (seed: string): ReflexInput => ({
    clicks: reflexGame.generate(seed).targets.map((t, i) => ({
      t: t.appearAt + 300 + ((i * 37) % 120),
      x: t.x + t.radius * 0.2 * (((i * 13) % 7) / 7 - 0.5),
      y: t.y,
    })),
  });
  /** Joue (et gagne) une partie complète sur une ville ; antidate le démarrage pour simuler 31 s de jeu. */
  async function playAttack(p: Player, cityId: number): Promise<LightMyRequestResponse> {
    await pool.query(`UPDATE attacks SET started_at = started_at - interval '10 seconds'`);
    const start = (await p.call('POST', '/attacks', { cityId })).json<
      AttackStartResponse<ReflexParams>
    >();
    await pool.query(
      `UPDATE attacks SET started_at = now() - interval '31 seconds' WHERE id = $1`,
      [start.attackId],
    );
    return p.call('POST', `/attacks/${start.attackId}/submit`, { input: humanInput(start.seed) });
  }

  describe('effet d’une attaque', () => {
    it('applique l’influence, capture la ville, enregistre et publie l’événement, une seule fois', async () => {
      const es = await factionId('ES');
      const jp = await factionId('JP');
      await world.store.redis.del(K.city(SANT_CUGAT));
      await world.store.redis.hset(K.owners, SANT_CUGAT, es);

      const p1 = await newPlayer('JP');
      const r1 = await playAttack(p1, SANT_CUGAT);
      const res1 = r1.json<AttackResult>();
      expect(res1.validated).toBe(true);
      expect(res1.effect).toMatchObject({
        captured: false,
        defended: false,
        ownerFactionId: es,
        garrison: 100,
      });
      expect(res1.effect!.gain).toBe(influenceGain(res1.score, res1.maxScore));

      const p2 = await newPlayer('JP');
      const res2 = (await playAttack(p2, SANT_CUGAT)).json<AttackResult>();
      expect(res2.effect).toMatchObject({
        captured: true,
        ownerFactionId: jp,
        prevOwnerFactionId: es,
      });

      // L'état chaud est à jour et visible par l'API.
      const city = (await p1.call('GET', `/cities/${SANT_CUGAT}`)).json<City>();
      expect(city.ownerFactionId).toBe(jp);
      expect(city.influence[0]?.factionId).toBe(jp);
      expect(city.influence.some((i) => i.factionId === es)).toBe(true);

      // Un événement dans le flux, et rejouer la soumission ne le duplique pas.
      const before = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM events');
      const attackId = (
        await pool.query<{ id: string }>('SELECT id FROM attacks ORDER BY started_at DESC LIMIT 1')
      ).rows[0]!.id;
      const retry = await p2.call('POST', `/attacks/${attackId}/submit`, { input: { clicks: [] } });
      expect(retry.json<AttackResult>().effect).toEqual(res2.effect);
      const after = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM events');
      expect(after.rows[0]!.n).toBe(before.rows[0]!.n);

      const feed = (await app.inject({ url: '/api/events?limit=5' })).json<GameEvent[]>();
      expect(feed[0]).toMatchObject({
        type: 'capture',
        cityName: 'Sant Cugat del Vallès',
        by: expect.any(String) as string,
      });
      expect(feed[0]?.faction.id).toBe(jp);
    });

    it('défendre sa propre ville renforce l’occupant', async () => {
      const de = await factionId('DE');
      await world.store.redis.del(K.city(BERLIN));
      await world.store.redis.hset(K.owners, BERLIN, de);
      const p = await newPlayer('DE');
      const res = (await playAttack(p, BERLIN)).json<AttackResult>();
      expect(res.effect).toMatchObject({ defended: true, captured: false, ownerFactionId: de });
      expect(res.effect!.ownerInfluence).toBeGreaterThan(res.effect!.garrison);
    });
  });

  // ---------------------------------------------------------------- Socket.IO
  describe('passerelle temps réel', () => {
    const tileEs = tileOf(2.08, 41.47);

    it('envoie un instantané de la tuile puis des deltas, uniquement aux abonnés de la zone', async () => {
      const es = await factionId('ES');
      await world.store.redis.del(K.city(SANT_CUGAT));
      await world.store.redis.hset(K.owners, SANT_CUGAT, es);

      const near = await client();
      const far = await client();
      const farDeltas = collect(far);
      const nearSnap = waitFor<TileSnapshot>(near, 'tiles', (s) => s.tile === tileEs);
      expect(await subscribe(near, [tileEs])).toEqual([tileEs]);
      await subscribe(far, ['0:0']);

      const snap = await nearSnap;
      const entry = snap.cities.find((c) => c[0] === SANT_CUGAT);
      expect(entry?.[1]).toBe(es);
      expect(snap.factions.some((f) => f.id === es)).toBe(true);

      const delta = waitFor<CityDelta>(near, 'delta', (d) => d.id === SANT_CUGAT);
      const jp = await newPlayer('JP');
      const jp2 = await newPlayer('JP');
      await playAttack(jp, SANT_CUGAT);
      await playAttack(jp2, SANT_CUGAT);

      const d = await delta;
      expect(d.ver).toBeGreaterThan(entry![2]);
      expect(d.inf.length).toBeGreaterThan(0);
      // Le client de l'autre bout du monde n'a reçu AUCUN delta de cette zone.
      await new Promise((r) => setTimeout(r, 200));
      expect(farDeltas).toHaveLength(0);
    });

    it('diffuse les captures à tous via le flux d’événements, anonymes compris', async () => {
      const de = await factionId('DE');
      await world.store.redis.del(K.city(PARIS));
      await world.store.redis.hset(K.owners, PARIS, await factionId('FR'));
      const spectator = await client(); // aucun cookie
      const ev = waitEvent(spectator, (e) => e.cityId === PARIS);
      const attackers = await Promise.all([
        newPlayer('DE'),
        newPlayer('DE'),
        newPlayer('DE'),
        newPlayer('DE'),
      ]);
      for (const a of attackers) await playAttack(a, PARIS); // Paris : garnison élevée, il faut plusieurs joueurs
      const e = await ev;
      expect(e).toMatchObject({ type: 'capture', cityName: 'Paris', countryCode: 'FR' });
      expect(e.faction.id).toBe(de);
      expect(e.from?.name).toBe('France');
    });

    it('limite et valide les abonnements (tuiles invalides ignorées, plafond par client)', async () => {
      const s = await client();
      const every = Array.from({ length: 16 }, (_, x) =>
        Array.from({ length: 8 }, (_, y) => `${x}:${y}`),
      ).flat();
      const accepted = await subscribe(s, ['nimporte', '99:99', ...every]);
      expect(accepted.length).toBe(48);
      expect(accepted.every((t) => /^\d+:\d+$/.test(t))).toBe(true);
      // Remplacement : se désabonner de tout.
      expect(await subscribe(s, [])).toEqual([]);
    });

    it('freine les clients qui spamment les abonnements', async () => {
      const s = await client();
      const results: number[] = [];
      for (let i = 0; i < 40; i++) results.push((await subscribe(s, [`${i % 16}:0`])).length);
      // Au-delà de la rafale autorisée, l'état d'abonnement ne bouge plus (messages ignorés).
      expect(new Set(results.slice(-10)).size).toBe(1);
    });

    it('envoie la présence et l’historique du flux à la connexion', async () => {
      const s = await client();
      const presence = await waitFor<{ online: number }>(s, 'presence');
      expect(presence.online).toBeGreaterThanOrEqual(1);
      expect(gateway.online()).toBeGreaterThanOrEqual(1);
    });

    it('authentifie la session par cookie ; un cookie invalide reste simple spectateur', async () => {
      const p = await newPlayer('FR');
      const ok = await client(p.cookie);
      const bad = await client('nimportequoi');
      expect(ok.connected).toBe(true);
      expect(bad.connected).toBe(true);
    });
  });

  // ---------------------------------------------------------------- clan dissous
  describe('dissolution d’un clan', () => {
    it('rend ses villes à leur pays, dans Redis et sur les cartes ouvertes', async () => {
      const owner = await newPlayer('FR');
      const clanId = (await owner.call('POST', '/clans', { name: 'Éphémères' })).json<{
        id: number;
      }>().id;
      const fr = await factionId('FR');
      await world.store.redis.del(K.city(PARIS)); // pas de bouclier ni d'influence hérités d'un autre test
      await world.store.redis.hset(K.owners, PARIS, fr);
      await world.store.applyAttack({
        attackId: 'clan-cap',
        cityId: PARIS,
        factionId: clanId,
        gain: 100,
        now: Date.now() - 120_000,
      });
      await world.store.applyAttack({
        attackId: 'clan-cap-2',
        cityId: PARIS,
        factionId: clanId,
        gain: 100,
        now: Date.now() - 120_000,
      });
      expect((await world.store.getCity(PARIS))?.owner).toBe(clanId);

      const watcher = await (async () => {
        const s: ClientSocket = connect(baseUrl, {
          path: '/ws',
          transports: ['websocket'],
          reconnection: false,
        });
        sockets.push(s);
        await new Promise<void>((r) => s.once('connect', () => r()));
        return s;
      })();
      await subscribe(watcher, [tileOf(2.35, 48.85)]);
      const delta = waitFor<CityDelta>(watcher, 'delta', (d) => d.id === PARIS);

      expect(
        (await owner.call('POST', '/clans/leave')).json<{ disbanded: boolean }>().disbanded,
      ).toBe(true);
      const d = await delta;
      expect(d.owner).toBe(fr);
      expect(d.faction?.name).toBe('France');
      expect((await world.store.getCity(PARIS))?.owner).toBe(fr);
      // Le write-behind ne se heurte pas à la clé étrangère d'un clan supprimé.
      while ((await world.store.persistDirty(pool)) > 0);
      const row = await pool.query<{ owner_faction_id: number }>(
        'SELECT owner_faction_id FROM city_state WHERE geonames_id = $1',
        [PARIS],
      );
      expect(row.rows[0]?.owner_faction_id).toBe(fr);
    });
  });

  // ---------------------------------------------------------------- mode dégradé
  describe('mode dégradé (Redis indisponible)', () => {
    it('garde le jeu lisible, met l’effet en attente, puis le rattrape au retour de Redis', async () => {
      const es = await factionId('ES');
      const jp = await factionId('JP');
      await world.store.redis.del(K.city(SANT_CUGAT));
      await world.store.redis.hset(K.owners, SANT_CUGAT, es);
      while ((await world.store.persistDirty(pool)) > 0);

      const p1 = await newPlayer('JP');
      const p2 = await newPlayer('JP');

      world.store.redis.disconnect();
      await new Promise((r) => setTimeout(r, 100));
      expect(world.store.isUp()).toBe(false);

      // Santé : dégradé mais vivant.
      const health = (await app.inject({ url: '/api/health' })).json<{
        status: string;
        services: { redis: string };
      }>();
      expect(health).toMatchObject({ status: 'degraded', services: { redis: 'down' } });

      // Lecture : la carte et le détail de ville restent servis (copie Postgres).
      const city = await p1.call('GET', `/cities/${SANT_CUGAT}`);
      expect(city.statusCode).toBe(200);
      expect(
        (await world.store.tileSnapshotFromPg(pool, tileOf(2.08, 41.47))).length,
      ).toBeGreaterThan(0);

      // Écriture : la partie est scorée et enregistrée ; l'effet est simplement en attente.
      const r1 = (await playAttack(p1, SANT_CUGAT)).json<AttackResult>();
      const r2 = (await playAttack(p2, SANT_CUGAT)).json<AttackResult>();
      expect(r1).toMatchObject({ validated: true, effect: null });
      expect(r2.validated).toBe(true);
      const pending = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM attacks WHERE validated AND applied_at IS NULL',
      );
      expect(pending.rows[0]!.n).toBeGreaterThanOrEqual(2);
      expect(await world.effects.reconcile()).toBe(0); // Redis toujours absent : rien n'est tenté

      // Retour de Redis : l'état est rechargé si besoin et les attaques en attente sont rejouées.
      world.store.redis.connect().catch(() => undefined);
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (world.store.isUp()) {
            clearInterval(poll);
            resolve();
          }
        }, 50);
      });
      await world.store.hydrateIfEmpty(pool);
      await pool.query(
        `UPDATE attacks SET submitted_at = now() - interval '10 seconds' WHERE validated AND applied_at IS NULL`,
      );
      expect(await world.effects.reconcile()).toBeGreaterThanOrEqual(2);
      expect((await world.store.getCity(SANT_CUGAT))?.owner).toBe(jp); // les deux attaques ont bien été comptées
    });
  });
});
