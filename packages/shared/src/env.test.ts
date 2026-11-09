import { describe, expect, it } from 'vitest';
import { EnvError, parseServerEnv, parseWebEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/conquest',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('parseServerEnv', () => {
  it('applique les valeurs par défaut', () => {
    const env = parseServerEnv(valid);
    expect(env.SERVER_PORT).toBe(3001);
    expect(env.NODE_ENV).toBe('development');
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
  });

  it('convertit le port et traite les chaînes vides comme absentes', () => {
    const env = parseServerEnv({ ...valid, SERVER_PORT: '4000', DISCORD_CLIENT_ID: '' });
    expect(env.SERVER_PORT).toBe(4000);
    expect(env.DISCORD_CLIENT_ID).toBeUndefined();
  });

  it('rejette un secret trop court', () => {
    expect(() => parseServerEnv({ ...valid, SESSION_SECRET: 'court' })).toThrow(EnvError);
  });

  it('rejette un schéma de base de données invalide', () => {
    expect(() => parseServerEnv({ ...valid, DATABASE_URL: 'mysql://x/y' })).toThrow(EnvError);
  });

  it('liste toutes les variables manquantes', () => {
    try {
      parseServerEnv({});
      expect.unreachable();
    } catch (e) {
      expect((e as EnvError).issues.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('parseWebEnv', () => {
  it('utilise des URLs relatives par défaut', () => {
    expect(parseWebEnv({})).toEqual({ NEXT_PUBLIC_API_URL: '/api', NEXT_PUBLIC_WS_URL: '/ws' });
  });
});
