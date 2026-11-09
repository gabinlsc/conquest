import { describe, expect, it } from 'vitest';
import {
  MAX_SUSPICION_PER_ATTACK,
  stdDev,
  weightOf,
  welfordUpdate,
  zScore,
  type RunningStats,
} from './stats';

describe('statistiques en ligne (Welford)', () => {
  it('retrouve moyenne et écart-type du calcul direct', () => {
    const xs = [0.4, 0.55, 0.62, 0.7, 0.5, 0.45, 0.8, 0.58];
    let s: RunningStats = { n: 0, mean: 0, m2: 0 };
    for (const x of xs) s = welfordUpdate(s, x);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1));
    expect(s.mean).toBeCloseTo(mean, 10);
    expect(stdDev(s)).toBeCloseTo(sd, 10);
  });

  it('zScore détecte un score très au-dessus de la population, avec un plancher sur l’écart-type', () => {
    const homogeneous: RunningStats = { n: 1000, mean: 0.55, m2: 0 }; // écart-type nul
    expect(zScore(homogeneous, 0.56)).toBeLessThan(1); // pas d'explosion
    expect(zScore(homogeneous, 0.95)).toBeGreaterThan(7);
  });
});

describe('weightOf', () => {
  it('additionne les poids, ignore les drapeaux inconnus et plafonne par partie', () => {
    expect(weightOf(['soft:click_burst', 'soft:inconnu']).total).toBe(3);
    expect(weightOf(['hard:inhuman_reaction']).total).toBe(30);
    expect(
      weightOf(['soft:replayed_pattern', 'soft:robotic_timing', 'soft:perfect_precision']).total,
    ).toBe(MAX_SUSPICION_PER_ATTACK);
    expect(weightOf([]).total).toBe(0);
  });
  it('liste les raisons retenues', () => {
    expect(weightOf(['soft:fast_average', 'soft:x']).reasons).toEqual(['soft:fast_average']);
  });
});
