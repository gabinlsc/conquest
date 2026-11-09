'use client';

import dynamic from 'next/dynamic';

// MapLibre exige `window` : rendu côté client uniquement.
const WorldMap = dynamic(() => import('./WorldMap'), { ssr: false });

export function MapLoader() {
  return <WorldMap />;
}
