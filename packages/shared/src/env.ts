import { z } from 'zod';

/**
 * Variables d'environnement typées et validées au démarrage (fail-fast).
 * Le serveur refuse de démarrer si la config est invalide : mieux vaut un crash
 * explicite qu'un comportement silencieusement dégradé en production.
 */

const url = (protocols: string[]) =>
  z
    .string()
    .url()
    .refine((v) => protocols.some((p) => v.startsWith(`${p}:`)), {
      message: `doit commencer par ${protocols.join(' ou ')}`,
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  SERVER_HOST: z.string().default('0.0.0.0'),
  SERVER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  /** URL publique du site (utilisée pour les callbacks OAuth et le CORS). */
  PUBLIC_URL: url(['http', 'https']).default('http://localhost:3000'),

  DATABASE_URL: url(['postgres', 'postgresql']),
  REDIS_URL: url(['redis', 'rediss']),

  /** Secret de signature des cookies de session et des seeds de mini-jeux. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET doit faire au moins 32 caractères'),

  /** Durée d'une saison, en semaines (à la fin : classement figé, carte remise à zéro). */
  SEASON_WEEKS: z.coerce.number().positive().max(52).default(4),

  /** Bots d'animation : font vivre la carte tant qu'il y a peu de joueurs. */
  BOTS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  BOT_COUNT: z.coerce.number().int().min(1).max(200).default(40),
  /** Délai moyen entre deux actions de bot. */
  BOT_INTERVAL_MS: z.coerce.number().int().min(500).default(6_000),
  /** Au-delà de ce nombre de connectés, les bots se mettent en pause (les vrais joueurs suffisent). */
  BOT_MAX_ONLINE: z.coerce.number().int().min(0).default(20),

  /** Jeton d'accès à /metrics depuis l'extérieur du réseau privé (facultatif). */
  METRICS_TOKEN: z
    .string()
    .min(16)
    .optional()
    .or(z.literal('').transform(() => undefined)),

  // OAuth (Phase 2) : optionnels, le provider est désactivé s'il n'est pas configuré.
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  DISCORD_CLIENT_ID: optionalString,
  DISCORD_CLIENT_SECRET: optionalString,
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export const webEnvSchema = z.object({
  /** Relatif par défaut : le reverse proxy route /api vers le serveur (même origine). */
  NEXT_PUBLIC_API_URL: z.string().default('/api'),
  NEXT_PUBLIC_WS_URL: z.string().default('/ws'),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

export class EnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Configuration invalide :\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvError';
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, source: Record<string, string | undefined>) {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvError(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  return result.data;
}

export const parseServerEnv = (source: Record<string, string | undefined>): ServerEnv =>
  parse(serverEnvSchema, source);

export const parseWebEnv = (source: Record<string, string | undefined>): WebEnv =>
  parse(webEnvSchema, source);
