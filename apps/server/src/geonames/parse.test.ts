import { describe, expect, it } from 'vitest';
import { parseAdmin1, parseCityLine, parseCountryInfo } from './parse';
import { FIXTURE_ADMIN1, FIXTURE_CITIES, FIXTURE_COUNTRIES } from './fixtures';

describe('parseCityLine', () => {
  const lines = FIXTURE_CITIES.split('\n');

  it('parse une ligne valide et calcule rareté/valeur', () => {
    const tokyo = parseCityLine(lines[5]!);
    expect(tokyo).toMatchObject({
      geonamesId: 1850147,
      name: 'Tokyo',
      countryCode: 'JP',
      population: 8336599,
      rarity: 'legendary',
    });
    expect(tokyo?.value).toBeGreaterThan(5);
    expect(parseCityLine(lines[1]!)?.rarity).toBe('rare');
  });

  it.each([
    ['ligne trop courte', 'abc\tdef'],
    ['id non numérique', FIXTURE_CITIES.split('\n')[0]!.replace('2988507', 'x')],
    ['latitude hors limites', FIXTURE_CITIES.split('\n')[0]!.replace('48.85341', '91')],
    ['population nulle', FIXTURE_CITIES.split('\n')[0]!.replace('2138551', '0')],
  ])('rejette : %s', (_label, line) => {
    expect(parseCityLine(line)).toBeNull();
  });
});

describe('parseCountryInfo / parseAdmin1', () => {
  it('ignore les commentaires et extrait pays + continent', () => {
    const rows = parseCountryInfo(FIXTURE_COUNTRIES);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ code: 'FR', name: 'France', continent: 'EU' });
  });
  it('indexe les régions par code pays.admin1', () => {
    expect(parseAdmin1(FIXTURE_ADMIN1).get('FR.B8')).toBe('Auvergne-Rhône-Alpes');
  });
});
