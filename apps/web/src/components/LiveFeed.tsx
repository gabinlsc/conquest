import type { GameEvent } from '@conquest/shared';
import type { ConnectionStatus } from '@/lib/realtime';

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

interface Props {
  events: GameEvent[];
  online: number;
  status: ConnectionStatus;
  now: number;
  onPick: (e: GameEvent) => void;
}

/** Flux d'événements en direct + état de la connexion. Le clic sur une ligne centre la carte sur la ville. */
export function LiveFeed({ events, online, status, now, onPick }: Props) {
  const badge =
    status === 'online'
      ? { dot: 'bg-emerald-400', text: `${online.toLocaleString('fr-FR')} en ligne` }
      : status === 'connecting'
        ? { dot: 'bg-amber-400', text: 'Connexion…' }
        : { dot: 'bg-red-500', text: 'Hors ligne — reconnexion…' };
  return (
    <div className="pointer-events-none absolute bottom-6 left-4 z-10 w-72 space-y-2 sm:bottom-8">
      <div className="pointer-events-auto flex w-fit items-center gap-2 rounded-full bg-slate-900/90 px-3 py-1 text-xs text-slate-300">
        <span className={`inline-block h-2 w-2 rounded-full ${badge.dot}`} />
        {badge.text}
      </div>
      <ul className="space-y-1.5">
        {events.slice(0, 6).map((e, i) => (
          <li key={e.id} style={{ opacity: 1 - i * 0.13 }}>
            <button
              onClick={() => onPick(e)}
              className="pointer-events-auto w-full rounded-lg border border-slate-800 bg-slate-900/85 px-3 py-1.5 text-left text-xs leading-snug backdrop-blur hover:bg-slate-800"
            >
              <span
                className="mr-1.5 inline-block h-2 w-2 rounded-full"
                style={{ background: e.faction.color }}
              />
              <strong>{e.faction.name}</strong> a capturé <strong>{e.cityName}</strong>
              {e.from && <span className="text-slate-400"> à {e.from.name}</span>}
              <span className="ml-1 text-slate-500">· {ago(e.at, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
