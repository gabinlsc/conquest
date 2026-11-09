import type { LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClanDetail, ClanSummary, MeResponse } from '@conquest/shared';
import { buildApp } from './app';
import { importGeonames } from './geonames/import';
import { FIXTURE_ADMIN1, FIXTURE_CITIES, FIXTURE_COUNTRIES } from './geonames/fixtures';
import { testEnv } from './test-helpers';

/** Intégration auth + factions contre un vrai Postgres (voir cities.integration.test.ts). */
const url = process.env['TEST_DATABASE_URL'];
const files = { cities: FIXTURE_CITIES, countries: FIXTURE_COUNTRIES, admin1: FIXTURE_ADMIN1 };

describe.skipIf(!url)('auth, factions et OAuth', () => {
  const pool = new pg.Pool({ connectionString: url });
  let app: Awaited<ReturnType<typeof buildApp>>;

  // Faux fournisseur Google : aucun appel réseau.
  let googleSub = '123';
  const fetchImpl = ((input: string | URL | Request) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (u.includes('oauth2.googleapis.com/token'))
      return Promise.resolve(Response.json({ access_token: 'tok' }));
    if (u.includes('openidconnect.googleapis.com')) {
      return Promise.resolve(
        Response.json({ sub: googleSub, given_name: 'Zoé', picture: 'https://img/z.png' }),
      );
    }
    return Promise.reject(new Error(`appel inattendu : ${u}`));
  }) as typeof fetch;

  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await importGeonames(pool, files);
    app = await buildApp(testEnv(), { db: pool, fetchImpl });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // Une IP distincte par joueur : évite de déclencher la limite « 10 invités / heure / IP ».
  let ipCounter = 0;
  const nextIp = () => `10.0.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

  interface Player {
    cookie: string;
    ip: string;
    call: (
      method: 'GET' | 'POST' | 'PATCH',
      path: string,
      payload?: unknown,
    ) => Promise<LightMyRequestResponse>;
    me: () => Promise<MeResponse>;
  }

  async function newGuest(countryCode: string, displayName?: string): Promise<Player> {
    const ip = nextIp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/guest',
      headers: { 'x-forwarded-for': ip },
      payload: { countryCode, displayName },
    });
    expect(res.statusCode).toBe(201);
    const cookie = res.cookies.find((c) => c.name === 'conquest_sid')?.value ?? '';
    return makePlayer(cookie, ip);
  }

  function makePlayer(cookie: string, ip: string): Player {
    const call: Player['call'] = (method, path, payload) =>
      app.inject({
        method,
        url: `/api${path}`,
        headers: { 'x-forwarded-for': ip },
        cookies: { conquest_sid: cookie },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
    return { cookie, ip, call, me: async () => (await call('GET', '/me')).json<MeResponse>() };
  }

  describe('compte invité', () => {
    it('anonyme : pas d’utilisateur, pays deviné depuis Accept-Language, providers configurés', async () => {
      const res = await app.inject({
        url: '/api/me',
        headers: { 'accept-language': 'fr-FR,fr;q=0.9' },
      });
      expect(res.json<MeResponse>()).toMatchObject({
        user: null,
        countryHint: 'FR',
        providers: ['google'],
      });
    });

    it('crée un invité, pose un cookie httpOnly et le rattache à la faction de son pays', async () => {
      const ip = nextIp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/guest',
        headers: { 'x-forwarded-for': ip },
        payload: { countryCode: 'fr', displayName: 'Éloïse' },
      });
      expect(res.statusCode).toBe(201);
      const cookie = res.cookies.find((c) => c.name === 'conquest_sid');
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });

      const me = await makePlayer(cookie!.value, ip).me();
      expect(me.user).toMatchObject({ kind: 'guest', displayName: 'Éloïse', countryCode: 'FR' });
      expect(me.faction).toMatchObject({
        kind: 'country',
        countryCode: 'FR',
        name: 'France',
        role: 'member',
      });
    });

    it('le jeton n’est jamais stocké en clair en base', async () => {
      const p = await newGuest('DE');
      const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sessions WHERE encode(token_hash, 'escape') = $1`,
        [p.cookie],
      );
      expect(rows[0]?.n).toBe(0);
    });

    it('refuse un pays inconnu, un pseudo invalide ; ne recrée pas de compte si déjà connecté', async () => {
      const bad = (payload: object) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/guest',
          headers: { 'x-forwarded-for': nextIp() },
          payload,
        });
      expect((await bad({ countryCode: 'ZZ' })).statusCode).toBe(400);
      expect((await bad({ countryCode: 'FR', displayName: '<b>x</b>' })).statusCode).toBe(400);

      const p = await newGuest('JP');
      const again = await p.call('POST', '/auth/guest', { countryCode: 'FR' });
      expect(again.json<MeResponse>().user?.countryCode).toBe('JP');
    });

    it('limite la création de comptes par IP (429)', async () => {
      const ip = nextIp();
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
    });

    it('déconnexion : session supprimée en base, /me redevient anonyme', async () => {
      const p = await newGuest('ES');
      expect((await p.call('POST', '/auth/logout')).statusCode).toBe(204);
      expect((await p.me()).user).toBeNull();
    });

    it('un cookie invalide est ignoré (anonyme)', async () => {
      const p = makePlayer('nimportequoi', nextIp());
      expect((await p.me()).user).toBeNull();
    });
  });

  describe('CSRF', () => {
    it('rejette une mutation venant d’une autre origine, accepte la nôtre', async () => {
      const p = await newGuest('FR');
      const post = (origin: string) =>
        app.inject({
          method: 'PATCH',
          url: '/api/me',
          headers: { origin, 'x-forwarded-for': p.ip },
          cookies: { conquest_sid: p.cookie },
          payload: { displayName: 'Nouveau' },
        });
      expect((await post('https://evil.example')).statusCode).toBe(403);
      expect((await post('http://localhost:3000')).statusCode).toBe(200);
    });
  });

  describe('profil et changement de pays', () => {
    it('401 sans session', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/me',
        payload: { displayName: 'Zoé' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('un joueur hors clan suit sa nouvelle nationalité, avec cooldown ensuite', async () => {
      const p = await newGuest('FR');
      const r1 = await p.call('PATCH', '/me', { countryCode: 'de' });
      expect(r1.json<MeResponse>().faction).toMatchObject({ countryCode: 'DE' });
      const r2 = await p.call('PATCH', '/me', { countryCode: 'US' });
      expect(r2.statusCode).toBe(429);
      expect((await p.me()).faction?.countryCode).toBe('DE');
    });
  });

  describe('clans', () => {
    it('cycle de vie complet : création, nom unique, rejoindre, transfert, dissolution + villes rendues', async () => {
      const a = await newGuest('FR', 'Alice');
      const b = await newGuest('FR', 'Bob');

      const created = await a.call('POST', '/clans', { name: 'Les Aigles', color: '#ff0000' });
      expect(created.statusCode).toBe(201);
      const clanId = created.json<{ id: number }>().id;

      const meA = await a.me();
      expect(meA.faction).toMatchObject({
        kind: 'clan',
        name: 'Les Aigles',
        role: 'owner',
        color: '#ff0000',
      });
      expect(meA.faction?.inviteCode).toMatch(/^[A-Z2-9]{8}$/);

      // Nom unique sans tenir compte de la casse.
      expect(
        (await b.call('POST', '/clans', { name: 'les aigles' })).json<{ code: string }>().code,
      ).toBe('name_taken');

      // Bob rejoint (clan ouvert) ; il ne voit pas le code d'invitation.
      expect((await b.call('POST', `/clans/${clanId}/join`, {})).statusCode).toBe(204);
      const meB = await b.me();
      expect(meB.faction).toMatchObject({
        kind: 'clan',
        role: 'member',
        memberCount: 2,
        inviteCode: null,
      });
      expect(
        (await b.call('POST', '/clans', { name: 'Autre' })).json<{ code: string }>().code,
      ).toBe('already_in_clan');

      const detail = (await app.inject({ url: `/api/clans/${clanId}` })).json<ClanDetail>();
      expect(detail.members.map((m) => m.displayName)).toEqual(['Alice', 'Bob']);

      // Le clan capture une ville (simulation directe en base ; la vraie capture arrive en phase 4).
      await pool.query('UPDATE city_state SET owner_faction_id = $1 WHERE geonames_id = 2988507', [
        clanId,
      ]);

      // Alice (chef) part : Bob hérite, Alice retourne dans la faction France.
      expect((await a.call('POST', '/clans/leave')).json<{ disbanded: boolean }>().disbanded).toBe(
        false,
      );
      expect((await a.me()).faction).toMatchObject({ kind: 'country', countryCode: 'FR' });
      expect((await b.me()).faction).toMatchObject({
        kind: 'clan',
        role: 'owner',
        inviteCode: expect.any(String) as string,
      });

      // Bob (dernier membre) part : clan dissous, Paris revient à la France.
      expect((await b.call('POST', '/clans/leave')).json<{ disbanded: boolean }>().disbanded).toBe(
        true,
      );
      expect((await app.inject({ url: `/api/clans/${clanId}` })).statusCode).toBe(404);
      const paris = await pool.query<{ slug: string }>(
        `SELECT f.slug FROM city_state s JOIN factions f ON f.id = s.owner_faction_id WHERE s.geonames_id = 2988507`,
      );
      expect(paris.rows[0]?.slug).toBe('country:fr');
      expect((await b.me()).faction).toMatchObject({ kind: 'country', countryCode: 'FR' });
    });

    it('clan fermé : code d’invitation requis (insensible à la casse)', async () => {
      const owner = await newGuest('DE');
      const id = (await owner.call('POST', '/clans', { name: 'Elite', open: false })).json<{
        id: number;
      }>().id;
      const code = (await owner.me()).faction?.inviteCode ?? '';
      const c = await newGuest('DE');
      expect((await c.call('POST', `/clans/${id}/join`, {})).statusCode).toBe(403);
      expect(
        (await c.call('POST', `/clans/${id}/join`, { inviteCode: 'AAAAAAAA' })).statusCode,
      ).toBe(403);
      expect(
        (await c.call('POST', `/clans/${id}/join`, { inviteCode: code.toLowerCase() })).statusCode,
      ).toBe(204);
    });

    it('un joueur en clan garde son clan en changeant de pays', async () => {
      const p = await newGuest('FR');
      await p.call('POST', '/clans', { name: 'Nomades' });
      await p.call('PATCH', '/me', { countryCode: 'JP' });
      const me = await p.me();
      expect(me.user?.countryCode).toBe('JP');
      expect(me.faction).toMatchObject({ kind: 'clan', name: 'Nomades' });
      // En quittant, il rejoint la faction de son (nouveau) pays.
      await p.call('POST', '/clans/leave');
      expect((await p.me()).faction).toMatchObject({ countryCode: 'JP' });
    });

    it('liste et recherche de clans, sans jamais exposer le code d’invitation', async () => {
      const p = await newGuest('US');
      await p.call('POST', '/clans', { name: 'Recherchable Zed', open: false });
      const res = await app.inject({ url: '/api/clans?q=zed' });
      const body = res.json<{ items: ClanSummary[]; total: number }>();
      expect(body.total).toBe(1);
      expect(body.items[0]).toMatchObject({
        name: 'Recherchable Zed',
        open: false,
        memberCount: 1,
      });
      expect(res.body).not.toContain('invite');
    });

    it('inscriptions concurrentes : un joueur ne finit jamais dans deux factions', async () => {
      const owner = await newGuest('FR');
      const id = (await owner.call('POST', '/clans', { name: 'Course' })).json<{ id: number }>().id;
      const other = await newGuest('FR');
      const results = await Promise.all(
        Array.from({ length: 5 }, () => other.call('POST', `/clans/${id}/join`, {})),
      );
      // Une seule requête réussit, les autres voient « déjà dans un clan ».
      expect(results.filter((r) => r.statusCode === 204)).toHaveLength(1);
      const otherId = (await other.me()).user!.id;
      const { rows } = await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM faction_members WHERE user_id = $1',
        [otherId],
      );
      expect(rows[0]?.n).toBe(1);
    });
  });

  describe('OAuth (Google)', () => {
    const startFlow = async (cookie?: string, ip = nextIp()) => {
      const res = await app.inject({
        url: '/api/auth/oauth/google/start',
        headers: { 'x-forwarded-for': ip },
        ...(cookie ? { cookies: { conquest_sid: cookie } } : {}),
      });
      const tx = res.cookies.find((c) => c.name === 'conquest_oauth');
      return { res, txCookie: tx?.value ?? '', ip };
    };
    const callback = (
      txCookie: string,
      state: string,
      opts: { cookie?: string; ip: string; lang?: string },
    ) =>
      app.inject({
        url: `/api/auth/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`,
        headers: { 'x-forwarded-for': opts.ip, 'accept-language': opts.lang ?? 'fr-FR' },
        cookies: {
          conquest_oauth: txCookie,
          ...(opts.cookie ? { conquest_sid: opts.cookie } : {}),
        },
      });

    it('start : redirige vers Google avec state + PKCE S256, cookie de transaction signé', async () => {
      const { res } = await startFlow();
      expect(res.statusCode).toBe(302);
      const loc = new URL(res.headers.location as string);
      expect(loc.host).toBe('accounts.google.com');
      expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
      expect(loc.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/api/auth/oauth/google/callback',
      );
      expect(loc.searchParams.get('state')).toBeTruthy();
      expect(res.cookies.find((c) => c.name === 'conquest_oauth')).toMatchObject({
        httpOnly: true,
      });
    });

    it('provider non configuré : 404', async () => {
      const res = await app.inject({ url: '/api/auth/oauth/discord/start' });
      expect(res.statusCode).toBe(404);
    });

    it('nouveau compte OAuth : session, pseudo et pays déduit (Accept-Language)', async () => {
      googleSub = 'sub-new';
      const { res, txCookie, ip } = await startFlow();
      const state = new URL(res.headers.location as string).searchParams.get('state')!;
      const cb = await callback(txCookie, state, { ip });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe('http://localhost:3000/');
      const sid = cb.cookies.find((c) => c.name === 'conquest_sid')!.value;
      const me = await makePlayer(sid, ip).me();
      expect(me.user).toMatchObject({
        kind: 'oauth',
        displayName: 'Zoé',
        avatarUrl: 'https://img/z.png',
        countryCode: 'FR',
      });
      expect(me.faction).toMatchObject({ countryCode: 'FR' });
    });

    it('state invalide ou cookie absent : refusé, aucune session créée', async () => {
      const { txCookie, ip } = await startFlow();
      const bad = await callback(txCookie, 'mauvais-state', { ip });
      expect(bad.headers.location).toContain('auth_error=state');
      expect(bad.cookies.find((c) => c.name === 'conquest_sid')).toBeUndefined();
      const none = await callback('', 'x', { ip });
      expect(none.headers.location).toContain('auth_error=expired');
    });

    it('cookie de transaction falsifié (signature invalide) : refusé', async () => {
      const { res, txCookie, ip } = await startFlow();
      const state = new URL(res.headers.location as string).searchParams.get('state')!;
      const forged = txCookie.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'));
      const cb = await callback(forged, state, { ip });
      expect(cb.headers.location).toContain('auth_error=expired');
    });

    it('un invité qui se connecte garde son compte et sa progression (liaison)', async () => {
      googleSub = 'sub-upgrade';
      const guest = await newGuest('FR', 'Invité');
      await guest.call('POST', '/clans', { name: 'Fidèles' });
      const before = (await guest.me()).user!.id;

      const { res, txCookie } = await startFlow(guest.cookie, guest.ip);
      const state = new URL(res.headers.location as string).searchParams.get('state')!;
      const cb = await callback(txCookie, state, { cookie: guest.cookie, ip: guest.ip });
      const sid = cb.cookies.find((c) => c.name === 'conquest_sid')!.value;
      expect(sid).not.toBe(guest.cookie); // nouvelle session (anti-fixation)

      const me = await makePlayer(sid, guest.ip).me();
      expect(me.user).toMatchObject({ id: before, kind: 'oauth' });
      expect(me.faction).toMatchObject({ kind: 'clan', name: 'Fidèles' }); // progression conservée
      expect((await guest.me()).user).toBeNull(); // ancienne session révoquée
    });

    it('reconnexion avec la même identité Google : même compte', async () => {
      googleSub = 'sub-again';
      const first = await startFlow();
      const s1 = new URL(first.res.headers.location as string).searchParams.get('state')!;
      const c1 = await callback(first.txCookie, s1, { ip: first.ip });
      const id1 = (
        await makePlayer(c1.cookies.find((c) => c.name === 'conquest_sid')!.value, first.ip).me()
      ).user!.id;

      const second = await startFlow();
      const s2 = new URL(second.res.headers.location as string).searchParams.get('state')!;
      const c2 = await callback(second.txCookie, s2, { ip: second.ip });
      const id2 = (
        await makePlayer(c2.cookies.find((c) => c.name === 'conquest_sid')!.value, second.ip).me()
      ).user!.id;
      expect(id2).toBe(id1);
    });
  });
});
