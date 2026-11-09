import {
  TERRITORY_TICK_MS,
  TICKS_PER_HOUR,
  type PastSeason,
  type SeasonInfo,
} from '@conquest/shared';
import type { Db } from '../db/pool';
import type { CityIndex } from '../world/geo';
import { K, type WorldStore } from '../world/store';
import type { LeaderboardService } from './leaderboards';

export interface SeasonPublisher {
  season(info: SeasonInfo, reset: boolean): void;
}

interface SeasonRow {
  id: number;
  name: string;
  starts_at: Date;
  ends_at: Date;
  status: 'active' | 'ended';
  results: { players: unknown[]; factions: unknown[] } | null;
}

const toInfo = (r: SeasonRow): SeasonInfo => ({
  id: r.id,
  name: r.name,
  startsAt: r.starts_at.toISOString(),
  endsAt: r.ends_at.toISOString(),
});

/**
 * Cycle de vie des saisons.
 *  - Chaque saison dure `durationMs` (SEASON_WEEKS semaines).
 *  - À l'échéance : les parties sont suspendues, les classements sont figés (podium conservé), la carte est
 *    remise à zéro (chaque ville revient à la faction de son pays), puis la saison suivante démarre.
 *  - Les clans, les comptes et l'historique des parties survivent aux saisons ; seuls territoires et points repartent.
 */
export class SeasonService {
  publisher: SeasonPublisher = { season: () => undefined };
  /** true pendant la remise à zéro : les nouvelles parties sont refusées (503) pour ne pas viser un monde en cours de reset. */
  paused = false;
  private cached: SeasonInfo | null = null;

  constructor(
    private readonly deps: {
      db: Db;
      store: WorldStore;
      geo: CityIndex;
      leaderboards: LeaderboardService;
      durationMs: number;
    },
  ) {}

  /** Saison active (créée au besoin). */
  async current(): Promise<SeasonInfo> {
    if (this.cached) return this.cached;
    return this.refresh();
  }

  async refresh(): Promise<SeasonInfo> {
    const { db, durationMs } = this.deps;
    let { rows } = await db.query<SeasonRow>(`SELECT * FROM seasons WHERE status = 'active'`);
    if (rows.length === 0) {
      // ON CONFLICT : deux processus qui démarrent en même temps ne créent pas deux saisons.
      await db.query(
        `INSERT INTO seasons (name, starts_at, ends_at)
         SELECT 'Saison ' || (coalesce(max(id), 0) + 1), now(), now() + make_interval(secs => $1)
         FROM seasons
         ON CONFLICT DO NOTHING`,
        [durationMs / 1000],
      );
      ({ rows } = await db.query<SeasonRow>(`SELECT * FROM seasons WHERE status = 'active'`));
    }
    this.cached = toInfo(rows[0]!);
    return this.cached;
  }

  async past(limit = 20): Promise<PastSeason[]> {
    const { rows } = await this.deps.db.query<SeasonRow>(
      `SELECT * FROM seasons WHERE status = 'ended' ORDER BY id DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      ...toInfo(r),
      winners: (r.results as unknown as PastSeason['winners']) ?? { players: [], factions: [] },
    }));
  }

  /** Appelé régulièrement : clôture la saison échue et verse le revenu des territoires. */
  async tick(now = Date.now()): Promise<void> {
    const season = await this.refresh();
    if (now >= new Date(season.endsAt).getTime()) {
      await this.rollover(season);
      return;
    }
    await this.territoryTick(season.id, now);
  }

  /** Chaque faction gagne la valeur cumulée de ses villes (par heure, versée toutes les 5 minutes). */
  async territoryTick(seasonId: number, now: number): Promise<void> {
    const { store, geo, leaderboards } = this.deps;
    if (!store.isUp()) return;
    const owners = await store.redis.hgetall(K.owners);
    const valueByFaction = new Map<number, number>();
    for (const [cityId, owner] of Object.entries(owners)) {
      const f = Number(owner);
      if (f === 0) continue;
      const city = geo.get(Number(cityId));
      if (city) valueByFaction.set(f, (valueByFaction.get(f) ?? 0) + city.value);
    }
    const income = new Map<number, number>();
    for (const [f, total] of valueByFaction) income.set(f, Math.round(total / TICKS_PER_HOUR));
    await leaderboards.addTerritoryIncome(seasonId, income, Math.floor(now / TERRITORY_TICK_MS));
  }

  /** Clôture la saison `season` et démarre la suivante. Réentrant : un second appel concurrent est ignoré. */
  async rollover(season: SeasonInfo): Promise<boolean> {
    const { db, store, leaderboards, durationMs } = this.deps;
    if (this.paused) return false;
    // Verrou inter-processus : un seul instance exécute la clôture.
    if (
      store.isUp() &&
      (await store.redis.set('season:rollover', '1', 'PX', 300_000, 'NX')) !== 'OK'
    )
      return false;
    this.paused = true;
    try {
      // 1. Dernière vidange des points vers Postgres.
      if (store.isUp()) {
        await leaderboards.ensureSeasonLoaded(season.id);
        while ((await leaderboards.flush()) > 0);
        while ((await store.persistDirty(db)) > 0);
      }
      // 2. Podium figé + saison suivante + remise à zéro de la carte (une seule transaction).
      const [players, nations, clans] = await Promise.all([
        leaderboards.top(season.id, 'players', { limit: 10, offset: 0 }),
        leaderboards.top(season.id, 'nations', { limit: 10, offset: 0 }),
        leaderboards.top(season.id, 'clans', { limit: 10, offset: 0 }),
      ]);
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE seasons SET status = 'ended', ends_at = least(ends_at, now()), results = $2 WHERE id = $1`,
          [
            season.id,
            JSON.stringify({
              players: players.entries,
              factions: [...nations.entries, ...clans.entries]
                .sort((a, b) => b.points - a.points)
                .slice(0, 10),
            }),
          ],
        );
        await client.query(
          `INSERT INTO seasons (name, starts_at, ends_at)
           SELECT 'Saison ' || (max(id) + 1), now(), now() + make_interval(secs => $1) FROM seasons`,
          [durationMs / 1000],
        );
        // Carte remise à zéro : chaque ville revient à la faction de son pays, sans influence.
        await client.query(
          `UPDATE city_state s SET owner_faction_id = f.id, influence = '{}', updated_at = now()
           FROM cities c LEFT JOIN factions f ON f.slug = 'country:' || lower(c.country_code)
           WHERE c.geonames_id = s.geonames_id`,
        );
        // Les parties validées mais pas encore appliquées visaient l'ancienne saison : abandonnées.
        await client.query(
          `UPDATE attacks SET applied_at = now() WHERE status = 'submitted' AND validated AND applied_at IS NULL`,
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      // 3. État chaud : on repart de Postgres.
      if (store.isUp()) await store.resetWorld(db);
      this.cached = null;
      const next = await this.refresh();
      // 4. Prévient tous les clients : la carte qu'ils affichent n'est plus valable.
      this.publisher.season(next, true);
      return true;
    } finally {
      this.paused = false;
      if (store.isUp()) await store.redis.del('season:rollover').catch(() => undefined);
    }
  }
}
