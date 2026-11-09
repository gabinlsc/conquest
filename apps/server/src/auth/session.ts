import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/pool';

export const SESSION_COOKIE = 'conquest_sid';
export const SESSION_TTL_DAYS = 30;
const RENEW_WHEN_BELOW_DAYS = 15;

/** Seul le hash est stocké en base : le jeton clair (256 bits d'entropie) ne vit que dans le cookie. */
export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

export async function createSession(
  db: Db,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const { rows } = await db.query<{ expires_at: Date }>(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))
     RETURNING expires_at`,
    [hashToken(token), userId, SESSION_TTL_DAYS],
  );
  return { token, expiresAt: rows[0]!.expires_at };
}

export interface ResolvedSession {
  userId: string;
  /** Défini si l'expiration a été repoussée (le cookie doit être ré-émis). */
  renewedUntil: Date | null;
}

/** Valide un jeton ; expiration glissante : repoussée seulement quand il reste < 15 jours (évite une écriture par requête). */
export async function resolveSession(db: Db, token: string): Promise<ResolvedSession | null> {
  const hash = hashToken(token);
  const { rows } = await db.query<{ user_id: string; expires_at: Date }>(
    'SELECT user_id, expires_at FROM sessions WHERE token_hash = $1 AND expires_at > now()',
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  let renewedUntil: Date | null = null;
  if (row.expires_at.getTime() - Date.now() < RENEW_WHEN_BELOW_DAYS * 86_400_000) {
    const upd = await db.query<{ expires_at: Date }>(
      `UPDATE sessions SET expires_at = now() + make_interval(days => $2)
       WHERE token_hash = $1 RETURNING expires_at`,
      [hash, SESSION_TTL_DAYS],
    );
    renewedUntil = upd.rows[0]?.expires_at ?? null;
  }
  return { userId: row.user_id, renewedUntil };
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function purgeExpiredSessions(db: Db): Promise<number> {
  const res = await db.query('DELETE FROM sessions WHERE expires_at <= now()');
  return res.rowCount ?? 0;
}
