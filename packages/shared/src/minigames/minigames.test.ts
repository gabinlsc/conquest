import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import { MINIGAMES, TIMING, evaluateAttempt } from './index';
import { REFLEX_DURATION_MS, reflexGame, type ReflexInput } from './reflex';
import { ratingFor } from './types';

describe('createRng', () => {
  it('est déterministe pour une même graine et diffère entre graines', () => {
    const a = createRng('abc');
    const b = createRng('abc');
    const seqA = Array.from({ length: 5 }, a);
    expect(Array.from({ length: 5 }, b)).toEqual(seqA);
    expect(Array.from({ length: 5 }, createRng('abd'))).not.toEqual(seqA);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  // Valeurs de référence figées : si elles changent, client et serveur déjà déployés divergeraient.
  it('garde une séquence stable (non-régression)', () => {
    const r = createRng('conquest');
    expect(Array.from({ length: 3 }, r).map((v) => Number(v.toFixed(6)))).toMatchInlineSnapshot(`
      [
        0.12046,
        0.456486,
        0.279794,
      ]
    `);
  });
});

describe('reflex.generate', () => {
  const params = reflexGame.generate('seed-1');

  it('est déterministe', () => {
    expect(reflexGame.generate('seed-1')).toEqual(params);
    expect(reflexGame.generate('seed-2')).not.toEqual(params);
  });

  it('produit un planning cohérent', () => {
    expect(params.targets.length).toBeGreaterThanOrEqual(30);
    expect(params.targets.length).toBeLessThanOrEqual(60);
    let prev = -1;
    for (const t of params.targets) {
      expect(t.appearAt).toBeGreaterThan(prev);
      expect(t.appearAt + t.lifetime).toBeLessThan(REFLEX_DURATION_MS + 1500);
      expect(t.x - t.radius).toBeGreaterThanOrEqual(0);
      expect(t.x + t.radius).toBeLessThanOrEqual(1);
      expect(t.y - t.radius).toBeGreaterThanOrEqual(0);
      expect(t.y + t.radius).toBeLessThanOrEqual(1);
      prev = t.appearAt;
    }
  });
});

/** Joueur « humain » simulé : réagit en ~300 ms avec une légère imprécision et un peu de variance. */
function humanClicks(seed: string, reactionBase = 300, skipEvery = 0): ReflexInput['clicks'] {
  const { targets } = reflexGame.generate(seed);
  return targets
    .filter((_, i) => !skipEvery || i % skipEvery !== 0)
    .map((t, i) => ({
      t: t.appearAt + reactionBase + ((i * 37) % 120),
      x: t.x + t.radius * 0.3 * (((i * 13) % 7) / 7 - 0.5),
      y: t.y + t.radius * 0.3 * (((i * 11) % 7) / 7 - 0.5),
    }));
}

describe('reflex.validate', () => {
  const seed = 'seed-validate';
  const run = (clicks: ReflexInput['clicks']) => reflexGame.validate(seed, { clicks });

  it('un bon joueur marque beaucoup sans atteindre le plafond', () => {
    const r = run(humanClicks(seed));
    expect(r.valid).toBe(true);
    expect(r.score).toBeGreaterThan(r.maxScore * 0.5);
    expect(r.score).toBeLessThan(r.maxScore);
    expect(r.stats['hits']).toBe(r.stats['targets']);
    expect(r.stats['misses']).toBe(0);
  });

  it('plus rapide = plus de points', () => {
    expect(run(humanClicks(seed, 200)).score).toBeGreaterThan(run(humanClicks(seed, 700)).score);
  });

  it('aucun clic = score nul mais partie valide', () => {
    expect(run([])).toMatchObject({ valid: true, score: 0 });
  });

  it('les cibles ignorées ne rapportent rien', () => {
    expect(run(humanClicks(seed, 300, 2)).score).toBeLessThan(run(humanClicks(seed)).score * 0.6);
  });

  it('un clic dans le vide est pénalisé', () => {
    const base = humanClicks(seed);
    const withMiss = [...base, { t: 29_900, x: 0.001, y: 0.001 }].sort((a, b) => a.t - b.t);
    const r = run(withMiss);
    expect(r.stats['misses']).toBe(1);
    expect(r.score).toBe(run(base).score - 10);
  });

  it('une cible ne peut être touchée qu’une fois (le second clic est un tir manqué)', () => {
    const base = humanClicks(seed);
    const first = base[0]!;
    const doubled = [first, { ...first, t: first.t + 60 }, ...base.slice(1)];
    const r = run(doubled);
    expect(r.stats['misses']).toBe(1);
    expect(r.stats['hits']).toBe(run(base).stats['hits']);
  });

  it('un clic avant l’apparition de la cible ne la touche pas', () => {
    const t0 = reflexGame.generate(seed).targets[0]!;
    const r = run([{ t: t0.appearAt - 50, x: t0.x, y: t0.y }]);
    expect(r.stats['hits']).toBe(0);
  });

  it('un clic hors du rayon ne touche pas', () => {
    const t0 = reflexGame.generate(seed).targets[0]!;
    const r = run([{ t: t0.appearAt + 300, x: t0.x + t0.radius * 1.2, y: t0.y }]);
    expect(r.stats['hits']).toBe(0);
  });

  it('rejette les réactions inhumaines (< 90 ms) : partie invalide, score 0', () => {
    const r = run(humanClicks(seed, 40));
    expect(r.valid).toBe(false);
    expect(r.score).toBe(0);
    expect(r.flags).toContain('hard:inhuman_reaction');
  });

  it('rejette des clics non triés', () => {
    const clicks = humanClicks(seed);
    [clicks[0], clicks[1]] = [clicks[1]!, clicks[0]!];
    expect(run(clicks).flags).toContain('hard:unsorted');
  });

  it('rejette le spam de clics', () => {
    const spam = Array.from({ length: 300 }, (_, i) => ({ t: i * 90, x: 0.5, y: 0.5 }));
    expect(run(spam).flags).toContain('hard:too_many_clicks');
  });

  it('signale (sans invalider) un métronome parfait et une précision au pixel', () => {
    const perfect = reflexGame
      .generate(seed)
      .targets.map((t) => ({ t: t.appearAt + 250, x: t.x, y: t.y }));
    const r = run(perfect);
    expect(r.valid).toBe(true);
    expect(r.flags).toEqual(
      expect.arrayContaining(['soft:robotic_timing', 'soft:perfect_precision']),
    );
  });

  it('le score ne dépasse jamais le plafond théorique', () => {
    const r = run(humanClicks(seed, 100));
    expect(r.score).toBeLessThanOrEqual(r.maxScore);
  });

  it('parseInput refuse les formes invalides', () => {
    expect(() => reflexGame.parseInput({ clicks: [{ t: -5, x: 0, y: 0 }] })).toThrow();
    expect(() => reflexGame.parseInput({ clicks: [{ t: 10, x: NaN, y: 0 }] })).toThrow();
    expect(() => reflexGame.parseInput({ score: 99999 })).toThrow();
    expect(() =>
      reflexGame.parseInput({ clicks: Array(401).fill({ t: 1, x: 0, y: 0 }) }),
    ).toThrow();
  });
});

describe('evaluateAttempt (contrôles de temps réel)', () => {
  const seed = 'seed-timing';
  const game = MINIGAMES.reflex;
  const input = { clicks: humanClicks(seed) };
  const last = Math.max(...input.clicks.map((c) => c.t));

  it('accepte une partie jouée en temps réel', () => {
    expect(evaluateAttempt(game, seed, input, 33_000).valid).toBe(true);
  });

  it('rejette une soumission instantanée (solution pré-calculée)', () => {
    const r = evaluateAttempt(game, seed, input, 800);
    expect(r).toMatchObject({ valid: false, score: 0 });
    expect(r.flags).toEqual(expect.arrayContaining(['hard:too_fast', 'hard:future_clicks']));
  });

  it('rejette une soumission trop tardive', () => {
    expect(evaluateAttempt(game, seed, input, 30_000 + TIMING.lateToleranceMs + 1).flags).toContain(
      'hard:too_slow',
    );
  });

  it('rejette des clics datés dans le futur par rapport au temps réel écoulé', () => {
    const r = evaluateAttempt(game, seed, input, last - TIMING.clockSkewMs - 100 + 0);
    expect(r.flags).toContain('hard:future_clicks');
  });
});

describe('ratingFor', () => {
  it.each([
    [90, 100, 'S'],
    [65, 100, 'A'],
    [45, 100, 'B'],
    [25, 100, 'C'],
    [5, 100, 'D'],
    [0, 0, 'D'],
  ])('%i/%i -> %s', (s, m, r) => expect(ratingFor(s, m)).toBe(r));
});

describe('empreinte de parties (anti-rejeu)', () => {
  it('est stable pour un même jeu et différente entre deux joueurs', () => {
    const seedA = 'fp-a';
    const play = (reaction: number) => {
      const { targets } = reflexGame.generate(seedA);
      return reflexGame.validate(seedA, {
        clicks: targets.map((t, i) => ({
          t: t.appearAt + reaction + ((i * 37) % 120),
          x: t.x,
          y: t.y,
        })),
      });
    };
    expect(play(300).fingerprint).toBe(play(300).fingerprint);
    expect(play(300).fingerprint).not.toBe(play(450).fingerprint);
    expect(play(300).fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it('n’est pas calculée sur trop peu de cibles touchées', () => {
    expect(reflexGame.validate('fp-b', { clicks: [] }).fingerprint).toBeUndefined();
  });
});
