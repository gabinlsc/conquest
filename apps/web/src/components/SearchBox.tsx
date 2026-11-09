'use client';

import { useEffect, useState } from 'react';
import type { City } from '@conquest/shared';
import { searchCities } from '@/lib/api';

export function SearchBox({ onPick }: { onPick: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<City[]>([]);

  // Debounce 250 ms + annulation de la requête précédente (évite les réponses hors ordre).
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const abort = new AbortController();
    const t = setTimeout(() => {
      searchCities(q.trim(), abort.signal)
        .then((r) => setResults(r.items))
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(t);
      abort.abort();
    };
  }, [q]);

  return (
    <div className="w-64">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Rechercher une ville…"
        className="w-full rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-2 text-sm outline-none focus:border-sky-500"
      />
      {results.length > 0 && (
        <ul className="mt-1 overflow-hidden rounded-lg border border-slate-700 bg-slate-900/95 text-sm">
          {results.map((c) => (
            <li key={c.id}>
              <button
                className="flex w-full justify-between px-3 py-2 text-left hover:bg-slate-800"
                onClick={() => {
                  onPick(c.id);
                  setQ('');
                  setResults([]);
                }}
              >
                <span>{c.name}</span>
                <span className="text-slate-500">{c.countryCode}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
