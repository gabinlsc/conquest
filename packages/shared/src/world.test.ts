import { describe, expect, it } from 'vitest';
import { citiesQuerySchema, colorForKey, rarityForPopulation, valueForPopulation } from './world';

describe('rarityForPopulation', () => {
  it.each([
    [15_000, 'common'],
    [249_999, 'common'],
    [250_000, 'rare'],
    [1_000_000, 'epic'],
    [5_000_000, 'legendary'],
  ])('%i -> %s', (pop, rarity) => {
    expect(rarityForPopulation(pop)).toBe(rarity);
  });
});

describe('valueForPopulation', () => {
  it('reste borné entre 1 et 10 et croît avec la population', () => {
    expect(valueForPopulation(1)).toBe(1);
    expect(valueForPopulation(15_000)).toBe(1);
    expect(valueForPopulation(40_000_000)).toBe(10);
    expect(valueForPopulation(999_999_999)).toBe(10);
    expect(valueForPopulation(1_000_000)).toBeGreaterThan(valueForPopulation(100_000));
  });
});

describe('colorForKey', () => {
  it('est déterministe et au format #rrggbb', () => {
    expect(colorForKey('FR')).toBe(colorForKey('FR'));
    expect(colorForKey('FR')).toMatch(/^#[0-9a-f]{6}$/);
    expect(colorForKey('FR')).not.toBe(colorForKey('DE'));
  });
});

describe('citiesQuerySchema', () => {
  it('parse bbox, pays et limites par défaut', () => {
    const q = citiesQuerySchema.parse({ bbox: '-5.5,41,9.8,51', country: 'fr' });
    expect(q.bbox).toEqual([-5.5, 41, 9.8, 51]);
    expect(q.country).toBe('FR');
    expect(q.limit).toBe(50);
  });
  it('rejette une bbox hors limites ou une limite excessive', () => {
    expect(citiesQuerySchema.safeParse({ bbox: '10,0,5,1' }).success).toBe(false);
    expect(citiesQuerySchema.safeParse({ bbox: '0,0,200,1' }).success).toBe(false);
    expect(citiesQuerySchema.safeParse({ limit: '5000' }).success).toBe(false);
  });
});
