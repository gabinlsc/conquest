import { Shield, Swords, X } from 'lucide-react';
import type { City, Faction, Rarity } from '@conquest/shared';

const RARITY_LABEL: Record<Rarity, { text: string; cls: string }> = {
  common: { text: 'Commune', cls: 'bg-white' },
  rare: { text: 'Rare', cls: 'bg-sky' },
  epic: { text: 'Épique', cls: 'bg-lilac' },
  legendary: { text: 'Légendaire', cls: 'bg-banana' },
};

/** Rapport de force : influence de chaque faction ; il faut dépasser celle de l'occupant (≥ garnison). */
function InfluenceBars({ city }: { city: City }) {
  const rows = city.influence.filter((i) => i.value > 0);
  const top = Math.max(city.garrison, ...rows.map((r) => r.value));
  if (rows.length === 0) {
    return (
      <p className="mt-3 text-xs font-medium text-ink/60">
        Garnison : {city.garrison} — aucune pression pour l’instant.
      </p>
    );
  }
  return (
    <div className="mt-4 space-y-2">
      <p className="text-xs font-bold uppercase tracking-wide text-ink/60">
        Influence · garnison {city.garrison}
      </p>
      {rows.slice(0, 5).map((r) => (
        <div key={r.factionId} className="text-xs">
          <div className="mb-0.5 flex justify-between">
            <span className={r.factionId === city.ownerFactionId ? 'font-bold' : 'font-medium'}>
              {r.name}
            </span>
            <span className="font-mono font-bold">{r.value}</span>
          </div>
          <div className="h-3 overflow-hidden rounded-full border-2 border-ink bg-cream">
            <div
              className="h-full"
              style={{ width: `${(r.value / top) * 100}%`, background: r.color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

interface Props {
  city: City;
  owner: Pick<Faction, 'name' | 'color'> | undefined;
  onClose: () => void;
  action: {
    label: string;
    enabled: boolean;
    onClick: () => void;
    kind: 'attack' | 'defend' | 'other';
  };
}

export function CityPanel({ city, owner, onClose, action }: Props) {
  const rarity = RARITY_LABEL[city.rarity];
  return (
    <aside className="card absolute bottom-4 left-4 right-4 z-10 p-4 sm:bottom-auto sm:left-auto sm:top-20 sm:w-80">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-2xl leading-tight">{city.name}</h2>
          <p className="text-sm font-medium text-ink/70">
            {[city.admin1, city.countryName].filter(Boolean).join(' · ')}
          </p>
        </div>
        <button aria-label="Fermer" onClick={onClose} className="btn !p-1">
          <X className="h-4 w-4" strokeWidth={3} />
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-2 items-center gap-y-2 text-sm">
        <dt className="font-medium text-ink/60">Population</dt>
        <dd className="text-right font-bold">{city.population.toLocaleString('fr-FR')}</dd>
        <dt className="font-medium text-ink/60">Rareté</dt>
        <dd className="text-right">
          <span className={`pill ${rarity.cls}`}>{rarity.text}</span>
        </dd>
        <dt className="font-medium text-ink/60">Valeur</dt>
        <dd className="text-right font-bold">{city.value} pts / h</dd>
        <dt className="font-medium text-ink/60">Occupant</dt>
        <dd className="flex items-center justify-end gap-2 font-bold">
          {owner ? (
            <>
              <span
                className="inline-block h-4 w-4 rounded-full border-2 border-ink"
                style={{ background: owner.color }}
              />
              {owner.name}
            </>
          ) : (
            <span className="text-ink/50">Neutre</span>
          )}
        </dd>
      </dl>
      <InfluenceBars city={city} />

      <button
        disabled={!action.enabled}
        onClick={action.onClick}
        className={`btn mt-4 w-full ${action.kind === 'defend' ? 'btn-sky' : action.kind === 'attack' ? 'btn-coral' : 'btn-banana'}`}
      >
        {action.kind === 'defend' ? (
          <Shield className="h-4 w-4" strokeWidth={3} />
        ) : action.kind === 'attack' ? (
          <Swords className="h-4 w-4" strokeWidth={3} />
        ) : null}
        {action.label}
      </button>
    </aside>
  );
}
