import {
  DECAY_PER_HOUR,
  MAX_DEFENSE_FACTOR,
  SHIELD_MS,
  garrisonFor,
  type CityInfluenceState,
} from '@conquest/shared';
import type { Db } from '../db/pool';
import type { CityIndex } from './geo';
import type { Redis } from './redis';
import { APPLY_ATTACK_LUA } from './scripts';

/** Clés Redis de l'état chaud du monde. */
export const K = {
  owners: 'w:owners', // hash cityId -> factionId (0 = neutre)
  vers: 'w:vers', // hash cityId -> version (séquence globale du dernier changement)
  seq: 'w:seq', // compteur global (INCR) ; amorcé avec Date.now() pour rester croissant après une ré-hydratation
  dirty: 'w:dirty', // set des villes modifiées, à persister dans Postgres (write-behind)
  ready: 'w:ready', // présent quand l'état a été chargé depuis Postgres
  city: (id: number) => `w:c:${id}`, // hash t, s, i:<faction>
  applied: (attackId: string) => `w:applied:${attackId}`,
};

const APPLIED_TTL_S = 86_400;
const CHUNK = 2_000;

export interface ApplyArgs {
  attackId: string;
  cityId: number;
  factionId: number;
  gain: number;
  /** Injectable pour les tests ; sinon l'horloge du serveur. */
  now?: number;
}

export interface ApplyResult {
  owner: number;
  prevOwner: number;
  captured: boolean;
  defended: boolean;
  shielded: boolean;
  ver: number;
  ownerInfluence: number;
  influence: [number, number][];
  shieldUntil: number;
  /** true si cette attaque avait déjà été appliquée (résultat rejoué, rien n'a changé). */
  replay: boolean;
}

export interface CityLive {
  owner: number;
  ver: number;
  influence: Record<number, number>;
  shieldUntil: number;
}

type RawResult = {
  owner: number;
  prev: number;
  captured: boolean;
  defended: boolean;
  shielded: boolean;
  ver: number;
  ownerInf: number;
  inf: [number, number][] | Record<string, never>;
  shieldUntil: number;
  replay?: boolean;
};

type ApplyCommand = (...args: (string | number)[]) => Promise<string>;

export class WorldStore {
  constructor(
    readonly redis: Redis,
    private readonly geo: CityIndex,
  ) {
    (redis as unknown as { defineCommand: (n: string, o: object) => void }).defineCommand(
      'conquestApply',
      { numberOfKeys: 6, lua: APPLY_ATTACK_LUA },
    );
  }

  /** Redis est-il joignable ? Sinon les appelants basculent en mode dégradé (Postgres). */
  isUp(): boolean {
    return this.redis.status === 'ready';
  }

  // ---------- Hydratation (Postgres -> Redis) ----------

  /**
   * Charge l'état depuis Postgres si Redis est vide (premier démarrage, ou Redis perdu/vidé).
   * Idempotent. Redis (AOF) reste la source chaude ensuite ; Postgres reçoit les changements en write-behind.
   */
  async hydrateIfEmpty(db: Db): Promise<boolean> {
    if (await this.redis.exists(K.ready)) return false;
    const { rows } = await db.query<{
      geonames_id: number;
      owner_faction_id: number | null;
      influence: { i?: Record<string, number>; t?: number; s?: number; v?: number };
    }>('SELECT geonames_id, owner_faction_id, influence FROM city_state');

    // La séquence repart AU-DESSUS de la plus grande version persistée (et de l'horloge) : toute version émise
    // après une ré-hydratation doit être plus récente que celles que les clients ont déjà vues, sinon ils
    // ignoreraient les deltas. La marge couvre les ≤ 2 s de modifications qui n'avaient pas encore été persistées.
    const maxPersisted = rows.reduce((m, r) => Math.max(m, r.influence?.v ?? 0), 0);
    const seed = Math.max(maxPersisted, Date.now()) + 100_000;
    await this.redis.set(K.seq, seed);

    for (let i = 0; i < rows.length; i += CHUNK) {
      const pipe = this.redis.pipeline();
      for (const r of rows.slice(i, i + CHUNK)) {
        pipe.hset(K.owners, r.geonames_id, r.owner_faction_id ?? 0);
        pipe.hset(K.vers, r.geonames_id, r.influence?.v ?? seed);
        const inf = r.influence?.i ?? {};
        const fields: Record<string, number> = {};
        for (const [f, v] of Object.entries(inf)) fields[`i:${f}`] = v;
        if (Object.keys(fields).length > 0) {
          fields['t'] = r.influence.t ?? seed;
          fields['s'] = r.influence.s ?? 0;
          pipe.del(K.city(r.geonames_id));
          pipe.hset(K.city(r.geonames_id), fields);
        }
      }
      await pipe.exec();
    }
    await this.redis.set(K.ready, '1');
    return true;
  }

  // ---------- Attaques ----------

  async applyAttack(args: ApplyArgs): Promise<ApplyResult> {
    const city = this.geo.get(args.cityId);
    if (!city) throw new Error(`ville inconnue : ${args.cityId}`);
    const apply = (this.redis as unknown as { conquestApply: ApplyCommand }).conquestApply.bind(
      this.redis,
    );
    const raw = await apply(
      K.city(args.cityId),
      K.owners,
      K.vers,
      K.applied(args.attackId),
      K.dirty,
      K.seq,
      args.cityId,
      args.factionId,
      args.gain,
      garrisonFor(city.value),
      args.now ?? Date.now(),
      DECAY_PER_HOUR,
      SHIELD_MS,
      MAX_DEFENSE_FACTOR,
      APPLIED_TTL_S,
    );
    const r = JSON.parse(raw) as RawResult;
    return {
      owner: r.owner,
      prevOwner: r.prev,
      captured: r.captured,
      defended: r.defended,
      shielded: r.shielded,
      ver: r.ver,
      ownerInfluence: r.ownerInf,
      influence: Array.isArray(r.inf) ? r.inf : [],
      shieldUntil: r.shieldUntil,
      replay: r.replay === true,
    };
  }

  // ---------- Lectures ----------

  /** État chaud d'une ville (null si Redis ne la connaît pas). */
  async getCity(cityId: number): Promise<CityLive | null> {
    const [owner, ver, raw] = await Promise.all([
      this.redis.hget(K.owners, String(cityId)),
      this.redis.hget(K.vers, String(cityId)),
      this.redis.hgetall(K.city(cityId)),
    ]);
    if (owner === null) return null;
    const influence: Record<number, number> = {};
    for (const [k, v] of Object.entries(raw))
      if (k.startsWith('i:')) influence[Number(k.slice(2))] = Number(v);
    return {
      owner: Number(owner),
      ver: Number(ver ?? 0),
      influence,
      shieldUntil: Number(raw['s'] ?? 0),
    };
  }

  /** Propriétaire + version de toutes les villes d'une tuile : une seule requête groupée par champ. */
  async tileSnapshot(tile: string): Promise<[number, number, number][]> {
    const ids = this.geo.idsInTile(tile);
    const out: [number, number, number][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK).map(String);
      const [owners, vers] = await Promise.all([
        this.redis.hmget(K.owners, ...part),
        this.redis.hmget(K.vers, ...part),
      ]);
      part.forEach((id, j) => out.push([Number(id), Number(owners[j] ?? 0), Number(vers[j] ?? 0)]));
    }
    return out;
  }

  /** Version Postgres d'un snapshot de tuile (mode dégradé : Redis injoignable). ver = 0 => « à rafraîchir ». */
  async tileSnapshotFromPg(db: Db, tile: string): Promise<[number, number, number][]> {
    const ids = [...this.geo.idsInTile(tile)];
    if (ids.length === 0) return [];
    const { rows } = await db.query<{ geonames_id: number; owner_faction_id: number | null }>(
      'SELECT geonames_id, owner_faction_id FROM city_state WHERE geonames_id = ANY($1::int[])',
      [ids],
    );
    return rows.map((r) => [r.geonames_id, r.owner_faction_id ?? 0, 0]);
  }

  /** Reconstitue l'état d'une ville pour le test différentiel et le diagnostic. */
  async getInfluenceState(cityId: number): Promise<CityInfluenceState | null> {
    const live = await this.getCity(cityId);
    if (!live) return null;
    const raw = await this.redis.hgetall(K.city(cityId));
    return {
      owner: live.owner,
      influence: live.influence,
      lastTouch: Number(raw['t'] ?? 0),
      shieldUntil: live.shieldUntil,
    };
  }

  // ---------- Dissolution d'un clan ----------

  /**
   * Redonne à `toFaction(cityId)` toutes les villes détenues par une faction dissoute et efface son influence.
   * Retourne les villes modifiées (pour diffuser les deltas).
   */
  async reassignFaction(
    fromFaction: number,
    toFaction: (cityId: number) => number,
  ): Promise<{ cityId: number; owner: number; ver: number }[]> {
    const changed: { cityId: number; owner: number; ver: number }[] = [];
    let cursor = '0';
    const mine: number[] = [];
    do {
      const [next, entries] = await this.redis.hscan(K.owners, cursor, 'COUNT', 1000);
      cursor = next;
      for (let i = 0; i < entries.length; i += 2) {
        if (Number(entries[i + 1]) === fromFaction) mine.push(Number(entries[i]));
      }
    } while (cursor !== '0');
    for (const cityId of mine) {
      const owner = toFaction(cityId);
      const ver = await this.redis.incr(K.seq);
      await this.redis
        .multi()
        .hset(K.owners, cityId, owner)
        .hset(K.vers, cityId, ver)
        .sadd(K.dirty, cityId)
        .exec();
      changed.push({ cityId, owner, ver });
    }
    // Purge l'influence résiduelle de la faction dissoute dans les villes touchées.
    const all = await this.redis.smembers(K.dirty);
    for (const id of all) await this.redis.hdel(K.city(Number(id)), `i:${fromFaction}`);
    return changed;
  }

  // ---------- Write-behind (Redis -> Postgres) ----------

  /** Nombre de villes en attente de persistance. */
  pendingCount(): Promise<number> {
    return this.redis.scard(K.dirty);
  }

  /**
   * Persiste dans Postgres les villes modifiées depuis la dernière passe. Les ids sont retirés du set AVANT
   * l'écriture puis remis en cas d'échec : une ville modifiée pendant l'écriture est de nouveau marquée par
   * le script Lua et sera reprise à la passe suivante (jamais de modification perdue).
   */
  async persistDirty(db: Db, max = 500): Promise<number> {
    const ids = await this.redis.spop(K.dirty, max);
    if (ids.length === 0) return 0;
    try {
      const pipe = this.redis.pipeline();
      for (const id of ids) {
        pipe.hget(K.owners, id);
        pipe.hgetall(K.city(Number(id)));
        pipe.hget(K.vers, id);
      }
      const res = (await pipe.exec()) ?? [];
      const rows = ids.map((id, i) => {
        const owner = Number((res[i * 3]?.[1] as string | null) ?? 0);
        const raw = (res[i * 3 + 1]?.[1] ?? {}) as Record<string, string>;
        const ver = Number((res[i * 3 + 2]?.[1] as string | null) ?? 0);
        const inf: Record<string, number> = {};
        for (const [k, v] of Object.entries(raw))
          if (k.startsWith('i:')) inf[k.slice(2)] = Number(v);
        return {
          id: Number(id),
          owner,
          influence: JSON.stringify({
            i: inf,
            t: Number(raw['t'] ?? 0),
            s: Number(raw['s'] ?? 0),
            v: ver,
          }),
        };
      });
      await upsertCityStates(db, rows);
      return rows.length;
    } catch (err) {
      await this.redis.sadd(K.dirty, ...ids).catch(() => undefined);
      throw err;
    }
  }
}

interface StateRow {
  id: number;
  owner: number;
  influence: string;
}

async function upsertCityStates(db: Db, rows: StateRow[]): Promise<void> {
  const sql = `INSERT INTO city_state (geonames_id, owner_faction_id, influence, updated_at)
               SELECT id, NULLIF(owner, 0), inf::jsonb, now()
               FROM unnest($1::int[], $2::int[], $3::text[]) AS t(id, owner, inf)
               ON CONFLICT (geonames_id) DO UPDATE
                 SET owner_faction_id = EXCLUDED.owner_faction_id,
                     influence = EXCLUDED.influence, updated_at = now()`;
  try {
    await db.query(sql, [
      rows.map((r) => r.id),
      rows.map((r) => r.owner),
      rows.map((r) => r.influence),
    ]);
  } catch {
    // Une ligne pose problème (ex. faction propriétaire supprimée : violation de clé étrangère) :
    // on réessaie ligne à ligne et la fautive est écrite sans propriétaire plutôt que de bloquer le lot.
    for (const r of rows) {
      try {
        await db.query(sql, [[r.id], [r.owner], [r.influence]]);
      } catch {
        await db.query(sql, [[r.id], [0], [r.influence]]);
      }
    }
  }
}
