import { tileOf } from '@conquest/shared';
import type { Db } from '../db/pool';

export interface CityMeta {
  id: number;
  name: string;
  countryCode: string;
  value: number;
  lon: number;
  lat: number;
  tile: string;
}

/**
 * Index mémoire des villes (≈ 34 000 entrées, quelques Mo) : métadonnées statiques + répartition par tuile.
 * La géométrie ne change qu'à l'import GeoNames : on la charge une fois au démarrage.
 */
export class CityIndex {
  private readonly byId = new Map<number, CityMeta>();
  private readonly byTile = new Map<string, number[]>();
  private readonly byCountry = new Map<string, number[]>();

  static async load(db: Db): Promise<CityIndex> {
    const idx = new CityIndex();
    const { rows } = await db.query<{
      geonames_id: number;
      name: string;
      country_code: string;
      value: number;
      lon: number;
      lat: number;
    }>(
      `SELECT geonames_id, name, country_code, value, ST_X(geom) AS lon, ST_Y(geom) AS lat FROM cities`,
    );
    for (const r of rows) idx.add(r.geonames_id, r.name, r.country_code, r.value, r.lon, r.lat);
    return idx;
  }

  add(
    id: number,
    name: string,
    countryCode: string,
    value: number,
    lon: number,
    lat: number,
  ): void {
    const tile = tileOf(lon, lat);
    this.byId.set(id, { id, name, countryCode: countryCode.trim(), value, lon, lat, tile });
    const list = this.byTile.get(tile);
    if (list) list.push(id);
    else this.byTile.set(tile, [id]);
    const cc = countryCode.trim();
    const inCountry = this.byCountry.get(cc);
    if (inCountry) inCountry.push(id);
    else this.byCountry.set(cc, [id]);
  }

  get(id: number): CityMeta | undefined {
    return this.byId.get(id);
  }

  idsInTile(tile: string): readonly number[] {
    return this.byTile.get(tile) ?? [];
  }

  idsInCountry(countryCode: string): readonly number[] {
    return this.byCountry.get(countryCode) ?? [];
  }

  /** Codes pays, du plus au moins riche en villes. */
  countriesByCityCount(): string[] {
    return [...this.byCountry.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([cc]) => cc);
  }

  get size(): number {
    return this.byId.size;
  }
}
