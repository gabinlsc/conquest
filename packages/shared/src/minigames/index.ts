import { reflexGame } from './reflex';
import type { MiniGame, MiniGameId, ValidationResult } from './types';

export * from './rng';
export * from './types';
export * from './reflex';

// Registre : le serveur et le client résolvent un jeu par son identifiant.
// Le registre n'a pas besoin de connaître les types précis (Params/Input) de chaque jeu.
export const MINIGAMES: Record<MiniGameId, MiniGame<unknown, unknown>> = {
  reflex: reflexGame,
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
  if (elapsedMs < game.durationMs - TIMING.earlyToleranceMs) timing.push('hard:too_fast');
  if (elapsedMs > game.durationMs + TIMING.lateToleranceMs) timing.push('hard:too_slow');
  const lastClick = lastClickTime(input);
  if (lastClick > elapsedMs + TIMING.clockSkewMs) timing.push('hard:future_clicks');
  if (timing.length === 0) return result;
  return { ...result, valid: false, score: 0, flags: [...result.flags, ...timing] };
}

function lastClickTime(input: unknown): number {
  const clicks = (input as { clicks?: { t: number }[] }).clicks;
  return clicks?.length ? Math.max(...clicks.map((c) => c.t)) : 0;
}
