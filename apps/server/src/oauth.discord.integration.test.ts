import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeResponse } from '@conquest/shared';
import { buildApp } from './app';
import { importGeonames } from './geonames/import';
import { FIXTURE_ADMIN1, FIXTURE_CITIES, FIXTURE_COUNTRIES } from './geonames/fixtures';
import { testEnv } from './test-helpers';

/** Flux OAuth Discord complet (faux fournisseur) : le pendant du test Google de auth.integration.test.ts. */
const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('OAuth Discord', () => {
  const pool = new pg.Pool({ connectionString: url });
  let app: Awaited<ReturnType<typeof buildApp>>;
  const calls: string[] = [];

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(u);
    if (u === 'https://discord.com/api/oauth2/token') {
      const body = init?.body as URLSearchParams;
      // Le client OAuth doit envoyer le verifier PKCE et le redirect_uri exact.
      if (
        !body.get('code_verifier') ||
        body.get('redirect_uri') !== 'http://localhost:3000/api/auth/oauth/discord/callback'
      ) {
        return Promise.resolve(new Response('{}', { status: 400 }));
      }
      return Promise.resolve(Response.json({ access_token: 'dtok' }));
    }
    if (u === 'https://discord.com/api/users/@me') {
      return Promise.resolve(
        Response.json({
          id: '777',
          username: 'gabin_dev',
          global_name: 'Gabin ✨',
          avatar: 'abc123',
        }),
      );
    }
    return Promise.reject(new Error(`appel inattendu : ${u}`));
  }) as typeof fetch;

  beforeAll(async () => {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await importGeonames(pool, {
      cities: FIXTURE_CITIES,
      countries: FIXTURE_COUNTRIES,
      admin1: FIXTURE_ADMIN1,
    });
    app = await buildApp(
      testEnv({
        DISCORD_CLIENT_ID: 'did',
        DISCORD_CLIENT_SECRET: 'dsecret',
        GOOGLE_CLIENT_ID: '',
        GOOGLE_CLIENT_SECRET: '',
      }),
      { db: pool, fetchImpl },
    );
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('annonce uniquement les fournisseurs configurés', async () => {
    const me = (await app.inject({ url: '/api/me' })).json<MeResponse>();
    expect(me.providers).toEqual(['discord']);
  });

  it('redirige vers Discord avec le scope identify, puis connecte et crée le compte', async () => {
    const start = await app.inject({
      url: '/api/auth/oauth/discord/start',
      headers: { 'x-forwarded-for': '10.8.0.1' },
    });
    expect(start.statusCode).toBe(302);
    const loc = new URL(start.headers.location as string);
    expect(loc.origin + loc.pathname).toBe('https://discord.com/oauth2/authorize');
    expect(loc.searchParams.get('scope')).toBe('identify');
    expect(loc.searchParams.get('client_id')).toBe('did');
    const tx = start.cookies.find((c) => c.name === 'conquest_oauth')!.value;

    const cb = await app.inject({
      url: `/api/auth/oauth/discord/callback?code=zzz&state=${encodeURIComponent(loc.searchParams.get('state')!)}`,
      headers: { 'x-forwarded-for': '10.8.0.1', 'accept-language': 'de-DE' },
      cookies: { conquest_oauth: tx },
    });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('http://localhost:3000/');
    const sid = cb.cookies.find((c) => c.name === 'conquest_sid')!.value;

    const me = (
      await app.inject({ url: '/api/me', cookies: { conquest_sid: sid } })
    ).json<MeResponse>();
    expect(me.user).toMatchObject({
      kind: 'oauth',
      displayName: 'Gabin', // les emojis sont retirés du pseudo (règle d'affichage)
      avatarUrl: 'https://cdn.discordapp.com/avatars/777/abc123.png',
      countryCode: 'DE',
    });
    expect(me.faction).toMatchObject({ countryCode: 'DE' });
    expect(calls).toEqual([
      'https://discord.com/api/oauth2/token',
      'https://discord.com/api/users/@me',
    ]);
  });

  it('un refus du fournisseur (erreur renvoyée) ne crée aucune session', async () => {
    const start = await app.inject({ url: '/api/auth/oauth/discord/start' });
    const tx = start.cookies.find((c) => c.name === 'conquest_oauth')!.value;
    const cb = await app.inject({
      url: '/api/auth/oauth/discord/callback?error=access_denied',
      cookies: { conquest_oauth: tx },
    });
    expect(cb.headers.location).toContain('auth_error=refused');
    expect(cb.cookies.find((c) => c.name === 'conquest_sid')).toBeUndefined();
  });
});
