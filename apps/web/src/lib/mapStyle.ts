import type { DataDrivenPropertyValueSpecification, StyleSpecification } from 'maplibre-gl';
import { RARITIES, type Rarity } from '@conquest/shared';

/** Couleur d'une ville sans propriétaire connu. */
export const NEUTRAL_COLOR = '#5b6785';

/**
 * Fond de carte 100 % local (frontières Natural Earth + polices statiques) :
 * aucune dépendance à un service de tuiles tiers.
 */
export const baseStyle: StyleSpecification = {
  version: 8,
  glyphs: '/fonts/{fontstack}/{range}.pbf',
  sources: {
    countries: { type: 'geojson', data: '/geo/countries.json' },
  },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#070b17' } },
    { id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': '#111a30' } },
    {
      id: 'borders',
      type: 'line',
      source: 'countries',
      paint: {
        'line-color': '#2a3858',
        'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 8, 1.2],
      },
    },
  ],
};

/** Rayon de base (px) par rareté, à zoom faible puis à zoom élevé. */
const RADIUS: Record<Rarity, [number, number]> = {
  common: [1.6, 7],
  rare: [2.4, 9],
  epic: [3.4, 12],
  legendary: [4.6, 15],
};

/** Expression de rayon : interpolation par zoom dont chaque borne dépend de la rareté. */
export function radiusExpression(): DataDrivenPropertyValueSpecification<number> {
  const at = (i: 0 | 1) =>
    [
      'match',
      ['get', 'rarity'],
      ...RARITIES.flatMap((r) => [r, RADIUS[r][i]]),
      RADIUS.common[i],
    ] as const;
  return ['interpolate', ['linear'], ['zoom'], 2, at(0), 12, at(1)] as never;
}
