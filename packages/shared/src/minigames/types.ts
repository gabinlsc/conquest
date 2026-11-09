/** Identifiants des mini-jeux. Ajouter un jeu = ajouter un id ici + l'enregistrer dans le registre du serveur. */
export const MINIGAME_IDS = ['reflex', 'quiz', 'memory'] as const;
export type MiniGameId = (typeof MINIGAME_IDS)[number];

export interface ValidationResult {
  /** false = partie rejetée (triche avérée ou entrée impossible) : le score est alors 0. */
  valid: boolean;
  score: number;
  /** Plafond théorique pour cette graine : sert au rating et à la détection d'outliers. */
  maxScore: number;
  /** Statistiques affichables au joueur (coups au but, temps de réaction moyen…). */
  stats: Record<string, number>;
  /**
   * Drapeaux d'analyse, conservés côté serveur pour la détection d'anomalies (phase 5).
   * Jamais renvoyés au client : ils aideraient un tricheur à régler son bot.
   */
  flags: string[];
  /**
   * Empreinte du « style de jeu » (temps de réaction quantifiés). Deux parties DIFFÉRENTES (graines
   * différentes) qui produisent la même empreinte trahissent un enregistrement rejoué par un script.
   */
  fingerprint?: string;
}

/**
 * Contrat commun des mini-jeux.
 * Les deux méthodes sont PURES et déterministes : `generate` côté client pour afficher la partie,
 * `validate` côté serveur pour rejouer la preuve fournie par le client et calculer le score.
 * Le client n'envoie jamais de score : seulement ses actions brutes (`Input`).
 */
export interface MiniGame<Params, Input> {
  readonly id: MiniGameId;
  /** Durée nominale de la partie, en ms. */
  readonly durationMs: number;
  /** Paramètres PUBLICS de la partie (envoyés au client pour le rendu). */
  generate(seed: string): Params;
  /** Valide la forme de l'entrée (lève une ZodError) : appelée avant toute écriture en base. */
  parseInput(raw: unknown): Input;
  /** Rejoue l'entrée contre la graine et calcule le score. Ne lève jamais sur une entrée déjà parsée. */
  validate(seed: string, input: Input): ValidationResult;
  /** Instant (ms) de la dernière action du joueur : un client ne peut pas dater une action dans le futur. */
  lastInputTime(input: Input): number;
  /**
   * Vrai si la partie s'est terminée AVANT la durée nominale de façon légitime (toutes les questions répondues,
   * erreur fatale à la mémoire…). Sans cela, une soumission anticipée serait rejetée comme « trop rapide ».
   */
  endsEarly?(seed: string, input: Input): boolean;
}

export type Rating = 'S' | 'A' | 'B' | 'C' | 'D';

export function ratingFor(score: number, maxScore: number): Rating {
  const ratio = maxScore > 0 ? score / maxScore : 0;
  if (ratio >= 0.8) return 'S';
  if (ratio >= 0.6) return 'A';
  if (ratio >= 0.4) return 'B';
  if (ratio >= 0.2) return 'C';
  return 'D';
}

import type { AttackEffect } from '../capture';

// ---------- Contrats d'API des attaques ----------

export interface AttackStartResponse<Params = unknown> {
  attackId: string;
  minigame: MiniGameId;
  /** Graine dérivée par HMAC côté serveur : le client ne peut ni la choisir ni la prédire. */
  seed: string;
  durationMs: number;
  params: Params;
  city: { id: number; name: string };
}

export interface AttackResult {
  /** Effet sur le monde ; null/absent si la partie est invalide ou si l'effet est en attente (mode dégradé). */
  effect?: AttackEffect | null;
  attackId: string;
  minigame: MiniGameId;
  validated: boolean;
  score: number;
  maxScore: number;
  rating: Rating;
  stats: Record<string, number>;
}
