import { createHmac, randomUUID } from 'node:crypto';
import {
  MINIGAMES,
  MINIGAME_IDS,
  evaluateAttempt,
  ratingFor,
  type AttackResult,
  type AttackStartResponse,
  type MiniGameId,
} from '@conquest/shared';
import type { Db } from '../db/pool';
import { AppError } from '../http-error';

/** Délai minimal entre deux démarrages de partie par joueur (anti-spam, avant le store Redis de la phase 5). */
export const START_COOLDOWN_MS = 3_000;
/** Plafond horaire de parties par joueur. */
export const MAX_ATTACKS_PER_HOUR = 200;

/**
 * Graine « signée » : HMAC(secret, attackId). Le client ne peut ni la choisir ni la prédire sans le secret,
 * et le serveur peut la re-dériver sans la croire : elle est liée à CETTE partie.
 */
export const deriveSeed = (secret: string, attackId: string): string =>
  createHmac('sha256', secret).update(`attack:${attackId}`).digest('hex').slice(0, 24);

export function isMiniGameId(v: string): v is MiniGameId {
  return (MINIGAME_IDS as readonly string[]).includes(v);
}

export async function startAttack(
  db: Db,
  secret: string,
  userId: string,
  input: { cityId: number; minigame: MiniGameId },
): Promise<AttackStartResponse> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Verrou sur le joueur : deux démarrages simultanés (deux onglets) sont sérialisés.
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);

    const ctx = await client.query<{
      faction_id: number | null;
      city_name: string | null;
      last_ms: number | null;
      hourly: number;
    }>(
      `SELECT m.faction_id,
              c.name AS city_name,
              (SELECT extract(epoch FROM clock_timestamp() - max(started_at)) * 1000
                 FROM attacks WHERE user_id = $1) AS last_ms,
              (SELECT count(*)::int FROM attacks
                 WHERE user_id = $1 AND started_at > now() - interval '1 hour') AS hourly
       FROM (SELECT $1::uuid AS user_id) u
       LEFT JOIN faction_members m ON m.user_id = u.user_id
       LEFT JOIN cities c ON c.geonames_id = $2`,
      [userId, input.cityId],
    );
    const row = ctx.rows[0];
    if (!row?.faction_id) throw new AppError(409, 'rejoins d’abord une faction', 'no_faction');
    if (!row.city_name) throw new AppError(404, 'ville introuvable', 'unknown_city');
    // Attaquer sa propre ville la DÉFEND (renforce son influence) : aucune restriction ici.
    if (row.last_ms !== null && row.last_ms < START_COOLDOWN_MS) {
      throw new AppError(429, 'trop rapide, patiente quelques secondes', 'cooldown');
    }
    if (row.hourly >= MAX_ATTACKS_PER_HOUR) {
      throw new AppError(429, 'limite horaire atteinte', 'hourly_limit');
    }

    // Une partie encore ouverte (page rechargée, onglet fermé) est abandonnée.
    await client.query(
      `UPDATE attacks SET status = 'abandoned' WHERE user_id = $1 AND status = 'started'`,
      [userId],
    );

    const attackId = randomUUID();
    const seed = deriveSeed(secret, attackId);
    await client.query(
      `INSERT INTO attacks (id, user_id, faction_id, city_id, minigame, seed, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'started')`,
      [attackId, userId, row.faction_id, input.cityId, input.minigame, seed],
    );
    await client.query('COMMIT');

    const game = MINIGAMES[input.minigame];
    return {
      attackId,
      minigame: input.minigame,
      seed,
      durationMs: game.durationMs,
      params: game.generate(seed),
      city: { id: input.cityId, name: row.city_name },
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

interface AttackRow {
  id: string;
  minigame: string;
  seed: string;
  status: 'started' | 'submitted' | 'abandoned';
  score: number | null;
  max_score: number | null;
  validated: boolean | null;
  stats: Record<string, number> | null;
  elapsed_ms: number;
}

const toResult = (r: AttackRow): AttackResult => ({
  attackId: r.id,
  minigame: r.minigame as MiniGameId,
  validated: r.validated ?? false,
  score: r.score ?? 0,
  maxScore: r.max_score ?? 0,
  rating: ratingFor(r.score ?? 0, r.max_score ?? 0),
  stats: r.stats ?? {},
});

/**
 * Soumet la preuve d'une partie et la score. Idempotent et sûr face aux courses :
 *  - le verrou de ligne (`FOR UPDATE`) sérialise deux soumissions simultanées ;
 *  - la seconde voit `status = 'submitted'` et reçoit le résultat déjà enregistré, sans re-scorer.
 * Un client qui n'a pas reçu la réponse peut donc réessayer sans risque.
 */
export async function submitAttack(
  db: Db,
  userId: string,
  attackId: string,
  rawInput: unknown,
): Promise<AttackResult> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<AttackRow>(
      `SELECT id, minigame, seed, status, score, max_score, validated, stats,
              extract(epoch FROM clock_timestamp() - started_at) * 1000 AS elapsed_ms
       FROM attacks WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [attackId, userId],
    );
    const row = rows[0];
    if (!row) throw new AppError(404, 'partie introuvable', 'unknown_attack');
    if (row.status === 'submitted') {
      await client.query('COMMIT');
      return toResult(row);
    }
    if (row.status === 'abandoned') {
      throw new AppError(409, 'cette partie a été abandonnée', 'abandoned');
    }
    if (!isMiniGameId(row.minigame)) throw new AppError(500, 'mini-jeu inconnu');
    const game = MINIGAMES[row.minigame];

    // Forme invalide -> 400 SANS consommer la partie (bug client : il peut renvoyer une entrée correcte).
    const input = game.parseInput(rawInput);
    const result = evaluateAttempt(game, row.seed, input, row.elapsed_ms);

    const upd = await client.query<AttackRow>(
      `UPDATE attacks
       SET status = 'submitted', submitted_at = now(), score = $2, max_score = $3,
           validated = $4, stats = $5, flags = $6, input = $7
       WHERE id = $1
       RETURNING id, minigame, seed, status, score, max_score, validated, stats, 0 AS elapsed_ms`,
      [
        attackId,
        result.score,
        result.maxScore,
        result.valid,
        JSON.stringify(result.stats),
        result.flags,
        JSON.stringify(input),
      ],
    );
    await client.query('COMMIT');
    return toResult(upd.rows[0]!);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getAttack(
  db: Db,
  userId: string,
  attackId: string,
): Promise<AttackResult & { status: AttackRow['status'] }> {
  const { rows } = await db.query<AttackRow>(
    `SELECT id, minigame, seed, status, score, max_score, validated, stats, 0 AS elapsed_ms
     FROM attacks WHERE id = $1 AND user_id = $2`,
    [attackId, userId],
  );
  const row = rows[0];
  if (!row) throw new AppError(404, 'partie introuvable', 'unknown_attack');
  return { ...toResult(row), status: row.status };
}
