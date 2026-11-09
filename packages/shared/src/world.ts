import { z } from 'zod';

/** Raretés des villes, dérivées de la population (voir `rarityForPopulation`). */
export const RARITIES = ['common', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];

export function rarityForPopulation(population: number): Rarity {
  if (population >= 5_000_000) return 'legendary';
  if (population >= 1_000_000) return 'epic';
  if (population >= 250_000) return 'rare';
  return 'common';
}

/**
 * Valeur d'une ville (points/ressources par tick pour sa faction), de 1 à 10.
 * Échelle logarithmique : une mégapole vaut ~10x un chef-lieu, pas 1000x,
 * sinon la conquête de quelques capitales dominerait toute la saison.
 */
export function valueForPopulation(population: number): number {
  const MIN = 15_000; // seuil du dataset cities15000
  const MAX = 40_000_000;
  const t = Math.log(Math.max(population, MIN) / MIN) / Math.log(MAX / MIN);
  return Math.min(10, Math.max(1, Math.round(1 + 9 * t)));
}

/** Couleur hex stable pour une clé (code pays, slug de clan…), répartie sur le cercle chromatique. */
export function colorForKey(key: string): string {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  return hslToHex(hue, 70, 55);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

// ---------- Contrats d'API ----------

export interface Faction {
  id: number;
  kind: 'country' | 'clan';
  name: string;
  color: string;
  /** Code ISO2 pour les factions de pays. */
  countryCode: string | null;
}

/**
 * Propriétés statiques d'une ville dans le GeoJSON (la géométrie ne change jamais).
 * Volontairement minimal : ~34 000 features, chaque octet compte. L'identifiant est
 * l'`id` numérique de la Feature (requis pour feature-state) ; le détail (nom natif,
 * pays…) se récupère à la demande via GET /api/cities/:id.
 */
export interface CityFeatureProps {
  /** Nom ASCII : utilisé pour les labels de carte (glyphs latins uniquement). */
  label: string;
  pop: number;
  rarity: Rarity;
  value: number;
}

export interface City {
  id: number;
  name: string;
  asciiName: string;
  countryCode: string;
  countryName: string;
  admin1: string | null;
  population: number;
  rarity: Rarity;
  value: number;
  lon: number;
  lat: number;
  ownerFactionId: number | null;
  /** Faction occupante (nom, couleur) ; null si neutre. */
  ownerFaction: { id: number; name: string; color: string } | null;
  /** Garnison de base de l'occupant (influence minimale à battre pour capturer). */
  garrison: number;
  /** Influence par faction (état chaud) ; vide si indisponible. */
  influence: { factionId: number; name: string; color: string; value: number }[];
  /** Version de l'état (voir CityDelta.ver) ; 0 si inconnue. */
  ver: number;
}

export interface CityListResponse {
  items: City[];
  total: number;
}

export interface Country {
  code: string;
  name: string;
  continent: string;
}

export const citiesQuerySchema = z.object({
  /** west,south,east,north */
  bbox: z
    .string()
    .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/)
    .transform((v) => v.split(',').map(Number) as [number, number, number, number])
    .refine(([w, s, e, n]) => w >= -180 && e <= 180 && s >= -90 && n <= 90 && w <= e && s <= n, {
      message: 'bbox invalide',
    })
    .optional(),
  country: z
    .string()
    .length(2)
    .transform((v) => v.toUpperCase())
    .optional(),
  q: z.string().trim().min(2).max(60).optional(),
  minPop: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type CitiesQuery = z.infer<typeof citiesQuerySchema>;
