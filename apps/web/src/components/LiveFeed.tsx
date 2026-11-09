import { Flag } from 'lucide-react';
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
      ? { dot: 'bg-mint', text: `${online.toLocaleString('fr-FR')} en ligne` }
      : status === 'connecting'
        ? { dot: 'bg-banana', text: 'Connexion…' }
        : { dot: 'bg-coral', text: 'Hors ligne — reconnexion…' };
  return (
    <div className="pointer-events-none absolute bottom-8 left-4 z-10 w-72 space-y-2">
      <div className="card-sm pointer-events-auto flex w-fit items-center gap-2 px-3 py-1 text-xs font-bold">
        <span className={`inline-block h-3 w-3 rounded-full border-2 border-ink ${badge.dot}`} />
        {badge.text}
      </div>
      <ul className="space-y-2">
        {events.slice(0, 5).map((e, i) => (
          <li key={e.id} style={{ opacity: 1 - i * 0.14 }}>
            <button
              onClick={() => onPick(e)}
              className="card-sm pointer-events-auto w-full px-3 py-1.5 text-left text-xs leading-snug transition hover:-translate-y-px hover:bg-banana"
            >
              <Flag
                className="mr-1.5 inline h-3.5 w-3.5 align-[-2px]"
                strokeWidth={3}
                style={{ color: e.faction.color, fill: e.faction.color }}
              />
              <strong>{e.faction.name}</strong> a capturé <strong>{e.cityName}</strong>
              {e.from && <span className="text-ink/60"> à {e.from.name}</span>}
              <span className="ml-1 font-bold text-ink/40">· {ago(e.at, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
