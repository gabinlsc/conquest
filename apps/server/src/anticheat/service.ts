import type { Db } from '../db/pool';
import type { Metrics } from '../metrics';
import type { Redis } from '../world/redis';
import {
  SHADOW_BAN_THRESHOLD,
  stdDev,
  weightOf,
  welfordUpdate,
  zScore,
  type RunningStats,
} from './stats';

export interface AssessInput {
  attackId: string;
  userId: string;
  minigame: string;
  score: number;
  maxScore: number;
  flags: string[];
  fingerprint: string | null;
  ipHash: string | null;
}

export interface Verdict {
  /** Joueur sous « shadow ban » : ses parties sont jugées normalement mais n'ont plus d'effet sur le monde. */
  shadow: boolean;
  suspicion: number;
  reasons: string[];
}

const MIN_POPULATION = 200;
const OUTLIER_Z = 3.5;
const OUTLIER_MIN_RATIO = 0.9;
const IP_CLUSTER_ACCOUNTS = 6;

/**
 * Détection d'anomalies APRÈS validation (la validation déterministe rejette déjà les entrées impossibles).
 * Trois signaux statistiques viennent compléter les drapeaux du mini-jeu :
 *  1. score aberrant par rapport à la population (z-score > 3,5 ET ≥ 90 % du maximum) ;
 *  2. empreinte de réactions identique à une autre partie (rejeu d'un enregistrement) ;
 *  3. ferme de comptes : trop de comptes distincts depuis une même IP (empreinte HMAC) sur la dernière heure.
 * Les poids s'additionnent dans un score de suspicion qui décroît de moitié par jour ; au-delà du seuil le joueur est
 * mis en « shadow ban » (il n'est pas prévenu, ce qui l'empêche d'ajuster son bot). Annulable : `pnpm anticheat unban`.
 */
export class AntiCheatService {
  constructor(
    private readonly db: Db,
    private readonly redis: Redis | null,
    private readonly metrics?: Metrics,
  ) {}

  async assess(a: AssessInput): Promise<Verdict> {
    // Analyse unique par attaque : l'effet d'une attaque peut être rejoué (panne Redis, double envoi) sans
    // que la suspicion du joueur ne soit comptée plusieurs fois (ce qui le ferait sanctionner à tort).
    const claim = await this.db.query(
      'UPDATE attacks SET assessed = true WHERE id = $1 AND NOT assessed RETURNING id',
      [a.attackId],
    );
    if (!claim.rowCount) return this.currentState(a.userId);

    const flags = [...a.flags];
    const ratio = a.maxScore > 0 ? a.score / a.maxScore : 0;
    const clean = !flags.some((f) => f.startsWith('hard:'));

    if (clean) {
      const outlier = await this.populationCheck(a.minigame, ratio);
      if (outlier) flags.push('soft:score_outlier');
    }
    if (a.fingerprint) {
      const { rowCount } = await this.db.query(
        `SELECT 1 FROM attacks
         WHERE fingerprint = $1 AND id <> $2 AND started_at > now() - interval '7 days' LIMIT 1`,
        [a.fingerprint, a.attackId],
      );
      if (rowCount) flags.push('soft:replayed_pattern');
    }
    if (a.ipHash) {
      const { rows } = await this.db.query<{ n: number }>(
        `SELECT count(DISTINCT user_id)::int AS n FROM attacks
         WHERE ip_hash = $1 AND started_at > now() - interval '1 hour'`,
        [a.ipHash],
      );
      if ((rows[0]?.n ?? 0) > IP_CLUSTER_ACCOUNTS) flags.push('soft:ip_cluster');
    }

    const extra = flags.slice(a.flags.length);
    if (extra.length > 0) {
      await this.db.query('UPDATE attacks SET flags = flags || $2::text[] WHERE id = $1', [
        a.attackId,
        extra,
      ]);
    }

    for (const f of flags) this.metrics?.flag(f);
    const { total, reasons } = weightOf(flags);
    if (total === 0) return this.currentState(a.userId);

    // Suspicion existante décroissante (demi-vie 24 h) + poids de cette partie, en une seule instruction atomique.
    const { rows } = await this.db.query<{ suspicion: number }>(
      `INSERT INTO anticheat_state (user_id, suspicion, flag_count, last_reasons, flagged_at, updated_at)
       VALUES ($1, $2, 1, $3, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET
         suspicion = anticheat_state.suspicion * power(0.5, extract(epoch FROM now() - anticheat_state.updated_at) / 86400.0) + $2,
         flag_count = anticheat_state.flag_count + 1,
         last_reasons = $3, flagged_at = now(), updated_at = now()
       RETURNING suspicion`,
      [a.userId, total, reasons],
    );
    const suspicion = rows[0]?.suspicion ?? total;
    const ban = await this.db.query<{ shadow_banned: boolean }>(
      `UPDATE users SET shadow_banned = shadow_banned OR $2 WHERE id = $1 RETURNING shadow_banned`,
      [a.userId, suspicion >= SHADOW_BAN_THRESHOLD],
    );
    return { shadow: ban.rows[0]?.shadow_banned ?? false, suspicion, reasons };
  }

  private async currentState(userId: string): Promise<Verdict> {
    const { rows } = await this.db.query<{ shadow_banned: boolean; suspicion: number | null }>(
      `SELECT u.shadow_banned, s.suspicion FROM users u
       LEFT JOIN anticheat_state s ON s.user_id = u.id WHERE u.id = $1`,
      [userId],
    );
    return {
      shadow: rows[0]?.shadow_banned ?? false,
      suspicion: rows[0]?.suspicion ?? 0,
      reasons: [],
    };
  }

  /** Met à jour la distribution des scores et signale un score aberrant. Sans Redis : pas de test statistique. */
  private async populationCheck(minigame: string, ratio: number): Promise<boolean> {
    if (!this.redis || this.redis.status !== 'ready') return false;
    const key = `ac:stats:${minigame}`;
    try {
      const raw = await this.redis.hgetall(key);
      const before: RunningStats = {
        n: Number(raw['n'] ?? 0),
        mean: Number(raw['mean'] ?? 0),
        m2: Number(raw['m2'] ?? 0),
      };
      const outlier =
        before.n >= MIN_POPULATION &&
        ratio >= OUTLIER_MIN_RATIO &&
        zScore(before, ratio) > OUTLIER_Z;
      const after = welfordUpdate(before, ratio);
      // Un score aberrant ne vient pas fausser la distribution de référence.
      if (!outlier) await this.redis.hset(key, { n: after.n, mean: after.mean, m2: after.m2 });
      return outlier;
    } catch {
      return false;
    }
  }

  // ---------- Outils d'administration (utilisés par la CLI) ----------

  async report(limit = 20) {
    const { rows } = await this.db.query<{
      user_id: string;
      display_name: string;
      suspicion: number;
      flag_count: number;
      last_reasons: string[];
      shadow_banned: boolean;
      flagged_at: Date;
    }>(
      `SELECT s.user_id, u.display_name, s.suspicion, s.flag_count, s.last_reasons, u.shadow_banned, s.flagged_at
       FROM anticheat_state s JOIN users u ON u.id = s.user_id
       ORDER BY u.shadow_banned DESC, s.suspicion DESC LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async unban(userId: string): Promise<boolean> {
    await this.db.query(
      'UPDATE anticheat_state SET suspicion = 0, last_reasons = $2, updated_at = now() WHERE user_id = $1',
      [userId, []],
    );
    const res = await this.db.query('UPDATE users SET shadow_banned = false WHERE id = $1', [
      userId,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  static readonly stdDev = stdDev;
}
