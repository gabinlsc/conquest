'use client';

import { useEffect, useState } from 'react';
import type { Country } from '@conquest/shared';
import { fetchCountries } from '@/lib/api';

let cache: Country[] | null = null;

export function CountrySelect({
  value,
  onChange,
  disabled,
  placeholder = '— Choisir un pays —',
}: {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  placeholder?: string;
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
      className="field cursor-pointer"
    >
      <option value="">{placeholder}</option>
      {countries.map((c) => (
        <option key={c.code} value={c.code}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
