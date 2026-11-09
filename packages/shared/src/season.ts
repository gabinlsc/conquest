/** Contrats et règles de score des classements et des saisons (phase 5). */

/** Points de classement d'un joueur pour une attaque : l'influence apportée + un bonus de capture. */
export function attackPoints(gain: number, captured: boolean, cityValue: number): number {
  return gain + (captured ? 25 + 10 * cityValue : 0);
}

/** Les villes rapportent à leur faction leur valeur totale PAR HEURE, versée par tranches de 5 minutes. */
export const TERRITORY_TICK_MS = 300_000;
export const TICKS_PER_HOUR = 3_600_000 / TERRITORY_TICK_MS;

export interface SeasonInfo {
  id: number;
  name: string;
  startsAt: string;
  endsAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  /** Identifiant du joueur (uuid) ou de la faction. */
  id: string;
  name: string;
  points: number;
  /** Pays d'origine (joueurs) ; pays de la faction (nations). */
  countryCode: string | null;
  /** Couleur de la faction (classements de factions). */
  color: string | null;
}

export interface LeaderboardResponse {
  season: SeasonInfo;
  entries: LeaderboardEntry[];
  total: number;
}

export interface MyRanks {
  player: { rank: number; points: number } | null;
  faction: { rank: number; points: number; kind: 'country' | 'clan'; name: string } | null;
}

export interface PastSeason {
  id: number;
  name: string;
  startsAt: string;
  endsAt: string;
  winners: { players: LeaderboardEntry[]; factions: LeaderboardEntry[] };
}

export type LeaderboardKind = 'players' | 'nations' | 'clans';
