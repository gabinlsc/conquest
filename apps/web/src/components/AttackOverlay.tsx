'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttackResult, AttackStartResponse, City, ReflexParams } from '@conquest/shared';
import { ApiError, startAttack, submitAttack } from '@/lib/api';
import { ReflexGame } from './ReflexGame';

type Phase =
  | { kind: 'starting' }
  | { kind: 'playing'; attack: AttackStartResponse }
  | { kind: 'submitting' }
  | { kind: 'result'; result: AttackResult }
  | { kind: 'error'; message: string };

const RATING_COLOR: Record<AttackResult['rating'], string> = {
  S: 'text-amber-300',
  A: 'text-emerald-400',
  B: 'text-sky-400',
  C: 'text-slate-300',
  D: 'text-slate-500',
};

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
      (result) => setPhase({ kind: 'result', result }),
      (err: unknown) =>
        setPhase({
          kind: 'error',
          message: err instanceof ApiError ? err.message : 'Connexion perdue : résultat non reçu.',
        }),
    );
  }, []);

  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-slate-950/90 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-xl flex-col items-center gap-4">
        <h2 className="text-lg font-bold tracking-wide">
          Attaque sur <span className="text-sky-300">{city.name}</span>
        </h2>

        {phase.kind === 'starting' && <p className="text-slate-400">Préparation…</p>}

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
          <div className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-6 text-center">
            {phase.result.validated ? (
              <>
                <p className={`text-7xl font-black ${RATING_COLOR[phase.result.rating]}`}>
                  {phase.result.rating}
                </p>
                <p className="mt-2 text-3xl font-bold">
                  {phase.result.score}
                  <span className="text-base font-normal text-slate-500">
                    {' '}
                    / {phase.result.maxScore}
                  </span>
                </p>
                <p className="mt-3 text-sm text-slate-400">
                  {phase.result.stats['hits']} cibles touchées · {phase.result.stats['misses']}{' '}
                  ratés · réaction moyenne {phase.result.stats['avgReactionMs']} ms
                </p>
                <p className="mt-3 text-xs text-slate-500">
                  Le score sera converti en influence sur la ville dès l’ouverture de la conquête.
                </p>
              </>
            ) : (
              <>
                <p className="text-4xl">⚠️</p>
                <p className="mt-2 font-semibold">Partie non validée</p>
                <p className="mt-1 text-sm text-slate-400">
                  Le serveur n’a pas pu valider cette partie. Réessaie sans interruption.
                </p>
              </>
            )}
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => setRound((r) => r + 1)}
                className="flex-1 rounded-lg bg-sky-600 py-2 font-semibold hover:bg-sky-500"
              >
                Rejouer
              </button>
              <button
                onClick={onClose}
                className="flex-1 rounded-lg border border-slate-700 py-2 hover:bg-slate-800"
              >
                Fermer
              </button>
            </div>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="w-full max-w-sm rounded-2xl border border-red-900 bg-slate-900 p-6 text-center">
            <p className="text-red-300">{phase.message}</p>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setRound((r) => r + 1)}
                className="flex-1 rounded-lg bg-sky-600 py-2 font-semibold hover:bg-sky-500"
              >
                Réessayer
              </button>
              <button
                onClick={onClose}
                className="flex-1 rounded-lg border border-slate-700 py-2 hover:bg-slate-800"
              >
                Fermer
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
