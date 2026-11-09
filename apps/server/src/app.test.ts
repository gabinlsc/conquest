import { describe, expect, it } from 'vitest';
import type { HealthResponse } from '@conquest/shared';
import { buildApp } from './app';

describe('GET /api/health', () => {
  it('répond ok', async () => {
    const app = await buildApp({ NODE_ENV: 'test', LOG_LEVEL: 'silent' });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json<HealthResponse>().status).toBe('ok');
    await app.close();
  });
});
