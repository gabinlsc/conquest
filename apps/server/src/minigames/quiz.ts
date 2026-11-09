import {
  QUIZ,
  QUIZ_MAX_SCORE,
  createRng,
  quizInputSchema,
  type MiniGame,
  type QuizInput,
  type QuizParams,
  type QuizQuestion,
  type Rng,
  type ValidationResult,
} from '@conquest/shared';
import { CITIES, COUNTRIES } from './quizData';

const COUNTRY = new Map(
  COUNTRIES.map(([code, name, capital, continent]) => [code, { code, name, capital, continent }]),
);
const WITH_CAPITAL = COUNTRIES.filter((c) => c[2] !== null);

/** Mélange de Fisher-Yates avec le PRNG de la graine (déterministe). */
function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** 3 distracteurs plausibles : de préférence du même continent (« Lyon est en… Allemagne ou Brésil ? » serait trop facile). */
function distractors(
  rng: Rng,
  correct: string,
  pool: readonly string[],
  sameContinent: readonly string[],
): string[] {
  const near = shuffle(
    rng,
    sameContinent.filter((x) => x !== correct),
  );
  const far = shuffle(
    rng,
    pool.filter((x) => x !== correct && !near.includes(x)),
  );
  return [...near, ...far].slice(0, QUIZ.options - 1);
}

interface Built {
  question: QuizQuestion;
  /** Index (dans `question.options`) de la bonne réponse : NE QUITTE JAMAIS le serveur. */
  correct: number;
}

function build(seed: string): Built[] {
  const rng = createRng(`quiz:${seed}`);
  // 6 questions « ville -> pays » et 4 « pays -> capitale », dans un ordre mélangé, sur des pays tous différents.
  const kinds = shuffle<'country' | 'capital'>(rng, [
    ...Array<'country'>(6).fill('country'),
    ...Array<'capital'>(4).fill('capital'),
  ]);
  const usedCountries = new Set<string>();
  const allCountryNames = COUNTRIES.map((c) => c[1]);
  const allCapitals = WITH_CAPITAL.map((c) => c[2]!);
  const cities = shuffle(rng, CITIES);
  const capitalCountries = shuffle(rng, WITH_CAPITAL);

  const out: Built[] = [];
  for (const kind of kinds) {
    if (kind === 'country') {
      const entry = cities.find(([, cc]) => !usedCountries.has(cc))!;
      const country = COUNTRY.get(entry[1])!;
      usedCountries.add(country.code);
      const near = COUNTRIES.filter((c) => c[3] === country.continent).map((c) => c[1]);
      const options = shuffle(rng, [
        country.name,
        ...distractors(rng, country.name, allCountryNames, near),
      ]);
      out.push({
        question: { kind, prompt: `Dans quel pays se trouve ${entry[0]} ?`, options },
        correct: options.indexOf(country.name),
      });
    } else {
      const entry = capitalCountries.find((c) => !usedCountries.has(c[0]))!;
      usedCountries.add(entry[0]);
      const capital = entry[2]!;
      const near = WITH_CAPITAL.filter((c) => c[3] === entry[3]).map((c) => c[2]!);
      const options = shuffle(rng, [capital, ...distractors(rng, capital, allCapitals, near)]);
      out.push({
        question: { kind, prompt: `Quelle est la capitale de ce pays : ${entry[1]} ?`, options },
        correct: options.indexOf(capital),
      });
    }
  }
  return out;
}

function generate(seed: string): QuizParams {
  // Les questions et leurs options sont publiques ; la clé de réponses ne l'est pas.
  return { durationMs: QUIZ.durationMs, questions: build(seed).map((b) => b.question) };
}

const speedBonus = (answerMs: number) =>
  Math.round(QUIZ.speedBonusMax * Math.max(0, 1 - answerMs / QUIZ.speedWindowMs));

function validate(seed: string, input: QuizInput): ValidationResult {
  const key = build(seed);
  const flags: string[] = [];
  const answers = input.answers;

  // Les questions s'affichent une à une, dans l'ordre : une réponse hors ordre ou en double est impossible depuis l'interface.
  const outOfOrder = answers.some((a, i) => a.q !== i);
  if (outOfOrder) flags.push('hard:out_of_order');
  for (let i = 1; i < answers.length; i++) {
    if (answers[i]!.t < answers[i - 1]!.t) {
      flags.push('hard:unsorted');
      break;
    }
  }

  let score = 0;
  let correct = 0;
  let mask = 0;
  const times: number[] = [];
  let previous = 0;
  answers.forEach((a, i) => {
    const answerMs = a.t - previous; // temps passé sur CETTE question (lecture + réponse)
    previous = a.t;
    times.push(answerMs);
    if (answerMs < QUIZ.minAnswerMs) flags.push('hard:inhuman_answer');
    if (key[a.q]?.correct === a.a) {
      correct++;
      mask |= 1 << i;
      score += QUIZ.correctPoints + speedBonus(answerMs);
    } else {
      score -= QUIZ.wrongPenalty;
    }
  });

  const mean = times.length ? times.reduce((s, x) => s + x, 0) / times.length : 0;
  if (times.length >= 6) {
    if (correct >= 6 && mean < 1_300) flags.push('soft:fast_average');
    const sd = Math.sqrt(times.reduce((s, x) => s + (x - mean) ** 2, 0) / times.length);
    if (sd < 40) flags.push('soft:robotic_timing'); // des délais quasi identiques : un script
  }
  // Un 10/10 en moins de 15 s est possible pour un spécialiste mais exceptionnel : signalé pour la statistique.
  if (correct === QUIZ.questions && mean < 1_500) flags.push('soft:perfect_run');

  const valid = !flags.some((f) => f.startsWith('hard:'));
  return {
    valid,
    score: valid ? Math.min(QUIZ_MAX_SCORE, Math.max(0, score)) : 0,
    maxScore: QUIZ_MAX_SCORE,
    flags,
    ...(times.length >= 8 ? { fingerprint: timeFingerprint(times) } : {}),
    stats: {
      correct,
      wrong: answers.length - correct,
      unanswered: QUIZ.questions - answers.length,
      avgAnswerMs: Math.round(mean),
      // Bit i = question i juste : affiché APRÈS la partie (revue des réponses).
      mask,
    },
  };
}

/** Empreinte des temps de réponse arrondis à 100 ms (FNV-1a) : détecte un script qui rejoue le même enregistrement. */
export function timeFingerprint(times: number[]): string {
  let h = 2166136261;
  for (const t of times.slice(0, 10)) {
    h ^= Math.round(t / 100) + 1;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const quizGame: MiniGame<QuizParams, QuizInput> = {
  id: 'quiz',
  durationMs: QUIZ.durationMs,
  generate,
  parseInput: (raw) => quizInputSchema.parse(raw),
  validate,
  lastInputTime: (input) => input.answers.reduce((m, a) => Math.max(m, a.t), 0),
  // Toutes les questions répondues : la partie est terminée, inutile d'attendre la fin du chrono.
  endsEarly: (_seed, input) => input.answers.length >= QUIZ.questions,
};

/** Exposé aux tests uniquement : la clé de réponses n'est jamais transmise au client. */
export const __answerKey = (seed: string): number[] => build(seed).map((b) => b.correct);
