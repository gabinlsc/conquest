'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { sfx } from '@/lib/sound';
import { replayClicks, type ReflexInput, type ReflexParams } from '@conquest/shared';

type Click = ReflexInput['clicks'][number];
interface Mark {
  id: number;
  x: number;
  y: number;
  hit: boolean;
  at: number;
}

const COUNTDOWN_S = 3;
const MARK_MS = 350;

interface Props {
  params: ReflexParams;
  /** Appelé une seule fois, avec la preuve brute (liste des clics). */
  onFinish: (input: ReflexInput) => void;
  onAbort: () => void;
}

/**
 * Rendu du mini-jeu « Réflexes ». Le client n'applique AUCUNE règle de score autoritaire :
 * il affiche le planning issu de la graine, enregistre les clics bruts {t, x, y} et les envoie.
 * Le score affiché en direct est une estimation (même code partagé que le serveur) ;
 * seul le résultat renvoyé par le serveur fait foi.
 */
export function ReflexGame({ params, onFinish, onAbort }: Props) {
  const [countdown, setCountdown] = useState(COUNTDOWN_S);
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState(0); // ms depuis le début de la partie
  const [clicks, setClicks] = useState<Click[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const startRef = useRef(0);
  const finishedRef = useRef(false);
  const clicksRef = useRef<Click[]>([]);
  const comboRef = useRef(0);
  const field = useRef<HTMLDivElement>(null);

  // Compte à rebours 3-2-1.
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

  // Boucle d'animation : l'horloge de jeu est performance.now() depuis le 1er rendu « playing ».
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const t = performance.now() - startRef.current;
      if (t >= params.durationMs) {
        setNow(params.durationMs);
        if (!finishedRef.current) {
          finishedRef.current = true;
          onFinish({ clicks: clicksRef.current });
        }
        return;
      }
      setNow(t);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, params.durationMs, onFinish]);

  const replay = useMemo(() => replayClicks(params, clicks), [params, clicks]);
  const hitIds = useMemo(
    () => new Set(replay.outcomes.flatMap((o) => (o.targetId === null ? [] : [o.targetId]))),
    [replay],
  );
  const liveScore = Math.max(
    0,
    replay.outcomes.reduce((sum, o) => sum + o.points, 0),
  );

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!playing || finishedRef.current || !field.current) return;
      e.preventDefault();
      const t = performance.now() - startRef.current;
      const rect = field.current.getBoundingClientRect();
      const click: Click = {
        t: Math.round(t * 10) / 10,
        x: Math.round(((e.clientX - rect.left) / rect.width) * 1e4) / 1e4,
        y: Math.round(((e.clientY - rect.top) / rect.height) * 1e4) / 1e4,
      };
      clicksRef.current = [...clicksRef.current, click];
      setClicks(clicksRef.current);
      const last = replayClicks(params, clicksRef.current).outcomes.at(-1);
      // Son de feedback immédiat : la note monte avec la série de coups au but.
      if (last?.targetId != null) {
        comboRef.current += 1;
        sfx.hit(comboRef.current);
      } else {
        comboRef.current = 0;
        sfx.miss();
      }
      setMarks((m) => [
        ...m.filter((k) => t - k.at < MARK_MS),
        {
          id: clicksRef.current.length,
          x: click.x,
          y: click.y,
          hit: last?.targetId != null,
          at: t,
        },
      ]);
    },
    [playing, params],
  );

  const visible = params.targets.filter(
    (t) => !hitIds.has(t.id) && now >= t.appearAt && now <= t.appearAt + t.lifetime,
  );

  return (
    <div className="flex w-full flex-col items-center gap-3 select-none">
      <div className="flex w-[min(90vw,70vh)] items-center justify-between text-sm">
        <span className="card-sm bg-banana px-3 py-0.5 font-display text-2xl font-bold">
          {liveScore}
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
      <div className="h-4 w-[min(90vw,70vh)] overflow-hidden rounded-full border-3 border-ink bg-white">
        <div
          className="h-full bg-mint"
          style={{ width: `${Math.max(0, 1 - now / params.durationMs) * 100}%` }}
        />
      </div>

      <div
        ref={field}
        onPointerDown={onPointerDown}
        className="relative cursor-crosshair overflow-hidden rounded-xl border-3 border-ink bg-cream shadow-pop-lg"
        style={{
          width: 'min(90vw, 70vh)',
          aspectRatio: '1',
          touchAction: 'none',
          backgroundImage: 'radial-gradient(rgba(17,17,17,0.12) 1.2px, transparent 1.2px)',
          backgroundSize: '22px 22px',
        }}
      >
        {!playing && (
          <div className="absolute inset-0 grid place-items-center font-display text-8xl font-bold text-coral [-webkit-text-stroke:3px_#111]">
            {countdown || 'GO'}
          </div>
        )}
        {visible.map((t) => {
          const life = (now - t.appearAt) / t.lifetime; // 0 -> 1 : sert d'indice visuel du temps restant
          return (
            <div
              key={t.id}
              className="pointer-events-none absolute rounded-full border-3 border-ink bg-coral/30"
              style={{
                left: `${t.x * 100}%`,
                top: `${t.y * 100}%`,
                width: `${t.radius * 200}%`,
                aspectRatio: '1',
                transform: 'translate(-50%, -50%)',
              }}
            >
              <div
                className="absolute inset-0 m-auto rounded-full border-2 border-ink bg-coral"
                style={{ width: `${(1 - life) * 80}%`, height: `${(1 - life) * 80}%` }}
              />
            </div>
          );
        })}
        {marks
          .filter((m) => now - m.at < MARK_MS)
          .map((m) => (
            <div
              key={m.id}
              className={`pointer-events-none absolute h-5 w-5 rounded-full border-2 ${
                m.hit ? 'border-ink bg-mint' : 'border-ink/50 bg-white/60'
              }`}
              style={{
                left: `${m.x * 100}%`,
                top: `${m.y * 100}%`,
                transform: 'translate(-50%, -50%)',
              }}
            />
          ))}
      </div>
      <p className="text-sm font-bold">Touche les cibles avant qu’elles disparaissent !</p>
    </div>
  );
}
