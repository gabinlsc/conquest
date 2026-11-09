import type { City, Faction, Rarity } from '@conquest/shared';

const RARITY_LABEL: Record<Rarity, { text: string; cls: string }> = {
  common: { text: 'Commune', cls: 'bg-slate-600' },
  rare: { text: 'Rare', cls: 'bg-sky-600' },
  epic: { text: 'Épique', cls: 'bg-violet-600' },
  legendary: { text: 'Légendaire', cls: 'bg-amber-500 text-black' },
};

interface Props {
  city: City;
  owner: Faction | undefined;
  onClose: () => void;
}

export function CityPanel({ city, owner, onClose }: Props) {
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
      <button
        disabled
        title="Disponible en phase 3"
        className="mt-4 w-full cursor-not-allowed rounded bg-slate-700 py-2 text-sm font-semibold text-slate-400"
      >
        Attaquer (bientôt)
      </button>
    </aside>
  );
}
