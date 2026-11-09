import { parseServerEnv, type ServerEnv } from '@conquest/shared';

export const testEnv = (extra: Record<string, string> = {}): ServerEnv =>
  parseServerEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://x@localhost/x',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'x'.repeat(40),
    PUBLIC_URL: 'http://localhost:3000',
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    ...extra,
  });
