import type { Faction } from '@conquest/shared';
import type { Db } from '../db/pool';

interface Row {
  id: number;
  kind: 'country' | 'clan';
  name: string;
  color: string;
  country_code: string | null;
  slug: string;
}

const toFaction = (r: Row): Faction => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  color: r.color,
  countryCode: r.country_code?.trim() ?? null,
});

/** Annuaire mémoire des factions (couleurs, noms). Les clans créés après le démarrage sont chargés à la demande. */
export class FactionDirectory {
  private readonly cache = new Map<number, Faction>();
  private readonly countryIds = new Map<string, number>();

  constructor(private readonly db: Db) {}

  static async load(db: Db): Promise<FactionDirectory> {
    const dir = new FactionDirectory(db);
    const { rows } = await db.query<Row>(
      'SELECT id, kind, name, color, country_code, slug FROM factions',
    );
    for (const r of rows) dir.put(r);
    return dir;
  }

  private put(r: Row): Faction {
    const f = toFaction(r);
    this.cache.set(f.id, f);
    if (f.kind === 'country' && f.countryCode) this.countryIds.set(f.countryCode, f.id);
    return f;
  }

  async get(id: number): Promise<Faction | null> {
    if (id === 0) return null;
    const hit = this.cache.get(id);
    if (hit) return hit;
    const { rows } = await this.db.query<Row>(
      'SELECT id, kind, name, color, country_code, slug FROM factions WHERE id = $1',
      [id],
    );
    return rows[0] ? this.put(rows[0]) : null;
  }

  /** Id de la faction d'un pays (0 si inconnue). */
  countryFactionId(countryCode: string): number {
    return this.countryIds.get(countryCode) ?? 0;
  }

  forget(id: number): void {
    this.cache.delete(id);
  }
}
