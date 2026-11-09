'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MEMORY, replayTaps, type MemoryInput, type MemoryParams } from '@conquest/shared';
import { sfx } from '@/lib/sound';

const PAD_COLORS = [
  '#FFD84D',
  '#7BE0AD',
  '#FF9478',
  '#8FD3FF',
  '#C3A6FF',
  '#FFC9A8',
  '#FFB3C7',
  '#B5E48C',
  '#E9ECEF',
];
const COUNTDOWN_S = 3;
/** Fraction de chaque pas où la pastille reste éteinte (sépare deux allumages consécutifs). */
const GAP_FRACTION = 0.25;

interface Props {
  params: MemoryParams;
  onFinish: (input: MemoryInput) => void;
  onAbort: () => void;
}

/**
 * Mémoire (Simon 3×3) : la séquence s'allume, tu la reproduis, elle s'allonge. Une erreur termine la partie.
 * Le calendrier (début de manche, fin d'affichage) est calculé par `replayTaps`, le MÊME code que le serveur.
 */
export function MemoryGame({ params, onFinish, onAbort }: Props) {
  const [countdown, setCountdown] = useState(COUNTDOWN_S);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0);
  const [taps, setTaps] = useState<MemoryInput['taps']>([]);
  const [flash, setFlash] = useState<{ pad: number; ok: boolean; until: number } | null>(null);
  const startRef = useRef(0);
  const tapsRef = useRef<MemoryInput['taps']>([]);
  const finishedRef = useRef(false);
  const lastLitRef = useRef(-1);

  const replay = useMemo(() => replayTaps(params, taps), [params, taps]);

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
    onFinish({ taps: tapsRef.current });
  }, [onFinish]);

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

  // Fin de partie sur erreur ou séquence complète : petite pause pour voir le résultat du dernier appui.
  useEffect(() => {
    if (replay.status !== 'wrong' && replay.status !== 'complete') return undefined;
    const t = setTimeout(finish, 900);
    return () => clearTimeout(t);
  }, [replay.status, finish]);

  const over = replay.status === 'wrong' || replay.status === 'complete';
  const { round } = replay;
  const showing = playing && !over && now >= round.startedAt && now < round.showEnd;
  const inputPhase = playing && !over && now >= round.showEnd;

  // Pastille allumée pendant l'affichage.
  let lit = -1;
  if (showing) {
    const step = Math.floor((now - round.startedAt) / params.stepMs);
    const within = ((now - round.startedAt) % params.stepMs) / params.stepMs;
    if (step >= 0 && step < round.length && within < 1 - GAP_FRACTION) lit = params.sequence[step]!;
  }
  useEffect(() => {
    if (lit >= 0 && lit !== lastLitRef.current) sfx.pad(lit);
    lastLitRef.current = lit;
  }, [lit]);

  function press(pad: number) {
    if (!inputPhase || finishedRef.current) return;
    const t = Math.round((performance.now() - startRef.current) * 10) / 10;
    const next = [...tapsRef.current, { pad, t }];
    tapsRef.current = next;
    setTaps(next);
    const ok = replayTaps(params, next).status !== 'wrong';
    if (ok) sfx.pad(pad);
    else sfx.wrong();
    setFlash({ pad, ok, until: t + 260 });
  }

  const flashing = flash && now < flash.until ? flash : null;
  const progress = inputPhase ? replay.partialTaps : 0;

  return (
    <div className="flex w-full max-w-md select-none flex-col items-center gap-3">
      <div className="flex w-full items-center justify-between text-sm">
        <span className="card-sm bg-banana px-3 py-0.5 font-display text-lg font-bold">
          Manche {replay.completedRounds + 1}
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

      <p className="card-sm bg-white px-4 py-1 font-display text-xl font-bold">
        {!playing
          ? 'Prépare-toi…'
          : over
            ? replay.status === 'complete'
              ? '🏆 Séquence complète !'
              : '💥 Raté !'
            : showing || now < round.startedAt
              ? '👀 Regarde…'
              : `✋ À toi ! ${progress} / ${round.length}`}
      </p>

      <div className="relative grid aspect-square w-[min(88vw,26rem)] grid-cols-3 gap-3">
        {!playing && (
          <div className="absolute inset-0 z-10 grid place-items-center font-display text-8xl font-bold text-coral [-webkit-text-stroke:3px_#111]">
            {countdown || 'GO'}
          </div>
        )}
        {Array.from({ length: MEMORY.pads }, (_, i) => {
          const isLit = lit === i;
          const f = flashing?.pad === i ? flashing : null;
          return (
            <button
              key={i}
              aria-label={`Pastille ${i + 1}`}
              onPointerDown={(e) => {
                e.preventDefault();
                press(i);
              }}
              disabled={!inputPhase}
              className={`rounded-2xl border-3 border-ink transition-transform duration-75 ${
                isLit || f ? 'scale-95 shadow-none' : 'shadow-pop-sm'
              } ${inputPhase ? 'cursor-pointer active:scale-95' : 'cursor-default'}`}
              style={{
                background: f ? (f.ok ? '#7BE0AD' : '#FF4D4D') : PAD_COLORS[i],
                opacity: isLit || f || inputPhase ? 1 : 0.45,
                filter: isLit ? 'brightness(1.12) saturate(1.3)' : undefined,
                boxShadow: isLit ? '0 0 0 5px #fff, 0 0 0 8px #111' : undefined,
                touchAction: 'none',
              }}
            />
          );
        })}
      </div>
      <p className="text-sm font-bold">
        {replay.score} pts · la séquence s’allonge d’un pas à chaque manche réussie.
      </p>
    </div>
  );
}
