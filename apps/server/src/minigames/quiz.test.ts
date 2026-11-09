import { describe, expect, it } from 'vitest';
import { QUIZ, QUIZ_MAX_SCORE, evaluateAttempt, type QuizInput } from '@conquest/shared';
import { __answerKey, quizGame } from './quiz';
import { CITIES, COUNTRIES } from './quizData';
import { GAMES } from './registry';

describe('jeu de données', () => {
  it('est cohérent : codes uniques, villes rattachées à un pays connu, noms sans doublon', () => {
    const codes = COUNTRIES.map((c) => c[0]);
    expect(new Set(codes).size).toBe(codes.length);
    const known = new Set(codes);
    for (const [city, cc] of CITIES) expect(known.has(cc), `${city} -> ${cc}`).toBe(true);
    const cityNames = CITIES.map((c) => c[0]);
    expect(new Set(cityNames).size).toBe(cityNames.length);
    const names = COUNTRIES.map((c) => c[1]);
    expect(new Set(names).size).toBe(names.length);
    // Une ville ne doit jamais porter le nom d'une capitale du jeu (sinon deux réponses justes possibles).
    const capitals = new Set(COUNTRIES.flatMap((c) => (c[2] ? [c[2]] : [])));
    for (const [city] of CITIES) expect(capitals.has(city), city).toBe(false);
  });

  it('offre assez de matière pour des milliers de parties différentes', () => {
    expect(CITIES.length).toBeGreaterThanOrEqual(150);
    expect(COUNTRIES.filter((c) => c[2]).length).toBeGreaterThanOrEqual(100);
  });
});

describe('quiz.generate', () => {
  it('est déterministe et ne révèle jamais la réponse dans les paramètres publics', () => {
    const a = quizGame.generate('s1');
    expect(quizGame.generate('s1')).toEqual(a);
    expect(quizGame.generate('s2')).not.toEqual(a);
    const serialized = JSON.stringify(a);
    expect(serialized).not.toContain('correct');
    expect(Object.keys(a.questions[0]!).sort()).toEqual(['kind', 'options', 'prompt']);
  });

  it('produit toujours 10 questions valides (6 villes + 4 capitales, pays distincts, 4 options distinctes dont la bonne)', () => {
    for (let i = 0; i < 400; i++) {
      const seed = `seed-${i}`;
      const { questions } = quizGame.generate(seed);
      const key = __answerKey(seed);
      expect(questions).toHaveLength(QUIZ.questions);
      expect(questions.filter((q) => q.kind === 'country')).toHaveLength(6);
      expect(questions.filter((q) => q.kind === 'capital')).toHaveLength(4);
      questions.forEach((q, n) => {
        expect(q.options).toHaveLength(QUIZ.options);
        expect(new Set(q.options).size).toBe(QUIZ.options);
        expect(key[n]).toBeGreaterThanOrEqual(0);
        expect(key[n]).toBeLessThan(QUIZ.options);
      });
    }
  });

  it('place la bonne réponse à des positions variées (pas toujours la première)', () => {
    const positions = new Set<number>();
    for (let i = 0; i < 40; i++) __answerKey(`pos-${i}`).forEach((p) => positions.add(p));
    expect(positions.size).toBe(QUIZ.options);
  });

  it('la clé correspond bien à la question posée (exemples)', () => {
    const { questions } = quizGame.generate('exemple');
    const key = __answerKey('exemple');
    for (const [i, q] of questions.entries()) {
      const answer = q.options[key[i]!]!;
      if (q.kind === 'capital') {
        const name = q.prompt.replace(/^.*: /, '').replace(/ \?$/, '');
        const country = COUNTRIES.find((c) => c[1] === name)!;
        expect(country[2]).toBe(answer);
      } else {
        const name = q.prompt.replace('Dans quel pays se trouve ', '').replace(/ \?$/, '');
        const city = CITIES.find(([n]) => n === name)!;
        expect(COUNTRIES.find((c) => c[0] === city[1])![1]).toBe(answer);
      }
    }
  });
});

describe('quiz.validate', () => {
  const seed = 'val-1';
  const key = __answerKey(seed);
  /** `n` bonnes réponses d'affilée puis le reste faux ; temps de réponse variables et plausibles. */
  const play = (
    correctCount: number,
    base = 2_200,
    answered: number = QUIZ.questions,
  ): QuizInput => {
    let t = 0;
    return {
      answers: Array.from({ length: answered }, (_, q) => {
        t += base + ((q * 311) % 700);
        return { q, a: q < correctCount ? key[q]! : (key[q]! + 1) % QUIZ.options, t };
      }),
    };
  };
  const run = (input: QuizInput) => quizGame.validate(seed, input);

  it('score une partie : bonnes réponses + bonus de rapidité − pénalité des fausses', () => {
    const r = run(play(10));
    expect(r.valid).toBe(true);
    expect(r.stats).toMatchObject({ correct: 10, wrong: 0 });
    expect(r.score).toBeGreaterThan(QUIZ.questions * QUIZ.correctPoints);
    expect(r.score).toBeLessThanOrEqual(QUIZ_MAX_SCORE);

    const half = run(play(5));
    expect(half.stats).toMatchObject({ correct: 5, wrong: 5 });
    expect(half.score).toBeLessThan(r.score / 2); // les 5 fausses coûtent des points
  });

  it('plus rapide = plus de points ; au-delà de 6 s plus de bonus', () => {
    expect(run(play(10, 1_500)).score).toBeGreaterThan(run(play(10, 4_000)).score);
    const slow = run({
      answers: Array.from({ length: 3 }, (_, q) => ({ q, a: key[q]!, t: 7_000 * (q + 1) })),
    });
    expect(slow.score).toBe(3 * QUIZ.correctPoints);
  });

  it('les questions sans réponse ne rapportent rien et ne coûtent rien', () => {
    const r = run(play(4, 2_000, 4));
    expect(r.stats).toMatchObject({ correct: 4, wrong: 0, unanswered: 6 });
    expect(r.score).toBeGreaterThan(0);
  });

  it('le masque de revue indique quelles questions étaient justes', () => {
    const r = run(play(3));
    expect(r.stats['mask']).toBe(0b111);
  });

  it('un score ne peut jamais devenir négatif', () => {
    expect(run(play(0)).score).toBe(0);
  });

  it('rejette des réponses inhumainement rapides (< 350 ms de lecture + réponse)', () => {
    const r = run(play(10, 100));
    expect(r.valid).toBe(false);
    expect(r.score).toBe(0);
    expect(r.flags).toContain('hard:inhuman_answer');
  });

  it('rejette des réponses hors ordre, en double ou non triées', () => {
    const base = play(10);
    const swapped = { answers: [base.answers[1]!, base.answers[0]!, ...base.answers.slice(2)] };
    expect(run(swapped).flags).toContain('hard:out_of_order');
    const dup = { answers: [base.answers[0]!, base.answers[0]!, ...base.answers.slice(2)] };
    expect(run(dup).valid).toBe(false);
  });

  it('signale un script : délais quasi identiques et sans variation', () => {
    const steady: QuizInput = {
      answers: Array.from({ length: 10 }, (_, q) => ({ q, a: key[q]!, t: 1_000 * (q + 1) })),
    };
    const r = run(steady);
    expect(r.valid).toBe(true);
    expect(r.flags).toEqual(expect.arrayContaining(['soft:robotic_timing']));
  });

  it('signale un 10/10 exceptionnellement rapide, sans l’invalider', () => {
    const r = run(play(10, 800));
    expect(r.valid).toBe(true);
    expect(r.flags).toContain('soft:perfect_run');
  });

  it('produit une empreinte à partir de 8 réponses, identique pour des temps identiques', () => {
    const a = run(play(10)).fingerprint;
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(run(play(10)).fingerprint).toBe(a);
    expect(run(play(10, 3_500)).fingerprint).not.toBe(a);
    expect(run(play(10, 2_000, 5)).fingerprint).toBeUndefined();
  });

  it('parseInput refuse les formes invalides', () => {
    expect(() => quizGame.parseInput({ answers: [{ q: 12, a: 0, t: 100 }] })).toThrow();
    expect(() => quizGame.parseInput({ answers: [{ q: 0, a: 4, t: 100 }] })).toThrow();
    expect(() => quizGame.parseInput({ score: 1500 })).toThrow();
    expect(() => quizGame.parseInput({ answers: Array(11).fill({ q: 0, a: 0, t: 1 }) })).toThrow();
  });

  it('le client ne peut pas imposer un score : seules ses réponses comptent', () => {
    const r = run({ answers: [], ...({ score: 99999 } as object) });
    expect(r.score).toBe(0);
  });
});

describe('quiz + contrôles de temps réel', () => {
  const seed = 'rt-1';
  const key = __answerKey(seed);
  const game = GAMES.quiz;
  const full: QuizInput = {
    answers: Array.from({ length: 10 }, (_, q) => ({
      q,
      a: key[q]!,
      t: 1_900 * (q + 1) + ((q * 211) % 600),
    })),
  };
  const last = full.answers.at(-1)!.t;

  it('accepte une partie terminée avant le chrono (toutes les questions répondues)', () => {
    expect(game.endsEarly?.(seed, full)).toBe(true);
    expect(evaluateAttempt(game, seed, full, last + 800).valid).toBe(true);
  });

  it('refuse une soumission anticipée quand il restait des questions', () => {
    const partial = { answers: full.answers.slice(0, 6) };
    const r = evaluateAttempt(game, seed, partial, partial.answers.at(-1)!.t + 500);
    expect(r.flags).toContain('hard:too_fast');
  });

  it('refuse une soumission instantanée de réponses pré-calculées', () => {
    const r = evaluateAttempt(game, seed, full, 600);
    expect(r).toMatchObject({ valid: false, score: 0 });
    expect(r.flags).toContain('hard:future_clicks');
  });
});
