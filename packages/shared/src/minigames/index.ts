import { memoryGame } from './memory';
import { reflexGame } from './reflex';
import type { MiniGame, MiniGameId, ValidationResult } from './types';

export * from './rng';
export * from './types';
export * from './memory';
export * from './quiz';
export * from './reflex';

/**
 * Jeux dont la logique est PUBLIQUE (utilisable côté client pour animer la partie). Le quiz n'y figure pas :
 * sa clé de réponses doit rester sur le serveur (voir apps/server/src/minigames/registry.ts).
 */
export const SHARED_MINIGAMES: Partial<Record<MiniGameId, MiniGame<unknown, unknown>>> = {
  reflex: reflexGame,
  memory: memoryGame,
};

/** Fenêtre de temps réel acceptée entre le démarrage serveur et la soumission. */
export const TIMING = {
  /** Soumission au plus tôt : durée du jeu moins cette marge (horloge/latence). */
  earlyToleranceMs: 2_000,
  /** Soumission au plus tard : durée du jeu + compte à rebours + latence + marge. */
  lateToleranceMs: 15_000,
  /** Un clic ne peut pas être daté (par le client) plus tard que le temps réellement écoulé côté serveur + cette marge. */
  clockSkewMs: 1_500,
} as const;

/**
 * Évalue une tentative : contrôles de TEMPS RÉEL mesurés par le serveur (indépendants du client),
 * puis rejeu du jeu. Fonction pure -> testable sans base ni horloge.
 *
 * Les horodatages des clics viennent du client (non fiables), mais le serveur connaît le temps réel
 * écoulé depuis la création de la partie. Un bot qui soumettrait instantanément une solution
 * pré-calculée échoue donc aux contrôles « too_fast » / « future_clicks ».
 */
export function evaluateAttempt(
  game: MiniGame<unknown, unknown>,
  seed: string,
  input: unknown,
  elapsedMs: number,
): ValidationResult {
  const result = game.validate(seed, input);
  const timing: string[] = [];
  // Fin anticipée légitime (toutes les questions répondues, erreur fatale…) : pas de durée minimale, mais les
  // actions restent liées au temps RÉEL écoulé (contrôle « future_clicks » ci-dessous).
  const early = game.endsEarly?.(seed, input) === true;
  if (!early && elapsedMs < game.durationMs - TIMING.earlyToleranceMs) timing.push('hard:too_fast');
  if (elapsedMs > game.durationMs + TIMING.lateToleranceMs) timing.push('hard:too_slow');
  if (game.lastInputTime(input) > elapsedMs + TIMING.clockSkewMs) timing.push('hard:future_clicks');
  if (timing.length === 0) return result;
  return { ...result, valid: false, score: 0, flags: [...result.flags, ...timing] };
}
