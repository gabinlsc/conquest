'use client';

import { useEffect, useState } from 'react';
import type { Country } from '@conquest/shared';
import { fetchCountries } from '@/lib/api';

let cache: Country[] | null = null;

export function CountrySelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const [countries, setCountries] = useState<Country[]>(cache ?? []);

  useEffect(() => {
    if (cache) return;
    fetchCountries()
      .then((list) => {
        cache = list;
        setCountries(list);
      })
      .catch(() => undefined);
  }, []);

  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm outline-none focus:border-sky-500"
    >
      <option value="">— Choisir un pays —</option>
      {countries.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
