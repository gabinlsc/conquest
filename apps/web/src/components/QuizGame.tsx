'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { QUIZ, type QuizInput, type QuizParams } from '@conquest/shared';
import { sfx } from '@/lib/sound';

const OPTION_COLORS = ['bg-banana', 'bg-mint', 'bg-sky', 'bg-peach'];
const COUNTDOWN_S = 3;

interface Props {
  params: QuizParams;
  onFinish: (input: QuizInput) => void;
  onAbort: () => void;
}

/**
 * Quiz géo éclair : 10 questions en 30 s. Le client ne connaît PAS la bonne réponse (elle reste sur le serveur) :
 * il enregistre seulement l'option choisie et l'instant du choix ; le serveur corrige et révèle le détail après la partie.
 */
export function QuizGame({ params, onFinish, onAbort }: Props) {
  const [countdown, setCountdown] = useState(COUNTDOWN_S);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const startRef = useRef(0);
  const answersRef = useRef<QuizInput['answers']>([]);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (playing) return;
    if (countdown === 0) {
      startRef.current = performance.now();
      sfx.go();
      setPlaying(true);
      return;
    }
    sfx.tick();
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, playing]);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onFinish({ answers: answersRef.current });
  }, [onFinish]);

  // Chrono global : à 30 s, on envoie ce qui a été répondu.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const t = performance.now() - startRef.current;
      if (t >= params.durationMs) {
        setNow(params.durationMs);
        finish();
        return;
      }
      setNow(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, params.durationMs, finish]);

  function answer(option: number) {
    if (!playing || finishedRef.current || picked !== null) return;
    const t = Math.round((performance.now() - startRef.current) * 10) / 10;
    answersRef.current = [...answersRef.current, { q: index, a: option, t }];
    setPicked(option);
    sfx.click();
    // Enchaîne aussitôt : pas de correction affichée (le client ne la connaît pas).
    setTimeout(() => {
      if (index + 1 >= params.questions.length) finish();
      else {
        setIndex(index + 1);
        setPicked(null);
      }
    }, 140);
  }

  const q = params.questions[index];
  return (
    <div className="flex w-full max-w-xl select-none flex-col items-center gap-3">
      <div className="flex w-full items-center justify-between text-sm">
        <span className="card-sm bg-banana px-3 py-0.5 font-display text-lg font-bold">
          {Math.min(index + 1, params.questions.length)} / {params.questions.length}
        </span>
        <span className="card-sm bg-white px-3 py-0.5 font-display text-lg font-bold">
          {Math.max(0, Math.ceil((params.durationMs - now) / 1000))} s
        </span>
        <button
          onClick={onAbort}
          className="text-sm font-bold underline decoration-coral decoration-4 underline-offset-4"
        >
          Abandonner
        </button>
      </div>
      <div className="h-4 w-full overflow-hidden rounded-full border-3 border-ink bg-white">
        <div
          className="h-full bg-mint"
          style={{ width: `${Math.max(0, 1 - now / params.durationMs) * 100}%` }}
        />
      </div>

      <div className="card relative w-full bg-white p-5">
        {!playing ? (
          <p className="grid h-56 place-items-center font-display text-8xl font-bold text-coral [-webkit-text-stroke:3px_#111]">
            {countdown || 'GO'}
          </p>
        ) : (
          q && (
            <>
              <p className="pill mb-3 bg-lilac">
                {q.kind === 'country' ? '🌍 Où est cette ville ?' : '🏛 Capitale'}
              </p>
              <h3 className="min-h-[4.5rem] text-2xl leading-tight">{q.prompt}</h3>
              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {q.options.map((opt, i) => (
                  <button
                    key={`${index}-${i}`}
                    onClick={() => answer(i)}
                    disabled={picked !== null}
                    className={`btn !justify-start !py-3 text-left text-base ${OPTION_COLORS[i]} ${picked === i ? 'ring-4 ring-ink' : ''}`}
                  >
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 border-ink bg-white text-xs">
                      {'ABCD'[i]}
                    </span>
                    {opt}
                  </button>
                ))}
              </div>
            </>
          )
        )}
      </div>
      <p className="text-sm font-bold">
        Réponds vite : jusqu’à +{QUIZ.speedBonusMax} points de bonus · une erreur coûte{' '}
        {QUIZ.wrongPenalty} points.
      </p>
    </div>
  );
}
