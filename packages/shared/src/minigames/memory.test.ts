import { describe, expect, it } from 'vitest';
import { MEMORY, memoryGame, replayTaps, roundPoints, type MemoryInput } from './memory';
import { evaluateAttempt } from './index';

const seed = 'mem-1';
const params = memoryGame.generate(seed);

/**
 * Joueur simulé : reproduit `rounds` manches avec `reaction` ms après la fin de l'affichage puis un appui toutes
 * les `gap` ms ; si `failAt` est défini, se trompe à ce numéro d'appui (0 = premier appui de la partie).
 */
function play(
  rounds: number,
  opts: { reaction?: number; gap?: number; jitter?: boolean; failAt?: number } = {},
): MemoryInput['taps'] {
  const { reaction = 400, gap = 280, jitter = true } = opts;
  const taps: MemoryInput['taps'] = [];
  let startedAt: number = MEMORY.startDelayMs;
  let n = 0;
  for (let r = 0; r < rounds; r++) {
    const length = MEMORY.firstLength + r;
    const showEnd = startedAt + length * MEMORY.stepMs;
    let t = showEnd + reaction + (jitter ? (r * 37) % 60 : 0);
    for (let i = 0; i < length; i++) {
      const wrong = opts.failAt === n;
      taps.push({ pad: wrong ? (params.sequence[i]! + 1) % MEMORY.pads : params.sequence[i]!, t });
      n++;
      if (wrong) return taps;
      if (i < length - 1) t += gap + (jitter ? (i * 53 + r * 17) % 90 : 0);
    }
    startedAt = t + MEMORY.nextRoundDelayMs;
  }
  return taps;
}

describe('memory.generate', () => {
  it('est déterministe, de longueur maxLength, sans pastille répétée d’affilée', () => {
    expect(memoryGame.generate(seed)).toEqual(params);
    expect(memoryGame.generate('autre')).not.toEqual(params);
    expect(params.sequence).toHaveLength(MEMORY.maxLength);
    for (let i = 1; i < params.sequence.length; i++)
      expect(params.sequence[i]).not.toBe(params.sequence[i - 1]);
    expect(params.sequence.every((p) => p >= 0 && p < MEMORY.pads)).toBe(true);
  });
});

describe('memory.validate', () => {
  const run = (taps: MemoryInput['taps']) => memoryGame.validate(seed, { taps });

  it('crédite les manches réussies, plus de points quand la séquence s’allonge', () => {
    const two = run(play(2));
    const four = run(play(4));
    expect(two.valid).toBe(true);
    expect(two.stats['rounds']).toBe(2);
    expect(four.stats['rounds']).toBe(4);
    expect(four.score).toBeGreaterThan(two.score);
    expect(four.stats['longest']).toBe(6);
    expect(four.score).toBeLessThanOrEqual(four.maxScore);
  });

  it('une erreur met fin à la partie en gardant les manches réussies et les appuis justes de la manche en cours', () => {
    // 2 manches (3 + 4 = 7 appuis), puis erreur au 3e appui de la 3e manche (appui n°9).
    const r = run(play(3, { failAt: 9 }));
    expect(r.valid).toBe(true);
    expect(r.stats).toMatchObject({ rounds: 2, failed: 1 });
    const base = run(play(2)).score;
    expect(r.score).toBe(base + 2 * 5); // 2 appuis justes dans la manche ratée
  });

  it('aucun appui = score nul, partie valide', () => {
    expect(run([])).toMatchObject({ valid: true, score: 0 });
  });

  it('plus rapide = plus de points sur une même manche', () => {
    expect(roundPoints(5, 800)).toBeGreaterThan(roundPoints(5, 2400));
    expect(roundPoints(5, 99999)).toBe(60 + 15 * 5); // bonus nul, jamais négatif
  });

  it('rejette un appui pendant l’affichage de la séquence', () => {
    const taps = play(1);
    taps[0] = { ...taps[0]!, t: MEMORY.startDelayMs + 400 };
    expect(run(taps).flags).toContain('hard:early_tap');
  });

  it('rejette des appuis inhumainement rapprochés', () => {
    const r = run(play(2, { gap: 40, jitter: false }));
    expect(r.valid).toBe(false);
    expect(r.flags).toContain('hard:inhuman_tap');
    expect(r.score).toBe(0);
  });

  it('rejette des appuis non triés', () => {
    const taps = play(2);
    [taps[2], taps[3]] = [taps[3]!, taps[2]!];
    expect(run(taps).flags).toContain('hard:unsorted');
  });

  it('signale (sans invalider) un métronome parfait', () => {
    const r = run(play(5, { gap: 220, jitter: false, reaction: 300 }));
    expect(r.valid).toBe(true);
    expect(r.flags).toContain('soft:robotic_timing');
  });

  it('ignore les appuis après la fin du temps imparti', () => {
    const taps = play(2);
    taps.push({ pad: 1, t: MEMORY.durationMs + 100 });
    expect(replayTaps(params, taps).usedTaps).toBe(taps.length - 1);
  });

  it('la manche suivante démarre 800 ms après le dernier appui (calendrier recalculé par le serveur)', () => {
    const taps = play(1);
    const last = taps.at(-1)!.t;
    const replay = replayTaps(params, taps);
    expect(replay.round.startedAt).toBe(last + MEMORY.nextRoundDelayMs);
    expect(replay.round.length).toBe(MEMORY.firstLength + 1);
  });

  it('produit une empreinte à partir de 8 intervalles', () => {
    expect(run(play(3)).fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(run(play(1)).fingerprint).toBeUndefined();
  });

  it('parseInput refuse les formes invalides', () => {
    expect(() => memoryGame.parseInput({ taps: [{ pad: 9, t: 100 }] })).toThrow();
    expect(() => memoryGame.parseInput({ taps: [{ pad: 1, t: -5 }] })).toThrow();
    expect(() => memoryGame.parseInput({ score: 999 })).toThrow();
  });
});

describe('memory + contrôles de temps réel', () => {
  it('accepte une fin anticipée légitime (erreur) sans durée minimale', () => {
    const taps = play(2, { failAt: 4 });
    const last = taps.at(-1)!.t;
    const r = evaluateAttempt(memoryGame, seed, { taps }, last + 500);
    expect(r.valid).toBe(true);
    expect(memoryGame.endsEarly?.(seed, { taps })).toBe(true);
  });

  it('refuse une fin anticipée si la partie n’était pas réellement terminée', () => {
    const taps = play(2); // aucune erreur : la partie aurait dû continuer jusqu'à 30 s
    const r = evaluateAttempt(memoryGame, seed, { taps }, taps.at(-1)!.t + 500);
    expect(r.flags).toContain('hard:too_fast');
  });

  it('refuse des appuis datés dans le futur, même pour une partie terminée par erreur', () => {
    const taps = play(2, { failAt: 4 });
    const r = evaluateAttempt(memoryGame, seed, { taps }, 800);
    expect(r.flags).toContain('hard:future_clicks');
  });
});
