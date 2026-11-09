import type { LeaderboardEntry } from '@conquest/shared';
import type { Db } from '../db/pool';
import type { FactionDirectory } from '../world/factions';
import type { Redis } from '../world/redis';

/**
 * Classements = ZSETS Redis par saison (règle d'architecture n°3 : leaderboards via sorted sets).
 *   lb:{s}:pl        tous les joueurs            lb:{s}:pl:{CC}   joueurs d'un pays
 *   lb:{s}:fc        factions-nations            lb:{s}:fk        clans
 * Chaque modification marque l'entité dans `lb:dirty` ; une tâche de fond la persiste dans `season_scores`.
 */
export const LB = {
  players: (s: number) => `lb:${s}:pl`,
  playersCountry: (s: number, cc: string) => `lb:${s}:pl:${cc}`,
  nations: (s: number) => `lb:${s}:fc`,
  clans: (s: number) => `lb:${s}:fk`,
  ready: (s: number) => `lb:${s}:ready`,
  awarded: (attackId: string) => `lb:awarded:${attackId}`,
  tick: (bucket: number) => `lb:tick:${bucket}`,
  dirty: 'lb:dirty',
};

/**
 * Attribution des points d'UNE attaque, atomique et idempotente (comme l'application de la capture) :
 * la clé `awarded` n'existe que si l'attaque a déjà été comptée, donc un rejeu ne double jamais les points.
 * KEYS: awarded, joueurs, joueurs-pays, faction (nations ou clans), dirty
 * ARGV: points, userId, factionId, countryCode, seasonId, kindCode ('n'|'k')
 */
const AWARD_LUA = `
if redis.call('SET', KEYS[1], '1', 'NX', 'EX', 604800) == false then return 0 end
local pts = tonumber(ARGV[1])
redis.call('ZINCRBY', KEYS[2], pts, ARGV[2])
if ARGV[4] ~= '' then redis.call('ZINCRBY', KEYS[3], pts, ARGV[2]) end
redis.call('ZINCRBY', KEYS[4], pts, ARGV[3])
redis.call('SADD', KEYS[5], ARGV[5] .. '|p|' .. ARGV[2] .. '|' .. ARGV[4])
redis.call('SADD', KEYS[5], ARGV[5] .. '|f|' .. ARGV[3] .. '|' .. ARGV[6])
return 1
`;

type AwardCommand = (...args: (string | number)[]) => Promise<number>;

export interface AwardInput {
  attackId: string;
  seasonId: number;
  userId: string;
  countryCode: string | null;
  factionId: number;
  factionKind: 'country' | 'clan';
  points: number;
}

export class LeaderboardService {
  constructor(
    private readonly redis: Redis,
    readonly db: Db,
    private readonly factions: FactionDirectory,
  ) {
    (redis as unknown as { defineCommand: (n: string, o: object) => void }).defineCommand(
      'conquestAward',
      { numberOfKeys: 5, lua: AWARD_LUA },
    );
  }

  isUp(): boolean {
    return this.redis.status === 'ready';
  }

  /** Vrai si les points ont été ajoutés, faux s'ils l'avaient déjà été (rejeu). */
  async award(a: AwardInput): Promise<boolean> {
    const cmd = (this.redis as unknown as { conquestAward: AwardCommand }).conquestAward.bind(
      this.redis,
    );
    const cc = a.countryCode ?? '';
    const res = await cmd(
      LB.awarded(a.attackId),
      LB.players(a.seasonId),
      LB.playersCountry(a.seasonId, cc || '--'),
      a.factionKind === 'clan' ? LB.clans(a.seasonId) : LB.nations(a.seasonId),
      LB.dirty,
      a.points,
      a.userId,
      a.factionId,
      cc,
      a.seasonId,
      a.factionKind === 'clan' ? 'k' : 'n',
    );
    return res === 1;
  }

  /** Verse à chaque faction ses points de territoire (valeur des villes tenues) pour la tranche écoulée. */
  async addTerritoryIncome(
    seasonId: number,
    perFaction: Map<number, number>,
    bucket: number,
  ): Promise<boolean> {
    // Verrou par tranche : un seul process verse le revenu, même s'il y en a plusieurs.
    if ((await this.redis.set(LB.tick(bucket), '1', 'EX', 3_600, 'NX')) !== 'OK') return false;
    const pipe = this.redis.pipeline();
    for (const [factionId, points] of perFaction) {
      const f = await this.factions.get(factionId);
      if (!f || points <= 0) continue;
      pipe.zincrby(
        f.kind === 'clan' ? LB.clans(seasonId) : LB.nations(seasonId),
        points,
        factionId,
      );
      pipe.sadd(LB.dirty, `${seasonId}|f|${factionId}|${f.kind === 'clan' ? 'k' : 'n'}`);
    }
    await pipe.exec();
    return true;
  }

  // ---------- Lecture ----------

  async top(
    seasonId: number,
    board: 'players' | 'nations' | 'clans',
    opts: { country?: string | undefined; limit: number; offset: number },
  ): Promise<{ entries: LeaderboardEntry[]; total: number }> {
    if (this.isUp() && (await this.ensureSeasonLoaded(seasonId).catch(() => false))) {
      try {
        return await this.topFromRedis(seasonId, board, opts);
      } catch {
        // Redis tombé en cours de lecture : repli sur la copie Postgres
      }
    }
    return this.topFromPg(seasonId, board, opts);
  }

  private key(seasonId: number, board: 'players' | 'nations' | 'clans', country?: string): string {
    if (board === 'players')
      return country ? LB.playersCountry(seasonId, country) : LB.players(seasonId);
    return board === 'nations' ? LB.nations(seasonId) : LB.clans(seasonId);
  }

  private async topFromRedis(
    seasonId: number,
    board: 'players' | 'nations' | 'clans',
    opts: { country?: string | undefined; limit: number; offset: number },
  ): Promise<{ entries: LeaderboardEntry[]; total: number }> {
    const key = this.key(seasonId, board, opts.country);
    const [raw, total] = await Promise.all([
      this.redis.zrevrange(key, opts.offset, opts.offset + opts.limit - 1, 'WITHSCORES'),
      this.redis.zcard(key),
    ]);
    const rows: { id: string; points: number }[] = [];
    for (let i = 0; i < raw.length; i += 2)
      rows.push({ id: raw[i]!, points: Math.round(Number(raw[i + 1])) });
    return { entries: await this.decorate(board, rows, opts.offset), total };
  }

  private async topFromPg(
    seasonId: number,
    board: 'players' | 'nations' | 'clans',
    opts: { country?: string | undefined; limit: number; offset: number },
  ): Promise<{ entries: LeaderboardEntry[]; total: number }> {
    const kind = board === 'players' ? 'player' : 'faction';
    const params: unknown[] = [seasonId, kind];
    let where = 'season_id = $1 AND kind = $2';
    if (board === 'players' && opts.country) {
      params.push(opts.country);
      where += ` AND country_code = $${params.length}`;
    }
    if (board !== 'players') {
      params.push(board === 'clans' ? 'clan' : 'country');
      where += ` AND entity_id IN (SELECT id::text FROM factions WHERE kind = $${params.length})`;
    }
    params.push(opts.limit, opts.offset);
    const { rows } = await this.db.query<{ entity_id: string; points: string; total: string }>(
      `SELECT entity_id, points, count(*) OVER () AS total FROM season_scores
       WHERE ${where} ORDER BY points DESC, entity_id LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      entries: await this.decorate(
        board,
        rows.map((r) => ({ id: r.entity_id, points: Number(r.points) })),
        opts.offset,
      ),
      total: Number(rows[0]?.total ?? 0),
    };
  }

  /** Ajoute noms, pays et couleurs aux lignes brutes (id, points). */
  private async decorate(
    board: 'players' | 'nations' | 'clans',
    rows: { id: string; points: number }[],
    offset: number,
  ): Promise<LeaderboardEntry[]> {
    if (rows.length === 0) return [];
    if (board === 'players') {
      const { rows: users } = await this.db.query<{
        id: string;
        display_name: string;
        country_code: string | null;
        color: string | null;
      }>(
        `SELECT u.id, u.display_name, u.country_code, f.color
         FROM users u
         LEFT JOIN faction_members m ON m.user_id = u.id
         LEFT JOIN factions f ON f.id = m.faction_id
         WHERE u.id = ANY($1::uuid[])`,
        [rows.map((r) => r.id)],
      );
      const byId = new Map(users.map((u) => [u.id, u]));
      return rows.map((r, i) => {
        const u = byId.get(r.id);
        return {
          rank: offset + i + 1,
          id: r.id,
          name: u?.display_name ?? 'Joueur supprimé',
          points: r.points,
          countryCode: u?.country_code?.trim() ?? null,
          color: u?.color ?? null,
        };
      });
    }
    return Promise.all(
      rows.map(async (r, i) => {
        const f = await this.factions.get(Number(r.id));
        return {
          rank: offset + i + 1,
          id: r.id,
          name: f?.name ?? 'Faction dissoute',
          points: r.points,
          countryCode: f?.countryCode ?? null,
          color: f?.color ?? null,
        };
      }),
    );
  }

  async rankOf(
    seasonId: number,
    board: 'players' | 'nations' | 'clans',
    id: string,
    country?: string,
  ): Promise<{ rank: number; points: number } | null> {
    if (!this.isUp()) return null;
    try {
      await this.ensureSeasonLoaded(seasonId);
      const key = this.key(seasonId, board, country);
      const [rank, score] = await Promise.all([
        this.redis.zrevrank(key, id),
        this.redis.zscore(key, id),
      ]);
      return rank === null || score === null
        ? null
        : { rank: rank + 1, points: Math.round(Number(score)) };
    } catch {
      return null;
    }
  }

  // ---------- Persistance (Redis -> Postgres) et reconstruction ----------

  /** Charge les classements d'une saison depuis Postgres si Redis ne les a pas (premier démarrage, Redis vidé). */
  async ensureSeasonLoaded(seasonId: number): Promise<boolean> {
    if (await this.redis.exists(LB.ready(seasonId))) return true;
    const { rows } = await this.db.query<{
      kind: string;
      entity_id: string;
      points: string;
      country_code: string | null;
      fkind: 'country' | 'clan' | null;
    }>(
      `SELECT s.kind, s.entity_id, s.points, s.country_code, f.kind AS fkind
       FROM season_scores s
       LEFT JOIN factions f ON s.kind = 'faction' AND f.id::text = s.entity_id
       WHERE s.season_id = $1`,
      [seasonId],
    );
    const pipe = this.redis.pipeline();
    for (const r of rows) {
      const pts = Number(r.points);
      if (r.kind === 'player') {
        pipe.zadd(LB.players(seasonId), pts, r.entity_id);
        if (r.country_code)
          pipe.zadd(LB.playersCountry(seasonId, r.country_code.trim()), pts, r.entity_id);
      } else if (r.fkind) {
        pipe.zadd(r.fkind === 'clan' ? LB.clans(seasonId) : LB.nations(seasonId), pts, r.entity_id);
      }
    }
    pipe.set(LB.ready(seasonId), '1');
    await pipe.exec();
    return true;
  }

  /** Persiste les entités modifiées. Retourne le nombre de lignes écrites (0 = rien en attente). */
  async flush(max = 500): Promise<number> {
    const members = await this.redis.spop(LB.dirty, max);
    if (members.length === 0) return 0;
    try {
      const seasons: number[] = [];
      const kinds: string[] = [];
      const ids: string[] = [];
      const points: number[] = [];
      const countries: (string | null)[] = [];
      const pipe = this.redis.pipeline();
      const meta: { s: number; kind: 'player' | 'faction'; id: string; cc: string | null }[] = [];
      for (const m of members) {
        const [s, type, id, extra] = m.split('|') as [string, string, string, string];
        const seasonId = Number(s);
        if (type === 'p') {
          pipe.zscore(LB.players(seasonId), id);
          meta.push({ s: seasonId, kind: 'player', id, cc: extra || null });
        } else {
          pipe.zscore(extra === 'k' ? LB.clans(seasonId) : LB.nations(seasonId), id);
          meta.push({ s: seasonId, kind: 'faction', id, cc: null });
        }
      }
      const res = (await pipe.exec()) ?? [];
      meta.forEach((m, i) => {
        const score = res[i]?.[1];
        if (score === null || score === undefined) return;
        seasons.push(m.s);
        kinds.push(m.kind);
        ids.push(m.id);
        points.push(Math.round(Number(score)));
        countries.push(m.cc);
      });
      if (ids.length > 0) {
        await this.db.query(
          `INSERT INTO season_scores (season_id, kind, entity_id, points, country_code, updated_at)
           SELECT s, k, e, p, c, now() FROM unnest($1::int[], $2::text[], $3::text[], $4::bigint[], $5::text[]) AS t(s, k, e, p, c)
           ON CONFLICT (season_id, kind, entity_id)
           DO UPDATE SET points = EXCLUDED.points, updated_at = now(),
                         country_code = coalesce(EXCLUDED.country_code, season_scores.country_code)`,
          [seasons, kinds, ids, points, countries],
        );
      }
      return members.length;
    } catch (err) {
      await this.redis.sadd(LB.dirty, ...members).catch(() => undefined);
      throw err;
    }
  }
}
