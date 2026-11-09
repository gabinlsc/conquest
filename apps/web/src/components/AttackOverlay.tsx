'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttackResult, AttackStartResponse, City, ReflexParams } from '@conquest/shared';
import { ApiError, startAttack, submitAttack } from '@/lib/api';
import { sfx } from '@/lib/sound';
import { Confetti } from './Confetti';
import { Spark, Star } from './Decor';
import { ReflexGame } from './ReflexGame';

type Phase =
  | { kind: 'starting' }
  | { kind: 'playing'; attack: AttackStartResponse }
  | { kind: 'submitting' }
  | { kind: 'result'; result: AttackResult }
  | { kind: 'error'; message: string };

const RATING_COLOR: Record<AttackResult['rating'], string> = {
  S: 'bg-banana',
  A: 'bg-mint',
  B: 'bg-sky',
  C: 'bg-peach',
  D: 'bg-white',
};

function EffectLine({ result, cityName }: { result: AttackResult; cityName: string }) {
  const fx = result.effect;
  if (!fx) {
    return (
      <p className="card-sm mt-4 bg-banana px-3 py-2 text-sm font-bold">
        Score enregistré : l’effet sur la carte sera appliqué dès que le monde sera de nouveau
        disponible.
      </p>
    );
  }
  if (fx.captured) {
    return (
      <p className="card-sm mt-4 bg-mint px-3 py-2 font-display text-lg font-bold">
        🏴 {cityName} capturée ! <span className="text-sm">(+{fx.gain} d’influence)</span>
      </p>
    );
  }
  if (fx.defended) {
    return (
      <p className="card-sm mt-4 bg-sky px-3 py-2 text-sm font-bold">
        🛡 Défense renforcée : +{fx.gain} (occupant : {fx.ownerInfluence})
      </p>
    );
  }
  return (
    <p className="card-sm mt-4 bg-white px-3 py-2 text-sm font-bold">
      +{fx.gain} d’influence
      {fx.shielded ? ' — ville sous bouclier, capture impossible pour le moment' : ''}
      <span className="block text-xs font-medium text-ink/60">
        Occupant à dépasser : {fx.ownerInfluence}
      </span>
    </p>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Envoi de la preuve avec reprises : l'endpoint est idempotent, réessayer ne peut pas créer de doublon. */
async function submitWithRetry(attackId: string, input: unknown): Promise<AttackResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await submitAttack(attackId, input);
    } catch (err) {
      // Une erreur 4xx est définitive (partie abandonnée, forme invalide…) : inutile de réessayer.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) throw err;
      lastError = err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

export function AttackOverlay({ city, onClose }: { city: City; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const attackIdRef = useRef<string | null>(null);
  const [round, setRound] = useState(0);

  // Une seule requête de démarrage par « manche », même si React rejoue l'effet (mode strict) :
  // une seconde requête serait refusée par le cooldown serveur et fabriquerait une partie fantôme.
  const requestRef = useRef<{ round: number; promise: Promise<AttackStartResponse> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'starting' });
    if (requestRef.current?.round !== round) {
      requestRef.current = { round, promise: startAttack(city.id) };
    }
    requestRef.current.promise.then(
      (attack) => {
        if (cancelled) return;
        attackIdRef.current = attack.attackId;
        setPhase({ kind: 'playing', attack });
      },
      (err: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: 'error',
          message: err instanceof ApiError ? err.message : 'Impossible de lancer la partie.',
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [city.id, round]);

  const finish = useCallback((input: unknown) => {
    const id = attackIdRef.current;
    if (!id) return;
    setPhase({ kind: 'submitting' });
    submitWithRetry(id, input).then(
      (result) => {
        if (!result.validated) sfx.defeat();
        else if (result.effect?.captured) sfx.capture();
        else sfx.win();
        setPhase({ kind: 'result', result });
      },
      (err: unknown) =>
        setPhase({
          kind: 'error',
          message: err instanceof ApiError ? err.message : 'Connexion perdue : résultat non reçu.',
        }),
    );
  }, []);

  return (
    <div
      className="absolute inset-0 z-30 grid place-items-center overflow-y-auto bg-cream p-4"
      style={{
        backgroundImage: 'radial-gradient(rgba(17,17,17,0.09) 1.2px, transparent 1.2px)',
        backgroundSize: '22px 22px',
      }}
    >
      <div className="flex w-full max-w-xl flex-col items-center gap-4">
        <h2 className="text-3xl uppercase">
          Attaque sur <span className="hl">{city.name}</span>
        </h2>

        {phase.kind === 'starting' && (
          <p className="font-display text-xl font-bold">Préparation…</p>
        )}

        {phase.kind === 'playing' && (
          <ReflexGame
            // key : une nouvelle partie remonte un composant neuf (état et horloge remis à zéro).
            key={phase.attack.attackId}
            params={phase.attack.params as ReflexParams}
            onFinish={finish}
            onAbort={onClose}
          />
        )}

        {phase.kind === 'submitting' && (
          <p className="text-slate-400">Validation par le serveur…</p>
        )}

        {phase.kind === 'result' && (
          <div className="relative w-full max-w-sm">
            {phase.result.effect?.captured && <Confetti />}
            <Star className="absolute -right-5 -top-7 h-14 w-14 rotate-12" />
            <Spark className="absolute -left-6 top-16 h-10 w-10" />
            <div className="card bg-white p-6 text-center">
              {phase.result.validated ? (
                <>
                  <p
                    className={`mx-auto grid h-24 w-24 -rotate-3 animate-pop place-items-center rounded-2xl border-3 border-ink font-display text-7xl font-bold shadow-pop ${RATING_COLOR[phase.result.rating]}`}
                  >
                    {phase.result.rating}
                  </p>
                  <p className="mt-3 font-display text-4xl font-bold">
                    {phase.result.score}
                    <span className="text-lg font-medium text-ink/50">
                      {' '}
                      / {phase.result.maxScore}
                    </span>
                  </p>
                  <p className="mt-2 text-sm font-medium text-ink/70">
                    {phase.result.stats['hits']} cibles touchées · {phase.result.stats['misses']}{' '}
                    ratés · réaction moyenne {phase.result.stats['avgReactionMs']} ms
                  </p>
                  <EffectLine result={phase.result} cityName={city.name} />
                </>
              ) : (
                <>
                  <p className="text-5xl">⚠️</p>
                  <p className="mt-2 font-display text-2xl font-bold">Partie non validée</p>
                  <p className="mt-1 text-sm font-medium text-ink/70">
                    Le serveur n’a pas pu valider cette partie. Réessaie sans interruption.
                  </p>
                </>
              )}
              <div className="mt-5 flex gap-2">
                <button onClick={() => setRound((r) => r + 1)} className="btn btn-banana flex-1">
                  Rejouer
                </button>
                <button onClick={onClose} className="btn flex-1">
                  Fermer
                </button>
              </div>
            </div>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="card w-full max-w-sm bg-white p-6 text-center">
            <p className="font-display text-xl font-bold">{phase.message}</p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setRound((r) => r + 1)} className="btn btn-banana flex-1">
                Réessayer
              </button>
              <button onClick={onClose} className="btn flex-1">
                Fermer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
