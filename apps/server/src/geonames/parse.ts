import { rarityForPopulation, valueForPopulation, type Rarity } from '@conquest/shared';

export interface CityRow {
  geonamesId: number;
  name: string;
  asciiName: string;
  countryCode: string;
  admin1Code: string;
  population: number;
  lat: number;
  lon: number;
  rarity: Rarity;
  value: number;
}

export interface CountryRow {
  code: string;
  name: string;
  continent: string;
}

/**
 * Parse une ligne de cities15000.txt (TSV, 19 colonnes).
 * Retourne null pour les lignes inexploitables : un fichier tiers ne doit jamais
 * faire planter l'import, on ignore et on compte les rejets côté appelant.
 */
export function parseCityLine(line: string): CityRow | null {
  const c = line.split('\t');
  if (c.length < 15) return null;
  const geonamesId = Number(c[0]);
  const lat = Number(c[4]);
  const lon = Number(c[5]);
  const population = Number(c[14]);
  const name = c[1];
  const asciiName = c[2];
  const countryCode = c[8];
  if (
    !Number.isInteger(geonamesId) ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    !Number.isFinite(population) ||
    population <= 0 ||
    !name ||
    !asciiName ||
    !countryCode ||
    countryCode.length !== 2
  ) {
    return null;
  }
  return {
    geonamesId,
    name,
    asciiName,
    countryCode,
    admin1Code: c[10] ?? '',
    population,
    lat,
    lon,
    rarity: rarityForPopulation(population),
    value: valueForPopulation(population),
  };
}

/** countryInfo.txt : commentaires '#', colonnes ISO(0) … Country(4) … Continent(8). */
export function parseCountryInfo(text: string): CountryRow[] {
  const rows: CountryRow[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const c = line.split('\t');
    const [code, name, continent] = [c[0], c[4], c[8]];
    if (code?.length === 2 && name && continent) rows.push({ code, name, continent });
  }
  return rows;
}

/** admin1CodesASCII.txt : "FR.A8<TAB>Name<TAB>AsciiName<TAB>id" -> Map("FR.A8" => "Name"). */
export function parseAdmin1(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split('\n')) {
    const c = line.split('\t');
    if (c[0] && c[1]) map.set(c[0], c[1]);
  }
  return map;
}
