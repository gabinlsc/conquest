import { MINIGAME_IDS, SHARED_MINIGAMES, type MiniGame, type MiniGameId } from '@conquest/shared';
import { quizGame } from './quiz';

/**
 * Registre COMPLET des mini-jeux, côté serveur. Le quiz n'existe qu'ici : sa clé de réponses ne doit pas
 * être embarquée dans le code envoyé aux navigateurs.
 */
export const GAMES: Record<MiniGameId, MiniGame<unknown, unknown>> = {
  ...(SHARED_MINIGAMES as Record<'reflex' | 'memory', MiniGame<unknown, unknown>>),
  quiz: quizGame,
};

export const isMiniGameId = (v: string): v is MiniGameId =>
  (MINIGAME_IDS as readonly string[]).includes(v);

/** Épreuve tirée au sort quand le joueur ne choisit pas. */
export const randomGame = (rnd: () => number = Math.random): MiniGameId =>
  MINIGAME_IDS[Math.floor(rnd() * MINIGAME_IDS.length)]!;
