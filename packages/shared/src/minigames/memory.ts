import { z } from 'zod';
import { createRng } from './rng';
import type { MiniGame, ValidationResult } from './types';

/**
 * MÉMOIRE — jeu de Simon sur une grille de 3 x 3 pastilles.
 * La séquence s'allume pastille après pastille ; le joueur la reproduit. À chaque manche réussie, la séquence
 * s'allonge d'un pas (3, 4, 5…). Une erreur met fin à la partie (les manches réussies sont conservées).
 *
 * La séquence est déterminée par la graine ; le client envoie uniquement ses appuis bruts {pad, t}. Le serveur
 * rejoue la partie, calcule lui-même quelle manche est en cours et à quel instant l'affichage s'est terminé
 * (le calendrier dépend des instants d'appui : une manche démarre 800 ms après le dernier appui de la précédente).
 */

export const MEMORY = {
  durationMs: 30_000,
  pads: 9,
  /** Délai avant la première séquence. */
  startDelayMs: 600,
  /** Durée d'allumage d'une pastille. */
  stepMs: 520,
  /** Pause entre la fin d'une manche et le début de l'affichage suivant. */
  nextRoundDelayMs: 800,
  firstLength: 3,
  maxLength: 12,
  /** Sous ces durées, aucun humain ne peut réagir / enchaîner : partie rejetée. */
  minReactionMs: 100,
  minTapGapMs: 90,
  /** Marge de synchronisation entre l'horloge du client et le calendrier recalculé par le serveur. */
  syncToleranceMs: 60,
} as const;

export interface MemoryParams {
  durationMs: number;
  pads: number;
  stepMs: number;
  startDelayMs: number;
  nextRoundDelayMs: number;
  firstLength: number;
  /** Séquence complète (maxLength pas) ; la manche n affiche les (firstLength + n) premiers. */
  sequence: number[];
}

export const memoryInputSchema = z.object({
  taps: z
    .array(
      z.object({
        pad: z
          .number()
          .int()
          .min(0)
          .max(MEMORY.pads - 1),
        t: z
          .number()
          .finite()
          .min(0)
          .max(MEMORY.durationMs + 2_000),
      }),
    )
    .max(120),
});
export type MemoryInput = z.infer<typeof memoryInputSchema>;

function generate(seed: string): MemoryParams {
  const rng = createRng(`memory:${seed}`);
  const sequence: number[] = [];
  while (sequence.length < MEMORY.maxLength) {
    const next = Math.floor(rng() * MEMORY.pads);
    // Jamais deux fois la même pastille d'affilée : sinon l'allumage est ambigu à l'œil.
    if (next !== sequence.at(-1)) sequence.push(next);
  }
  return {
    durationMs: MEMORY.durationMs,
    pads: MEMORY.pads,
    stepMs: MEMORY.stepMs,
    startDelayMs: MEMORY.startDelayMs,
    nextRoundDelayMs: MEMORY.nextRoundDelayMs,
    firstLength: MEMORY.firstLength,
    sequence,
  };
}

/** Points d'une manche terminée : 60 + 15 par pas, plus jusqu'à 40 de bonus de rapidité. */
export function roundPoints(length: number, tapDurationMs: number): number {
  const speed = Math.min(1, Math.max(0, 1 - tapDurationMs / (length * 700)));
  return 60 + 15 * length + Math.round(40 * speed);
}
const PARTIAL_TAP_POINTS = 5;

/** Plafond théorique : combien de manches un joueur parfait (réaction 150 ms, un appui toutes les 150 ms) boucle en 30 s. */
function idealMaxScore(): number {
  let t: number = MEMORY.startDelayMs;
  let total = 0;
  for (let r = 0; r < MEMORY.maxLength - MEMORY.firstLength + 1; r++) {
    const length = MEMORY.firstLength + r;
    const showEnd = t + length * MEMORY.stepMs;
    const tapDuration = 150 + (length - 1) * 150;
    if (showEnd + tapDuration > MEMORY.durationMs) break;
    total += roundPoints(length, tapDuration);
    t = showEnd + tapDuration + MEMORY.nextRoundDelayMs;
  }
  return total;
}
const MAX_SCORE = idealMaxScore();

export interface MemoryRound {
  length: number;
  /** Instant où l'affichage de la séquence se termine (le joueur peut alors appuyer). */
  showEnd: number;
  /** Instant où la manche a été démarrée. */
  startedAt: number;
}

export type MemoryStatus = 'timeout' | 'wrong' | 'complete';

export interface MemoryReplay {
  completedRounds: number;
  partialTaps: number;
  status: MemoryStatus;
  /** Calendrier de la manche en cours (ou de la dernière) : le client s'en sert pour l'affichage. */
  round: MemoryRound;
  score: number;
  gaps: number[];
  flags: string[];
  usedTaps: number;
}

/** Début de la manche `index` (0 = première) connaissant la fin de la précédente. */
export function roundAt(
  index: number,
  startedAt: number,
  stepMs: number,
  firstLength: number,
): MemoryRound {
  const length = firstLength + index;
  return { length, startedAt, showEnd: startedAt + length * stepMs };
}

/**
 * Rejoue les appuis contre la séquence. Exportée pour le client (retour visuel instantané) : le client et le
 * serveur exécutent exactement le même code.
 */
export function replayTaps(params: MemoryParams, taps: MemoryInput['taps']): MemoryReplay {
  const flags: string[] = [];
  const gaps: number[] = [];
  let roundIndex = 0;
  let round = roundAt(0, params.startDelayMs, params.stepMs, params.firstLength);
  let position = 0;
  let completed = 0;
  let partial = 0;
  let score = 0;
  let status: MemoryStatus = 'timeout';
  let used = 0;
  let previousT: number | null = null;

  for (const tap of taps) {
    if (tap.t > params.durationMs) break; // temps écoulé : appuis ignorés
    used++;
    if (previousT !== null) {
      const gap = tap.t - previousT;
      // Seuls les intervalles à l'intérieur d'une manche sont significatifs pour la détection de métronome
      // (entre deux manches, l'intervalle contient l'affichage de la séquence suivante).
      if (position > 0) gaps.push(gap);
      if (gap < MEMORY.minTapGapMs) flags.push('hard:inhuman_tap');
    }
    if (tap.t < round.showEnd - MEMORY.syncToleranceMs) flags.push('hard:early_tap');
    if (position === 0 && tap.t - round.showEnd < MEMORY.minReactionMs - MEMORY.syncToleranceMs) {
      flags.push('hard:inhuman_tap');
    }
    previousT = tap.t;

    if (tap.pad !== params.sequence[position]) {
      status = 'wrong';
      break;
    }
    position++;
    if (position === round.length) {
      score += roundPoints(round.length, tap.t - round.showEnd);
      completed++;
      partial = 0;
      position = 0;
      roundIndex++;
      if (round.length + 1 > params.sequence.length) {
        status = 'complete';
        break;
      }
      round = roundAt(
        roundIndex,
        tap.t + params.nextRoundDelayMs,
        params.stepMs,
        params.firstLength,
      );
    } else {
      partial++;
    }
  }
  if (status !== 'wrong' && status !== 'complete') status = 'timeout';
  score += partial * PARTIAL_TAP_POINTS;
  return {
    completedRounds: completed,
    partialTaps: partial,
    status,
    round,
    score,
    gaps,
    flags,
    usedTaps: used,
  };
}

function validate(seed: string, input: MemoryInput): ValidationResult {
  const params = generate(seed);
  const replay = replayTaps(params, input.taps);
  const flags = [...new Set(replay.flags)];

  const ignored = input.taps.length - replay.usedTaps;
  // Des appuis après l'erreur / la fin sont ignorés ; un client honnête n'en envoie pas.
  if (ignored > 0 && replay.status !== 'timeout') flags.push('soft:tap_after_end');
  for (let i = 1; i < input.taps.length; i++) {
    if (input.taps[i]!.t < input.taps[i - 1]!.t) {
      flags.push('hard:unsorted');
      break;
    }
  }
  const { gaps } = replay;
  if (gaps.filter((g) => g < 130).length >= 3) flags.push('soft:tap_burst');
  if (gaps.length >= 12) {
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
    if (sd < 12) flags.push('soft:robotic_timing'); // métronome : un script, pas une main
  }

  const valid = !flags.some((f) => f.startsWith('hard:'));
  return {
    valid,
    score: valid ? Math.min(MAX_SCORE, replay.score) : 0,
    maxScore: MAX_SCORE,
    flags,
    ...(gaps.length >= 8 ? { fingerprint: gapFingerprint(gaps) } : {}),
    stats: {
      rounds: replay.completedRounds,
      taps: replay.usedTaps,
      longest: replay.completedRounds > 0 ? params.firstLength + replay.completedRounds - 1 : 0,
      failed: replay.status === 'wrong' ? 1 : 0,
    },
  };
}

/** Empreinte des 24 premiers intervalles entre appuis, arrondis à 50 ms (FNV-1a). */
export function gapFingerprint(gaps: number[]): string {
  let h = 2166136261;
  for (const g of gaps.slice(0, 24)) {
    h ^= Math.round(g / 50) + 1;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const memoryGame: MiniGame<MemoryParams, MemoryInput> = {
  id: 'memory',
  durationMs: MEMORY.durationMs,
  generate,
  parseInput: (raw) => memoryInputSchema.parse(raw),
  validate,
  lastInputTime: (input) => input.taps.reduce((m, t) => Math.max(m, t.t), 0),
  endsEarly: (seed, input) => {
    const status = replayTaps(generate(seed), input.taps).status;
    return status === 'wrong' || status === 'complete';
  },
};
