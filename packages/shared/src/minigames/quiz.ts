import { z } from 'zod';

/**
 * QUIZ GÉO ÉCLAIR — types et constantes PARTAGÉS. L'implémentation (jeu de données, clé de réponses,
 * validation) vit côté serveur (apps/server/src/minigames/quiz.ts) : la réponse juste ne doit jamais
 * figurer dans le code envoyé au navigateur.
 */

export const QUIZ = {
  durationMs: 30_000,
  questions: 10,
  options: 4,
  /** Barème : bonne réponse 100 + bonus de rapidité jusqu'à 50 (si répondue en moins de 6 s) ; mauvaise réponse -35. */
  correctPoints: 100,
  speedBonusMax: 50,
  speedWindowMs: 6_000,
  wrongPenalty: 35,
  /** Sous ce délai de lecture + réponse, aucun humain : partie rejetée. */
  minAnswerMs: 350,
} as const;

export interface QuizQuestion {
  /** « country » : dans quel pays est cette ville ? · « capital » : quelle est la capitale de ce pays ? */
  kind: 'country' | 'capital';
  prompt: string;
  options: string[];
}

export interface QuizParams {
  durationMs: number;
  questions: QuizQuestion[];
}

export const quizInputSchema = z.object({
  answers: z
    .array(
      z.object({
        q: z
          .number()
          .int()
          .min(0)
          .max(QUIZ.questions - 1),
        a: z
          .number()
          .int()
          .min(0)
          .max(QUIZ.options - 1),
        t: z
          .number()
          .finite()
          .min(0)
          .max(QUIZ.durationMs + 2_000),
      }),
    )
    .max(QUIZ.questions),
});
export type QuizInput = z.infer<typeof quizInputSchema>;

/** Plafond théorique d'une partie : toutes les questions justes et toutes répondues très vite. */
export const QUIZ_MAX_SCORE = QUIZ.questions * (QUIZ.correctPoints + QUIZ.speedBonusMax);
