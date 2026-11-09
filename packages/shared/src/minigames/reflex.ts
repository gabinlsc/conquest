import { z } from 'zod';
import { createRng, randBetween } from './rng';
import type { MiniGame, ValidationResult } from './types';

/**
 * RÉFLEXES — des cibles apparaissent sur un terrain carré normalisé [0,1]².
 * Cliquez-les le plus vite et le plus précisément possible avant qu'elles disparaissent.
 *
 * Le planning des cibles est entièrement déterminé par la graine. Le client envoie uniquement
 * la liste brute de ses clics {t, x, y} ; c'est le SERVEUR qui décide quelles cibles sont touchées
 * et combien de points elles rapportent.
 */

export const REFLEX_DURATION_MS = 30_000;

export interface ReflexTarget {
  id: number;
  /** Instant d'apparition (ms depuis le début de la partie). */
  appearAt: number;
  /** Durée de vie (ms) : la cible disparaît à appearAt + lifetime. */
  lifetime: number;
  /** Centre, en coordonnées normalisées [0,1]. */
  x: number;
  y: number;
  /** Rayon, en fraction de la largeur du terrain. */
  radius: number;
}

export interface ReflexParams {
  durationMs: number;
  targets: ReflexTarget[];
}

export const reflexInputSchema = z.object({
  clicks: z
    .array(
      z.object({
        t: z
          .number()
          .finite()
          .min(0)
          .max(REFLEX_DURATION_MS + 2_000),
        x: z.number().finite().min(-0.5).max(1.5),
        y: z.number().finite().min(-0.5).max(1.5),
      }),
    )
    .max(400),
});
export type ReflexInput = z.infer<typeof reflexInputSchema>;

// ----- Constantes de jeu et d'anti-triche -----
const POINTS_MAX = 100;
const POINTS_MIN_HIT = 20;
const MISS_PENALTY = 10;
/** Sous ce délai, un humain ne peut pas réagir à une cible dont la position est imprévisible. */
const INHUMAN_REACTION_MS = 90;
const FAST_AVG_REACTION_MS = 170;
/** Au-delà, la précision est « trop parfaite » (clics tous au pixel près du centre). */
const SUSPICIOUS_PRECISION = 0.01;
const MIN_HITS_FOR_STATS = 10;
const MAX_CLICKS_PER_TARGET = 3;
const FINGERPRINT_MIN_HITS = 12;
const FINGERPRINT_HITS = 24;
const FINGERPRINT_STEP_MS = 20;

/**
 * Empreinte FNV-1a des 24 premiers temps de réaction arrondis à 20 ms. Deux humains (ou la même personne)
 * ne reproduisent jamais la même séquence ; un script qui rejoue un enregistrement, si.
 */
export function reactionFingerprint(reactions: number[]): string {
  let h = 2166136261;
  for (const r of reactions.slice(0, FINGERPRINT_HITS)) {
    h ^= Math.round(r / FINGERPRINT_STEP_MS) + 1;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function generate(seed: string): ReflexParams {
  const rng = createRng(`reflex:${seed}`);
  const targets: ReflexTarget[] = [];
  let t = 800;
  while (t < REFLEX_DURATION_MS - 600) {
    const progress = t / REFLEX_DURATION_MS; // difficulté croissante
    const lifetime = Math.round(1500 - 600 * progress);
    const radius = 0.08 - 0.03 * progress;
    // Évite de superposer deux cibles simultanément visibles.
    let x = 0.5;
    let y = 0.5;
    for (let attempt = 0; attempt < 12; attempt++) {
      x = randBetween(rng, radius, 1 - radius);
      y = randBetween(rng, radius, 1 - radius);
      const clash = targets.some(
        (o) =>
          o.appearAt + o.lifetime > t && Math.hypot(o.x - x, o.y - y) < o.radius + radius + 0.02,
      );
      if (!clash) break;
    }
    targets.push({
      id: targets.length,
      appearAt: t,
      lifetime,
      x: round3(x),
      y: round3(y),
      radius: round3(radius),
    });
    t += Math.round(randBetween(rng, 450, 950) - 150 * progress);
  }
  return { durationMs: REFLEX_DURATION_MS, targets };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export interface ClickOutcome {
  /** id de la cible touchée, ou null pour un tir manqué. */
  targetId: number | null;
  points: number;
}

/** Score d'un tir réussi : 20 à 100 points : rapidité (jusqu’à 60) + précision (jusqu’à 20). */
export function hitPoints(
  reactionMs: number,
  lifetime: number,
  dist: number,
  radius: number,
): number {
  const speed = 1 - Math.min(1, reactionMs / lifetime);
  const precision = 1 - Math.min(1, dist / radius);
  return Math.round(POINTS_MIN_HIT + 60 * speed + 20 * precision);
}

/**
 * Rejoue les clics contre le planning. Exportée pour le rendu client (feedback instantané) :
 * le client et le serveur appellent exactement le même code.
 */
export function replayClicks(
  params: ReflexParams,
  clicks: ReflexInput['clicks'],
): { outcomes: ClickOutcome[]; reactions: number[]; dists: number[] } {
  const hit = new Set<number>();
  const outcomes: ClickOutcome[] = [];
  const reactions: number[] = [];
  const dists: number[] = [];
  for (const c of clicks) {
    let best: { target: ReflexTarget; dist: number } | null = null;
    for (const target of params.targets) {
      if (hit.has(target.id)) continue;
      if (c.t < target.appearAt || c.t > target.appearAt + target.lifetime) continue;
      const dist = Math.hypot(c.x - target.x, c.y - target.y);
      if (dist > target.radius) continue;
      if (!best || dist < best.dist) best = { target, dist };
    }
    if (best) {
      hit.add(best.target.id);
      const reaction = c.t - best.target.appearAt;
      reactions.push(reaction);
      dists.push(best.dist / best.target.radius);
      outcomes.push({
        targetId: best.target.id,
        points: hitPoints(reaction, best.target.lifetime, best.dist, best.target.radius),
      });
    } else {
      outcomes.push({ targetId: null, points: -MISS_PENALTY });
    }
  }
  return { outcomes, reactions, dists };
}

function validate(seed: string, input: ReflexInput): ValidationResult {
  const params = generate(seed);
  const maxScore = params.targets.length * POINTS_MAX;
  const { clicks } = input;
  const flags: string[] = [];
  const hard = (flag: string) => flags.push(`hard:${flag}`);
  const soft = (flag: string) => flags.push(`soft:${flag}`);

  // Cohérence temporelle : les clics doivent être triés (un client honnête les produit dans l'ordre).
  for (let i = 1; i < clicks.length; i++) {
    if (clicks[i]!.t < clicks[i - 1]!.t) {
      hard('unsorted');
      break;
    }
  }
  if (clicks.length > params.targets.length * MAX_CLICKS_PER_TARGET + 20) hard('too_many_clicks');

  const { outcomes, reactions, dists } = replayClicks(params, clicks);
  const hits = reactions.length;
  const misses = outcomes.length - hits;

  if (reactions.some((r) => r < INHUMAN_REACTION_MS)) hard('inhuman_reaction');

  const avgReaction = hits ? reactions.reduce((a, b) => a + b, 0) / hits : 0;
  const avgDist = hits ? dists.reduce((a, b) => a + b, 0) / hits : 1;
  if (hits >= MIN_HITS_FOR_STATS) {
    if (avgReaction < FAST_AVG_REACTION_MS) soft('fast_average');
    if (avgDist < SUSPICIOUS_PRECISION) soft('perfect_precision');
    // Variance quasi nulle des temps de réaction = métronome (script), pas un humain.
    const variance = reactions.reduce((a, r) => a + (r - avgReaction) ** 2, 0) / hits;
    if (Math.sqrt(variance) < 8) soft('robotic_timing');
  }
  // Cadence de clics impossible pour une main humaine.
  for (let i = 1; i < clicks.length; i++) {
    if (clicks[i]!.t - clicks[i - 1]!.t < 40) {
      soft('click_burst');
      break;
    }
  }

  const valid = !flags.some((f) => f.startsWith('hard:'));
  const raw = outcomes.reduce((sum, o) => sum + o.points, 0);
  const score = valid ? Math.min(maxScore, Math.max(0, raw)) : 0;

  return {
    valid,
    score,
    maxScore,
    flags,
    ...(hits >= FINGERPRINT_MIN_HITS ? { fingerprint: reactionFingerprint(reactions) } : {}),
    stats: {
      hits,
      misses,
      targets: params.targets.length,
      avgReactionMs: Math.round(avgReaction),
    },
  };
}

export const reflexGame: MiniGame<ReflexParams, ReflexInput> = {
  id: 'reflex',
  durationMs: REFLEX_DURATION_MS,
  generate,
  parseInput: (raw) => reflexInputSchema.parse(raw),
  validate,
  lastInputTime: (input) => input.clicks.reduce((m, c) => Math.max(m, c.t), 0),
};
