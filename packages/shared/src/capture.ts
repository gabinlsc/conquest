import type { SeasonInfo } from './season';
import type { Faction } from './world';

/**
 * RÈGLES DE CAPTURE — source de vérité lisible et testable.
 * En production, la résolution est exécutée ATOMIQUEMENT dans Redis par un script Lua
 * (apps/server/src/world/scripts.ts) qui doit rester strictement équivalent à `resolveAttack` :
 * un test différentiel (aléatoire) compare les deux implémentations.
 *
 * Modèle : chaque ville a un propriétaire (0 = neutre) et une influence par faction.
 * Une attaque ajoute de l'influence à la faction du joueur. Quand l'influence de l'attaquant
 * dépasse celle de l'occupant, la ville change de main. Attaquer sa propre ville la RENFORCE.
 */

export const NEUTRAL_OWNER = 0;

/** Garnison de base d'une ville : l'influence « gratuite » de l'occupant (60 à 240 selon la valeur 1-10). */
export const GARRISON_BASE = 40;
export const GARRISON_PER_VALUE = 20;
/** L'influence de l'occupant ne peut pas dépasser 3x sa garnison (sinon une ville deviendrait imprenable). */
export const MAX_DEFENSE_FACTOR = 3;
/** Points d'influence perdus par heure par toute faction (la pression retombe ; l'occupant ne descend pas sous sa garnison). */
export const DECAY_PER_HOUR = 10;
/** Après une capture, la ville ne peut plus changer de main pendant ce délai (évite le ping-pong). */
export const SHIELD_MS = 60_000;

export const garrisonFor = (cityValue: number): number =>
  GARRISON_BASE + GARRISON_PER_VALUE * cityValue;

/** Score validé -> points d'influence, de 0 à 100 (un score parfait vaut 100). */
export function influenceGain(score: number, maxScore: number): number {
  if (maxScore <= 0 || score <= 0) return 0;
  return Math.min(100, Math.round((100 * score) / maxScore));
}

export interface CityInfluenceState {
  owner: number;
  /** faction id -> influence (> 0). */
  influence: Record<number, number>;
  lastTouch: number;
  shieldUntil: number;
}

export interface CaptureOutcome {
  state: CityInfluenceState;
  prevOwner: number;
  captured: boolean;
  defended: boolean;
  /** L'attaquant avait la majorité mais la ville était sous bouclier : pas de changement de propriétaire. */
  shielded: boolean;
  /** Influence effective du propriétaire final. */
  ownerInfluence: number;
}

/**
 * Applique une attaque (fonction pure). Toute l'arithmétique est entière (`Math.floor`) pour rester
 * identique, au bit près, à la version Lua.
 */
export function resolveAttack(
  before: CityInfluenceState,
  attacker: number,
  gain: number,
  now: number,
  cityValue: number,
): CaptureOutcome {
  const garrison = garrisonFor(cityValue);

  // 1. Érosion de l'influence depuis la dernière intervention.
  const loss = Math.floor((Math.max(0, now - before.lastTouch) * DECAY_PER_HOUR) / 3_600_000);
  const inf: Record<number, number> = {};
  for (const [f, v] of Object.entries(before.influence)) {
    const nv = v - loss;
    if (nv > 0) inf[Number(f)] = nv;
  }

  let owner = before.owner;
  let shieldUntil = before.shieldUntil;
  const prevOwner = owner;
  // Influence effective de l'occupant : jamais en dessous de la garnison (ville neutre incluse).
  const ownerInf = owner === NEUTRAL_OWNER ? garrison : Math.max(inf[owner] ?? 0, garrison);
  let captured = false;
  let defended = false;
  let shielded = false;

  if (attacker === owner) {
    defended = true;
    inf[owner] = Math.min(ownerInf + gain, garrison * MAX_DEFENSE_FACTOR);
  } else {
    inf[attacker] = (inf[attacker] ?? 0) + gain;
    if (owner !== NEUTRAL_OWNER) inf[owner] = ownerInf;
    if (inf[attacker] > ownerInf) {
      if (now >= shieldUntil) {
        captured = true;
        if (owner !== NEUTRAL_OWNER) inf[owner] = Math.floor(ownerInf / 2); // l'ancien occupant garde de la « résistance »
        for (const key of Object.keys(inf)) {
          const f = Number(key);
          if (f !== attacker && f !== owner) {
            const half = Math.floor((inf[f] ?? 0) / 2);
            if (half > 0) inf[f] = half;
            else delete inf[f];
          }
        }
        owner = attacker;
        shieldUntil = now + SHIELD_MS;
      } else {
        shielded = true;
      }
    }
  }

  return {
    state: { owner, influence: inf, lastTouch: now, shieldUntil },
    prevOwner,
    captured,
    defended,
    shielded,
    ownerInfluence: owner === NEUTRAL_OWNER ? garrison : Math.max(inf[owner] ?? 0, garrison),
  };
}

/** Résultat d'une attaque tel que le joueur le voit. */
export interface AttackEffect {
  cityId: number;
  gain: number;
  captured: boolean;
  defended: boolean;
  shielded: boolean;
  ownerFactionId: number | null;
  prevOwnerFactionId: number | null;
  ownerInfluence: number;
  garrison: number;
  influence: { factionId: number; value: number }[];
}

// ---------- Tuiles géographiques (abonnements temps réel) ----------

/** Grille équirectangulaire 16 x 8 (tuiles de 22,5° x 22,5°) : ≈ 128 tuiles pour le monde entier. */
export const TILE_COLS = 16;
export const TILE_ROWS = 8;
const TILE_DEG = 22.5;
/** Un client ne peut pas s'abonner à plus de tuiles que ça (anti-abus). */
export const MAX_TILES_PER_SOCKET = 48;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

export function tileOf(lon: number, lat: number): string {
  const x = clamp(Math.floor((lon + 180) / TILE_DEG), 0, TILE_COLS - 1);
  const y = clamp(Math.floor((lat + 90) / TILE_DEG), 0, TILE_ROWS - 1);
  return `${x}:${y}`;
}

/** Tuiles couvrant un rectangle (west, south, east, north). Gère l'antiméridien (west > east) et les copies du monde. */
export function tilesForBounds(west: number, south: number, east: number, north: number): string[] {
  const ranges: [number, number][] =
    east - west >= 360
      ? [[-180, 180]]
      : normalizeLon(west) <= normalizeLon(east)
        ? [[normalizeLon(west), normalizeLon(east)]]
        : [
            [normalizeLon(west), 180],
            [-180, normalizeLon(east)],
          ];
  const y0 = clamp(Math.floor((clamp(south, -90, 90) + 90) / TILE_DEG), 0, TILE_ROWS - 1);
  const y1 = clamp(Math.floor((clamp(north, -90, 90) + 90) / TILE_DEG), 0, TILE_ROWS - 1);
  const keys = new Set<string>();
  for (const [a, b] of ranges) {
    const x0 = clamp(Math.floor((a + 180) / TILE_DEG), 0, TILE_COLS - 1);
    const x1 = clamp(Math.floor((b + 180) / TILE_DEG), 0, TILE_COLS - 1);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.add(`${x}:${y}`);
  }
  return [...keys].sort();
}

function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export const isTileKey = (s: string): boolean => /^(\d|1[0-5]):[0-7]$/.test(s);

// ---------- Protocole temps réel ----------

/** Mise à jour d'une ville, diffusée uniquement aux abonnés de sa tuile. */
export interface CityDelta {
  id: number;
  /** Position de la ville (pour l'animation de vague côté client). */
  lon: number;
  lat: number;
  owner: number;
  /** Numéro de version global croissant : le client ignore tout message plus ancien que ce qu'il connaît. */
  ver: number;
  /** Influence par faction [factionId, valeur]. */
  inf: [number, number][];
  /** Description de la faction propriétaire (couleur, nom) si c'est une faction que le client peut ne pas connaître. */
  faction: Faction | null;
  at: number;
}

export interface TileSnapshot {
  tile: string;
  /** [cityId, ownerFactionId (0 = neutre), ver] */
  cities: [number, number, number][];
  /** Factions propriétaires dans cette tuile (pour les couleurs). */
  factions: Faction[];
}

export interface GameEvent {
  id: number;
  type: 'capture';
  at: number;
  cityId: number;
  cityName: string;
  countryCode: string;
  lon: number;
  lat: number;
  /** Pseudo du joueur à l'origine de la capture. */
  by: string | null;
  faction: Faction;
  from: Faction | null;
}

/** Alerte personnelle : une ville de ta faction est attaquée (ou vient de tomber). */
export interface CityAlert {
  id: string;
  at: number;
  cityId: number;
  cityName: string;
  lon: number;
  lat: number;
  captured: boolean;
  /** Faction attaquante. */
  by: Faction;
  gain: number;
}

export interface ServerToClientEvents {
  delta: (d: CityDelta) => void;
  tiles: (s: TileSnapshot) => void;
  /** Événements du flux, regroupés par lots (du plus ancien au plus récent) pour limiter les écritures en rafale. */
  events: (list: GameEvent[]) => void;
  'feed:init': (events: GameEvent[]) => void;
  presence: (p: { online: number }) => void;
  /** Une ville de ta faction est attaquée. */
  alert: (a: CityAlert) => void;
  /** Nouvelle saison : `reset` = true quand la carte a été remise à zéro (le client doit tout recharger). */
  season: (s: { season: SeasonInfo; reset: boolean }) => void;
}

export interface ClientToServerEvents {
  /** Remplace l'ensemble des tuiles suivies ; l'accusé liste les tuiles réellement acceptées. */
  sub: (tiles: string[], ack?: (res: { tiles: string[] }) => void) => void;
  /** À envoyer quand la faction du joueur change (clan rejoint/quitté, pays modifié) : met à jour ses alertes. */
  'faction:refresh': () => void;
}
