'use client';

import { Siren, X } from 'lucide-react';
import { useEffect } from 'react';
import type { CityAlert } from '@conquest/shared';

const LIFETIME_MS = 9_000;

interface Props {
  alerts: CityAlert[];
  onDismiss: (id: string) => void;
  onView: (a: CityAlert) => void;
}

/** Alertes « ta ville est attaquée » : autocollants empilés en haut de l'écran, disparaissent seuls. */
export function Toasts({ alerts, onDismiss, onView }: Props) {
  return (
    <div className="pointer-events-none absolute left-1/2 top-24 z-30 flex w-[min(92vw,26rem)] -translate-x-1/2 flex-col gap-2">
      {alerts.slice(0, 3).map((a) => (
        <Toast key={a.id} alert={a} onDismiss={onDismiss} onView={onView} />
      ))}
    </div>
  );
}

function Toast({
  alert,
  onDismiss,
  onView,
}: {
  alert: CityAlert;
  onDismiss: (id: string) => void;
  onView: (a: CityAlert) => void;
}) {
  useEffect(() => {
    const t = setTimeout(() => onDismiss(alert.id), LIFETIME_MS);
    return () => clearTimeout(t);
  }, [alert.id, onDismiss]);

  return (
    <div
      role="alert"
      className={`card pointer-events-auto flex animate-toast items-center gap-3 px-3 py-2 ${alert.captured ? 'bg-coral' : 'bg-banana'}`}
    >
      <Siren className="h-6 w-6 shrink-0" strokeWidth={3} />
      <p className="min-w-0 flex-1 text-sm font-bold leading-snug">
        {alert.captured ? (
          <>
            <span className="font-display text-base">{alert.cityName}</span> vient de tomber aux
            mains de {alert.by.name} !
          </>
        ) : (
          <>
            <span className="font-display text-base">{alert.cityName}</span> est attaquée par{' '}
            {alert.by.name} <span className="font-medium">(+{alert.gain})</span>
          </>
        )}
      </p>
      <button className="btn !px-2 !py-0.5 text-xs" onClick={() => onView(alert)}>
        Voir
      </button>
      <button aria-label="Fermer" onClick={() => onDismiss(alert.id)} className="shrink-0">
        <X className="h-4 w-4" strokeWidth={3} />
      </button>
    </div>
  );
}
