import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  reflexGame,
  type AttackResult,
  type AttackStartResponse,
  type LeaderboardResponse,
  type MyRanks,
  type PastSeason,
  type ReflexInput,
  type ReflexParams,
  type SeasonInfo,
} from '@conquest/shared';
import { buildApp } from './app';
import { importGeonames } from './geonames/import';
import { FIXTURE_ADMIN1, FIXTURE_CITIES, FIXTURE_COUNTRIES } from './geonames/fixtures';
import { K } from './world/store';
import { LB } from './seasons/leaderboards';
import { createTestWorld, testEnv } from './test-helpers';

/** Classements, saisons, anti-triche renforcé et limite de débit Redis (vrai Postgres + vrai Redis). */
const dbUrl = process.env['TEST_DATABASE_URL'];
const redisUrl = process.env['TEST_REDIS_URL'];
const PARIS = 2988507;
const BERLIN = 2950159;
const SANT_CUGAT = 3128760;

describe.skipIf(!dbUrl || !redisUrl)('saisons, classements, anti-triche', () => {
  const pool = new pg.Pool({ connectionString: dbUrl });
  const env = testEnv();
  let world: Awaited<ReturnType<typeof createTestWorld>>;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const seasonEvents: { info: SeasonInfo; reset: boolean }[] = [];

  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await importGeonames(pool, {
      cities: FIXTURE_CITIES,
      countries: FIXTURE_COUNTRIES,
      admin1: FIXTURE_ADMIN1,
    });
    world = await createTestWorld(pool, redisUrl!);
    world.seasons.publisher = { season: (info, reset) => seasonEvents.push({ info, reset }) };
    app = await buildApp(env, { db: pool, world });
  });
  afterAll(async () => {
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

  // ------------------------------------------------------------ joueurs
  let n = 0;
  interface Player {
    id: string;
    ip: string;
    call: (m: 'GET' | 'POST', path: string, payload?: unknown) => Promise<LightMyRequestResponse>;
  }
  async function newPlayer(
    country: string,
    ip = `10.3.${Math.floor(n / 250)}.${(n++ % 250) + 1}`,
  ): Promise<Player> {
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
    const me = (await call('GET', '/me')).json<{ user: { id: string } }>();
    return { id: me.user.id, ip, call };
  }
  /** Joueur « humain » : `salt` change la signature des temps de réaction (donc l'empreinte de la partie). */
  const humanInput = (seed: string, salt: number, base = 300): ReflexInput => ({
    clicks: reflexGame.generate(seed).targets.map((t, i) => ({
      t: t.appearAt + base + ((i * 37 + salt * 53) % 150),
      x: t.x + t.radius * 0.2 * (((i * 13) % 7) / 7 - 0.5),
      y: t.y,
    })),
  });
  async function play(
    p: Player,
    cityId: number,
    salt: number,
    base = 300,
    makeInput = humanInput,
  ): Promise<AttackResult> {
    await pool.query(`UPDATE attacks SET started_at = started_at - interval '10 seconds'`);
    const start = (await p.call('POST', '/attacks', { cityId })).json<
      AttackStartResponse<ReflexParams>
    >();
    await pool.query(
      `UPDATE attacks SET started_at = now() - interval '31 seconds' WHERE id = $1`,
      [start.attackId],
    );
    const res = await p.call('POST', `/attacks/${start.attackId}/submit`, {
      input: makeInput(start.seed, salt, base),
    });
    return res.json<AttackResult>();
  }
  const board = async (path: string) =>
    (await app.inject({ url: `/api/leaderboards/${path}` })).json<LeaderboardResponse>();
  const resetCity = async (cityId: number, owner: number) => {
    await world.store.redis.del(K.city(cityId));
    await world.store.redis.hset(K.owners, cityId, owner);
  };

  // ------------------------------------------------------------ classements
  describe('classements', () => {
    it('une saison active existe dès le démarrage', async () => {
      const s = (await app.inject({ url: '/api/season' })).json<SeasonInfo>();
      expect(s).toMatchObject({ id: 1, name: 'Saison 1' });
      expect(new Date(s.endsAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('attribue des points par joueur, pays et faction ; classe par ordre décroissant', async () => {
      await resetCity(BERLIN, await factionId('DE'));
      const strong = await newPlayer('FR');
      const weak = await newPlayer('FR');
      const german = await newPlayer('DE');
      await play(strong, BERLIN, 1, 250);
      await pool.query(`UPDATE attacks SET started_at = started_at - interval '1 minute'`);
      await play(weak, BERLIN, 2, 900);
      await play(german, BERLIN, 3, 400);

      const players = await board('players');
      const ids = players.entries.map((e) => e.id);
      expect(ids.indexOf(strong.id)).toBeLessThan(ids.indexOf(weak.id)); // plus rapide = plus de points
      expect(players.entries.map((e) => e.rank)).toEqual(players.entries.map((_, i) => i + 1));
      expect(players.entries[0]?.points).toBeGreaterThanOrEqual(players.entries[1]!.points);

      // Filtre par pays : seuls les Français.
      const fr = await board('players?country=fr');
      expect(fr.entries.every((e) => e.countryCode === 'FR')).toBe(true);
      expect(fr.total).toBe(2);

      const nations = await board('nations');
      expect(nations.entries.find((e) => e.name === 'France')?.points).toBeGreaterThan(0);
      expect(nations.entries[0]).toMatchObject({ color: expect.stringMatching(/^#/) as string });
    });

    it('un rejeu de la même attaque ne double jamais les points (idempotence)', async () => {
      const p = await newPlayer('US');
      await resetCity(BERLIN, await factionId('DE'));
      const r = await play(p, BERLIN, 4);
      const before = (await board('players')).entries.find((e) => e.id === p.id)!.points;
      const attackId = r.attackId;
      await pool.query('UPDATE attacks SET applied_at = NULL WHERE id = $1', [attackId]); // simule « effet en attente »
      await world.effects.applyById(attackId);
      await world.effects.applyById(attackId);
      expect((await board('players')).entries.find((e) => e.id === p.id)!.points).toBe(before);
    });

    it('classe les clans séparément des nations, et donne mon rang', async () => {
      const founder = await newPlayer('ES');
      await founder.call('POST', '/clans', { name: 'Podium' });
      await resetCity(SANT_CUGAT, await factionId('JP'));
      await play(founder, SANT_CUGAT, 5);
      const clans = await board('clans');
      expect(clans.entries.find((e) => e.name === 'Podium')?.points).toBeGreaterThan(0);
      expect((await board('nations')).entries.some((e) => e.name === 'Podium')).toBe(false);

      const mine = (await founder.call('GET', '/leaderboards/me')).json<MyRanks>();
      expect(mine.player?.rank).toBeGreaterThan(0);
      expect(mine.faction).toMatchObject({ kind: 'clan', name: 'Podium' });
      const anon = await app.inject({ url: '/api/leaderboards/me' });
      expect(anon.statusCode).toBe(401);
    });

    it('verse un revenu de territoire une seule fois par tranche de 5 minutes', async () => {
      const season = await world.seasons.current();
      const before = await world.store.redis.zscore(
        LB.nations(season.id),
        String(await factionId('FR')),
      );
      const at = 1_900_000_000_000;
      await world.seasons.territoryTick(season.id, at);
      const once = await world.store.redis.zscore(
        LB.nations(season.id),
        String(await factionId('FR')),
      );
      await world.seasons.territoryTick(season.id, at + 1_000); // même tranche
      const twice = await world.store.redis.zscore(
        LB.nations(season.id),
        String(await factionId('FR')),
      );
      expect(Number(once)).toBeGreaterThan(Number(before ?? 0));
      expect(twice).toBe(once);
      await world.seasons.territoryTick(season.id, at + 300_000); // tranche suivante
      expect(
        Number(
          await world.store.redis.zscore(LB.nations(season.id), String(await factionId('FR'))),
        ),
      ).toBeGreaterThan(Number(once));
    });

    it('persiste les classements dans Postgres puis les restaure après une perte de Redis', async () => {
      const season = await world.seasons.current();
      while ((await world.leaderboards.flush()) > 0);
      const before = await board('players');
      expect(
        (
          await pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM season_scores WHERE kind = $1',
            ['player'],
          )
        ).rows[0]!.n,
      ).toBe(before.total);

      await world.store.redis.flushdb();
      await world.store.hydrateIfEmpty(pool);
      await world.leaderboards.ensureSeasonLoaded(season.id);
      const after = await board('players');
      expect(after.entries).toEqual(before.entries);
    });

    it('reste lisible quand Redis est tombé (repli sur Postgres)', async () => {
      world.store.redis.disconnect();
      await new Promise((r) => setTimeout(r, 100));
      const res = await board('players');
      expect(res.entries.length).toBeGreaterThan(0);
      expect(res.entries[0]?.name).toBeTruthy();
      world.store.redis.connect().catch(() => undefined);
      await new Promise<void>((resolve) => {
        const t = setInterval(() => world.store.isUp() && (clearInterval(t), resolve()), 50);
      });
      await world.store.hydrateIfEmpty(pool);
    });
  });

  // ------------------------------------------------------------ anti-triche
  describe('anti-triche renforcé', () => {
    const flagsOf = async (attackId: string) =>
      (await pool.query<{ flags: string[] }>('SELECT flags FROM attacks WHERE id = $1', [attackId]))
        .rows[0]!.flags;
    const suspicionOf = async (userId: string) =>
      Number(
        (
          await pool.query<{ s: number }>(
            'SELECT suspicion AS s FROM anticheat_state WHERE user_id = $1',
            [userId],
          )
        ).rows[0]?.s ?? 0,
      );

    it('détecte le rejeu d’un enregistrement : même empreinte de réactions sur deux graines différentes', async () => {
      await resetCity(BERLIN, await factionId('DE'));
      const a = await newPlayer('FR');
      const b = await newPlayer('FR');
      const first = await play(a, BERLIN, 40);
      const second = await play(b, BERLIN, 40); // même signature de réactions, autre graine
      expect(await flagsOf(first.attackId)).not.toContain('soft:replayed_pattern');
      expect(await flagsOf(second.attackId)).toContain('soft:replayed_pattern');
      expect(await suspicionOf(b.id)).toBeGreaterThanOrEqual(70);
      expect(await suspicionOf(a.id)).toBe(0);
    });

    it('place un joueur très suspect en shadow ban : résultat plausible mais aucun effet ni point', async () => {
      await resetCity(SANT_CUGAT, await factionId('ES'));
      const cheater = await newPlayer('JP');
      const accomplice = await newPlayer('JP');
      await play(accomplice, SANT_CUGAT, 50);
      // Le tricheur rejoue deux fois le même enregistrement : 2 x 70 > seuil de 100.
      await play(cheater, SANT_CUGAT, 50);
      const banned = await play(cheater, SANT_CUGAT, 51);
      await play(cheater, SANT_CUGAT, 51);
      expect(
        (
          await pool.query<{ shadow_banned: boolean }>(
            'SELECT shadow_banned FROM users WHERE id = $1',
            [cheater.id],
          )
        ).rows[0]!.shadow_banned,
      ).toBe(true);
      expect(banned.validated).toBe(true);

      const pointsBefore =
        (await board('players')).entries.find((e) => e.id === cheater.id)?.points ?? 0;
      const ownerBefore = Number(await world.store.redis.hget(K.owners, String(SANT_CUGAT)));
      const ghost = await play(cheater, SANT_CUGAT, 52);
      // Le joueur reçoit un effet qui ressemble à un effet normal...
      expect(ghost).toMatchObject({ validated: true });
      expect(ghost.effect).toMatchObject({
        cityId: SANT_CUGAT,
        gain: expect.any(Number) as number,
      });
      // ... mais le monde et le classement n'ont pas bougé.
      expect(Number(await world.store.redis.hget(K.owners, String(SANT_CUGAT)))).toBe(ownerBefore);
      expect((await board('players')).entries.find((e) => e.id === cheater.id)?.points ?? 0).toBe(
        pointsBefore,
      );
      expect(await flagsOf(ghost.attackId)).toContain('ghost');

      // Un faux positif se corrige : réhabilitation, puis les parties comptent de nouveau.
      expect(await world.anticheat.unban(cheater.id)).toBe(true);
      const restored = await play(cheater, SANT_CUGAT, 53);
      expect(restored.effect).toBeTruthy();
      expect(
        (await board('players')).entries.find((e) => e.id === cheater.id)?.points ?? 0,
      ).toBeGreaterThan(pointsBefore);
    });

    it('un joueur honnête n’est jamais sanctionné par quelques drapeaux isolés', async () => {
      await resetCity(BERLIN, await factionId('DE'));
      const p = await newPlayer('US');
      for (let i = 0; i < 3; i++) await play(p, BERLIN, 60 + i, 280);
      expect(
        (
          await pool.query<{ shadow_banned: boolean }>(
            'SELECT shadow_banned FROM users WHERE id = $1',
            [p.id],
          )
        ).rows[0]!.shadow_banned,
      ).toBe(false);
    });

    it('repère une ferme de comptes : trop de comptes distincts depuis la même IP', async () => {
      await resetCity(BERLIN, await factionId('DE'));
      const sharedIp = '10.99.99.99';
      let last!: AttackResult;
      for (let i = 0; i < 8; i++) {
        const p = await newPlayer('FR', sharedIp);
        last = await play(p, BERLIN, 70 + i);
      }
      expect(await flagsOf(last.attackId)).toContain('soft:ip_cluster');
    });

    it('signale un score statistiquement aberrant, sans polluer la distribution de référence', async () => {
      await world.store.redis.hset('ac:stats:reflex', { n: 500, mean: 0.45, m2: 500 * 0.01 }); // sd ≈ 0.1
      await resetCity(BERLIN, await factionId('DE'));
      const p = await newPlayer('ES');
      // Score quasi parfait mais temps de réaction plausibles (≥ 100 ms) : seule la statistique le distingue.
      const r = await play(p, BERLIN, 80, 0, (seed, salt) => ({
        clicks: reflexGame
          .generate(seed)
          .targets.map((t, i) => ({ t: t.appearAt + 110 + ((i * 7 + salt) % 25), x: t.x, y: t.y })),
      }));
      expect(r.score / r.maxScore).toBeGreaterThan(0.9);
      expect(await flagsOf(r.attackId)).toContain('soft:score_outlier');
      expect(Number(await world.store.redis.hget('ac:stats:reflex', 'n'))).toBe(500);
    });

    it('limite le débit via Redis : compteurs partagés, par joueur connecté', async () => {
      const ip = '10.77.0.1';
      const codes: number[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await app.inject({
          method: 'POST',
          url: '/api/auth/guest',
          headers: { 'x-forwarded-for': ip },
          payload: { countryCode: 'FR' },
        });
        codes.push(r.statusCode);
      }
      expect(codes.filter((c) => c === 201)).toHaveLength(10);
      expect(codes.at(-1)).toBe(429);
      expect((await world.store.redis.keys('rl:*')).length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------ saisons
  describe('changement de saison', () => {
    it('refuse les nouvelles parties pendant la remise à zéro (503)', async () => {
      const p = await newPlayer('FR');
      world.seasons.paused = true;
      const res = await p.call('POST', '/attacks', { cityId: BERLIN });
      world.seasons.paused = false;
      expect(res.statusCode).toBe(503);
      expect(res.json<{ code: string }>().code).toBe('season_rollover');
    });

    it('clôture la saison : podium figé, carte remise à zéro, nouvelle saison, clients prévenus', async () => {
      const [fr, de, jp] = [await factionId('FR'), await factionId('DE'), await factionId('JP')];
      // Etat de jeu à remettre à zéro : Paris conquise par le Japon avec de l'influence.
      await world.store.applyAttack({
        attackId: 'roll-1',
        cityId: PARIS,
        factionId: jp,
        gain: 100,
        now: Date.now() - 600_000,
      });
      await world.store.applyAttack({
        attackId: 'roll-2',
        cityId: PARIS,
        factionId: jp,
        gain: 100,
        now: Date.now() - 600_000,
      });
      expect(Number(await world.store.redis.hget(K.owners, String(PARIS)))).toBe(jp);
      const topBefore = (await board('players')).entries[0]!;

      await pool.query(
        `UPDATE seasons SET ends_at = now() - interval '1 minute' WHERE status = 'active'`,
      );
      await world.seasons.tick();

      // Nouvelle saison active, l'ancienne est close avec son podium.
      const active = await pool.query<{ id: number; name: string }>(
        `SELECT id, name FROM seasons WHERE status = 'active'`,
      );
      expect(active.rows).toEqual([{ id: 2, name: 'Saison 2' }]);
      const past = (await app.inject({ url: '/api/seasons' })).json<PastSeason[]>();
      expect(past[0]).toMatchObject({ id: 1, name: 'Saison 1' });
      expect(past[0]?.winners.players[0]).toMatchObject({
        id: topBefore.id,
        points: topBefore.points,
      });

      // Carte remise à zéro dans Redis ET Postgres : chaque ville retrouve son pays, sans influence.
      expect(Number(await world.store.redis.hget(K.owners, String(PARIS)))).toBe(fr);
      expect(Number(await world.store.redis.hget(K.owners, String(BERLIN)))).toBe(de);
      const paris = await pool.query<{ owner_faction_id: number; influence: unknown }>(
        'SELECT owner_faction_id, influence FROM city_state WHERE geonames_id = $1',
        [PARIS],
      );
      expect(paris.rows[0]).toMatchObject({ owner_faction_id: fr, influence: {} });
      expect(await world.store.getCity(PARIS)).toMatchObject({ owner: fr, influence: {} });

      // Classements de la nouvelle saison vides ; ceux de l'ancienne conservés en base.
      expect((await board('players')).total).toBe(0);
      expect(
        (
          await pool.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM season_scores WHERE season_id = 1',
          )
        ).rows[0]!.n,
      ).toBeGreaterThan(0);

      // Les clients sont prévenus pour tout recharger ; les parties reprennent.
      expect(seasonEvents.at(-1)).toMatchObject({ reset: true, info: { id: 2 } });
      expect(world.seasons.paused).toBe(false);
      const p = await newPlayer('DE');
      expect((await p.call('POST', '/attacks', { cityId: PARIS })).statusCode).toBe(201);
    });

    it('ne clôture qu’une fois, même si deux processus s’y essaient en même temps', async () => {
      await pool.query(
        `UPDATE seasons SET ends_at = now() - interval '1 minute' WHERE status = 'active'`,
      );
      const info = await world.seasons.current().then(() => world.seasons.refresh());
      const results = await Promise.all([
        world.seasons.rollover(info),
        world.seasons.rollover(info),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      const seasons = await pool.query<{ id: number; status: string }>(
        'SELECT id, status FROM seasons ORDER BY id',
      );
      expect(seasons.rows.filter((s) => s.status === 'active')).toHaveLength(1);
      expect(seasons.rows).toHaveLength(3);
    });
  });
});
