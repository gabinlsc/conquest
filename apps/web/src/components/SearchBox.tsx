'use client';

import { Search } from 'lucide-react';
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
      <label className="relative block">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          strokeWidth={3}
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Rechercher une ville…"
          className="field pl-9 shadow-pop-sm"
        />
      </label>
      {results.length > 0 && (
        <ul className="card-sm mt-2 overflow-hidden text-sm">
          {results.map((c) => (
            <li key={c.id} className="border-b-2 border-ink/10 last:border-0">
              <button
                className="flex w-full items-center justify-between px-3 py-2 text-left font-medium hover:bg-banana"
                onClick={() => {
                  onPick(c.id);
                  setQ('');
                  setResults([]);
                }}
              >
                <span>{c.name}</span>
                <span className="rounded-md bg-ink px-1.5 text-[11px] font-bold text-white">
                  {c.countryCode}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
