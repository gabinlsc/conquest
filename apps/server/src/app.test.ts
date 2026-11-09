import { describe, expect, it } from 'vitest';
import type { HealthResponse } from '@conquest/shared';
import { buildApp } from './app';
import { testEnv } from './test-helpers';

const env = testEnv();

describe('GET /api/health', () => {
  it('répond ok quand la base et Redis répondent', async () => {
    const world = { store: { isUp: () => true } } as never;
    const app = await buildApp(env, { db: fakeDb(true), world });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json<HealthResponse>()).toMatchObject({
      status: 'ok',
      services: { db: 'up', redis: 'up' },
    });
    await app.close();
  });

  it('est dégradé (mais répond) sans Redis', async () => {
    const app = await buildApp(env, { db: fakeDb(true) });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json<HealthResponse>()).toMatchObject({
      status: 'degraded',
      services: { db: 'up', redis: 'down' },
    });
    await app.close();
  });

  it('passe en mode dégradé (200) quand la base est tombée', async () => {
    const app = await buildApp(env, { db: fakeDb(false) });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json<HealthResponse>()).toMatchObject({
      status: 'degraded',
      services: { db: 'down', redis: 'down' },
    });
    await app.close();
  });
});

describe('validation des requêtes', () => {
  it('renvoie 400 sur une bbox invalide', async () => {
    const app = await buildApp(env, { db: fakeDb(true) });
    const res = await app.inject({ method: 'GET', url: '/api/cities?bbox=10,0,5,1' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

function fakeDb(up: boolean) {
  return {
    query: () => (up ? Promise.resolve({ rows: [] }) : Promise.reject(new Error('down'))),
    connect: () => Promise.reject(new Error('non utilisé')),
  } as never;
}
