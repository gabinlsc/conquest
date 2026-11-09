import { unzipSync, strFromU8 } from 'fflate';

const BASE = process.env['GEONAMES_BASE_URL'] ?? 'https://download.geonames.org/export/dump';

export interface GeonamesFiles {
  cities: string;
  countries: string;
  admin1: string;
}

async function get(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Télécharge les 3 fichiers GeoNames (licence CC BY 4.0 — attribution affichée dans l'UI). */
export async function downloadGeonames(log: (m: string) => void): Promise<GeonamesFiles> {
  log('téléchargement GeoNames…');
  const [zip, countries, admin1] = await Promise.all([
    get(`${BASE}/cities15000.zip`),
    get(`${BASE}/countryInfo.txt`),
    get(`${BASE}/admin1CodesASCII.txt`),
  ]);
  const entry = unzipSync(zip)['cities15000.txt'];
  if (!entry) throw new Error('cities15000.txt absent de l’archive');
  return { cities: strFromU8(entry), countries: strFromU8(countries), admin1: strFromU8(admin1) };
}
