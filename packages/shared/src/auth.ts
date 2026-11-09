import { z } from 'zod';
import type { Faction } from './world';

// ---------- Schémas de validation (partagés client/serveur) ----------

/** Pseudo public : lettres/chiffres Unicode, espace, _ . - ; 2 à 24 caractères. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[\p{L}\p{N} _.-]+$/u, 'caractères non autorisés');

export const countryCodeSchema = z
  .string()
  .length(2)
  .transform((v) => v.toUpperCase());

export const clanNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(24)
  .regex(/^[\p{L}\p{N} _.-]+$/u, 'caractères non autorisés');

export const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'couleur #rrggbb attendue');

export const guestSchema = z.object({
  countryCode: countryCodeSchema,
  displayName: displayNameSchema.optional(),
});

export const patchMeSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    countryCode: countryCodeSchema.optional(),
  })
  .refine((v) => v.displayName !== undefined || v.countryCode !== undefined, {
    message: 'rien à modifier',
  });

export const createClanSchema = z.object({
  name: clanNameSchema,
  color: hexColorSchema.optional(),
  open: z.boolean().default(true),
});

export const joinClanSchema = z.object({
  inviteCode: z.string().length(8).optional(),
});

export const clansQuerySchema = z.object({
  q: z.string().trim().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ---------- Contrats d'API ----------

export const OAUTH_PROVIDERS = ['google', 'discord'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

export interface UserDto {
  id: string;
  kind: 'guest' | 'oauth';
  displayName: string;
  avatarUrl: string | null;
  countryCode: string | null;
}

/** La faction courante du joueur (un joueur appartient à exactement une faction). */
export interface MyFaction extends Faction {
  role: 'member' | 'owner';
  memberCount: number;
  /** Clans uniquement. */
  open: boolean;
  /** Visible uniquement par le chef du clan. */
  inviteCode: string | null;
}

export interface MeResponse {
  user: UserDto | null;
  faction: MyFaction | null;
  /** Pays deviné (en-tête Accept-Language) pour pré-remplir l'onboarding. */
  countryHint: string | null;
  /** Providers OAuth configurés côté serveur. */
  providers: OAuthProvider[];
}

export interface ClanSummary {
  id: number;
  name: string;
  color: string;
  open: boolean;
  memberCount: number;
  cityCount: number;
}

export interface ClanDetail extends ClanSummary {
  members: { displayName: string; role: 'member' | 'owner' }[];
}

export interface ApiErrorBody {
  error: string;
  code?: string;
}

export const MAX_CLAN_MEMBERS = 200;
export const COUNTRY_CHANGE_COOLDOWN_DAYS = 7;

/**
 * Devine un pays depuis Accept-Language ("fr-FR,fr;q=0.9,en;q=0.8" -> "FR").
 * Seule une balise AVEC région est exploitée : "fr" seul ne dit pas si on est en France, Belgique ou au Canada.
 * Choix assumé plutôt qu'une base GeoIP : zéro dépendance, résiste aux VPN, et le joueur confirme de toute façon.
 */
export function guessCountryFromAcceptLanguage(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim() ?? '';
    const m = /^[a-zA-Z]{2,3}-([a-zA-Z]{2})$/.exec(tag);
    if (m?.[1]) return m[1].toUpperCase();
  }
  return null;
}
