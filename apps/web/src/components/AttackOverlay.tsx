'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AttackResult,
  AttackStartResponse,
  City,
  MemoryParams,
  MiniGameId,
  QuizParams,
  ReflexParams,
} from '@conquest/shared';
import { QUIZ } from '@conquest/shared';
import { ApiError, startAttack, submitAttack } from '@/lib/api';
import { sfx } from '@/lib/sound';
import { Confetti } from './Confetti';
import { Spark, Star } from './Decor';
import { MemoryGame } from './MemoryGame';
import { QuizGame } from './QuizGame';
import { ReflexGame } from './ReflexGame';

type Choice = MiniGameId | 'random';

type Phase =
  | { kind: 'choose' }
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

const GAME_INFO: Record<MiniGameId, { emoji: string; title: string; text: string; color: string }> =
  {
    reflex: {
      emoji: '⚡',
      title: 'Réflexes',
      text: 'Touche les cibles avant qu’elles disparaissent.',
      color: 'bg-coral',
    },
    quiz: {
      emoji: '🌍',
      title: 'Quiz géo',
      text: '10 questions éclair : pays, villes, capitales.',
      color: 'bg-sky',
    },
    memory: {
      emoji: '🧠',
      title: 'Mémoire',
      text: 'Reproduis la séquence, elle s’allonge à chaque manche.',
      color: 'bg-mint',
    },
  };
const GAME_ORDER: MiniGameId[] = ['reflex', 'quiz', 'memory'];

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

/** Détail de la partie, propre à chaque épreuve (les statistiques viennent du serveur). */
function GameStats({ result }: { result: AttackResult }) {
  const s = result.stats;
  if (result.minigame === 'quiz') {
    const answered = QUIZ.questions - (s['unanswered'] ?? 0);
    const mask = s['mask'] ?? 0;
    return (
      <>
        <p className="mt-2 text-sm font-medium text-ink/70">
          {s['correct']} bonnes réponses sur {QUIZ.questions} · réponse moyenne{' '}
          {((s['avgAnswerMs'] ?? 0) / 1000).toFixed(1)} s
        </p>
        {/* Revue : une pastille par question (vert = juste, rouge = fausse, gris = sans réponse). */}
        <div className="mt-2 flex justify-center gap-1" aria-label="Revue des réponses">
          {Array.from({ length: QUIZ.questions }, (_, i) => (
            <span
              key={i}
              className={`h-4 w-4 rounded-full border-2 border-ink ${
                i >= answered ? 'bg-white' : mask & (1 << i) ? 'bg-mint' : 'bg-coral'
              }`}
            />
          ))}
        </div>
      </>
    );
  }
  if (result.minigame === 'memory') {
    return (
      <p className="mt-2 text-sm font-medium text-ink/70">
        {s['rounds']} manche{(s['rounds'] ?? 0) > 1 ? 's' : ''} réussie
        {(s['rounds'] ?? 0) > 1 ? 's' : ''} · séquence max {s['longest']} pastilles
        {s['failed'] ? ' · une erreur a mis fin à la partie' : ''}
      </p>
    );
  }
  return (
    <p className="mt-2 text-sm font-medium text-ink/70">
      {s['hits']} cibles touchées · {s['misses']} ratés · réaction moyenne {s['avgReactionMs']} ms
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
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });
  const attackIdRef = useRef<string | null>(null);
  // Une « manche » = une partie : chaque choix d'épreuve incrémente le compteur et déclenche UN démarrage.
  const [launch, setLaunch] = useState<{ n: number; choice: Choice } | null>(null);

  // Une seule requête de démarrage par lancement, même si React rejoue l'effet (mode strict) :
  // une seconde requête serait refusée par le cooldown serveur et fabriquerait une partie fantôme.
  const requestRef = useRef<{ n: number; promise: Promise<AttackStartResponse> } | null>(null);

  useEffect(() => {
    if (!launch) return;
    let cancelled = false;
    setPhase({ kind: 'starting' });
    if (requestRef.current?.n !== launch.n) {
      requestRef.current = {
        n: launch.n,
        promise: startAttack(city.id, launch.choice === 'random' ? undefined : launch.choice),
      };
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
  }, [city.id, launch]);

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

  const choose = (choice: Choice) => setLaunch((l) => ({ n: (l?.n ?? 0) + 1, choice }));

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

        {phase.kind === 'choose' && (
          <div className="w-full space-y-3">
            <p className="text-center text-sm font-bold">
              Choisis ton épreuve : le score se transforme en influence.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {GAME_ORDER.map((g, i) => (
                <button
                  key={g}
                  onClick={() => choose(g)}
                  className={`card flex flex-col items-center gap-1 p-4 text-center transition hover:-translate-y-1 ${GAME_INFO[g].color} ${
                    i === 0 ? '-rotate-1' : i === 1 ? 'rotate-1' : '-rotate-1'
                  }`}
                >
                  <span className="text-4xl">{GAME_INFO[g].emoji}</span>
                  <span className="font-display text-xl font-bold">{GAME_INFO[g].title}</span>
                  <span className="text-xs font-medium leading-snug">{GAME_INFO[g].text}</span>
                </button>
              ))}
            </div>
            <div className="flex justify-center gap-2">
              <button onClick={() => choose('random')} className="btn btn-banana">
                🎲 Au hasard
              </button>
              <button onClick={onClose} className="btn">
                Annuler
              </button>
            </div>
          </div>
        )}

        {phase.kind === 'starting' && (
          <p className="font-display text-xl font-bold">Préparation…</p>
        )}

        {phase.kind === 'playing' &&
          // key : une nouvelle partie remonte un composant neuf (état et horloge remis à zéro).
          (phase.attack.minigame === 'quiz' ? (
            <QuizGame
              key={phase.attack.attackId}
              params={phase.attack.params as QuizParams}
              onFinish={finish}
              onAbort={onClose}
            />
          ) : phase.attack.minigame === 'memory' ? (
            <MemoryGame
              key={phase.attack.attackId}
              params={phase.attack.params as MemoryParams}
              onFinish={finish}
              onAbort={onClose}
            />
          ) : (
            <ReflexGame
              key={phase.attack.attackId}
              params={phase.attack.params as ReflexParams}
              onFinish={finish}
              onAbort={onClose}
            />
          ))}

        {phase.kind === 'submitting' && (
          <p className="font-display text-xl font-bold">Validation par le serveur…</p>
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
                  <p className="mt-3 text-xs font-bold uppercase tracking-wide text-ink/60">
                    {GAME_INFO[phase.result.minigame].emoji}{' '}
                    {GAME_INFO[phase.result.minigame].title}
                  </p>
                  <p className="mt-2 font-display text-4xl font-bold">
                    {phase.result.score}
                    <span className="text-lg font-medium text-ink/50">
                      {' '}
                      / {phase.result.maxScore}
                    </span>
                  </p>
                  <GameStats result={phase.result} />
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
                <button
                  onClick={() => setPhase({ kind: 'choose' })}
                  className="btn btn-banana flex-1"
                >
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
              <button
                onClick={() => setPhase({ kind: 'choose' })}
                className="btn btn-banana flex-1"
              >
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
