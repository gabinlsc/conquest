import type { City, Faction, Rarity } from '@conquest/shared';

const RARITY_LABEL: Record<Rarity, { text: string; cls: string }> = {
  common: { text: 'Commune', cls: 'bg-slate-600' },
  rare: { text: 'Rare', cls: 'bg-sky-600' },
  epic: { text: 'Épique', cls: 'bg-violet-600' },
  legendary: { text: 'Légendaire', cls: 'bg-amber-500 text-black' },
};

/** Rapport de force : influence de chaque faction ; il faut dépasser celle de l'occupant (≥ garnison). */
function InfluenceBars({ city }: { city: City }) {
  const rows = city.influence.filter((i) => i.value > 0);
  const top = Math.max(city.garrison, ...rows.map((r) => r.value));
  if (rows.length === 0) {
    return (
      <p className="mt-3 text-xs text-slate-500">Garnison : {city.garrison} — aucune pression.</p>
    );
  }
  return (
    <div className="mt-3 space-y-1.5">
      <p className="text-xs text-slate-500">Influence (garnison {city.garrison})</p>
      {rows.slice(0, 5).map((r) => (
        <div key={r.factionId} className="text-xs">
          <div className="mb-0.5 flex justify-between">
            <span
              className={r.factionId === city.ownerFactionId ? 'font-semibold' : 'text-slate-300'}
            >
              {r.name}
            </span>
            <span className="font-mono text-slate-400">{r.value}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded bg-slate-800">
            <div
              className="h-full rounded"
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
  action: { label: string; enabled: boolean; onClick: () => void };
}

export function CityPanel({ city, owner, onClose, action }: Props) {
  const rarity = RARITY_LABEL[city.rarity];
  return (
    <aside className="absolute bottom-4 left-4 right-4 rounded-xl border border-slate-700 bg-slate-900/95 p-4 shadow-xl backdrop-blur sm:bottom-auto sm:left-auto sm:top-16 sm:w-80">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold leading-tight">{city.name}</h2>
          <p className="text-sm text-slate-400">
            {[city.admin1, city.countryName].filter(Boolean).join(' · ')}
          </p>
        </div>
        <button aria-label="Fermer" onClick={onClose} className="text-slate-400 hover:text-white">
          ✕
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
        <dt className="text-slate-400">Population</dt>
        <dd className="text-right">{city.population.toLocaleString('fr-FR')}</dd>
        <dt className="text-slate-400">Rareté</dt>
        <dd className="text-right">
          <span className={`rounded px-2 py-0.5 text-xs font-semibold ${rarity.cls}`}>
            {rarity.text}
          </span>
        </dd>
        <dt className="text-slate-400">Valeur</dt>
        <dd className="text-right">{city.value} pts / tick</dd>
        <dt className="text-slate-400">Occupant</dt>
        <dd className="flex items-center justify-end gap-2">
          {owner ? (
            <>
              <span
                className="inline-block h-3 w-3 rounded-full"
                style={{ background: owner.color }}
              />
              {owner.name}
            </>
          ) : (
            <span className="text-slate-500">Neutre</span>
          )}
        </dd>
      </dl>
      <InfluenceBars city={city} />
      <button
        disabled={!action.enabled}
        onClick={action.onClick}
        className="mt-4 w-full rounded bg-rose-600 py-2 text-sm font-semibold hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
      >
        {action.label}
      </button>
    </aside>
  );
}
