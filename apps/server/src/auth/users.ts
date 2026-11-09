import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  COUNTRY_CHANGE_COOLDOWN_DAYS,
  type MeResponse,
  type MyFaction,
  type OAuthProvider,
  type UserDto,
} from '@conquest/shared';
import type { Db } from '../db/pool';
import { AppError } from '../http-error';
import { attachCountryFaction } from '../factions/service';

type Queryable = Pick<PoolClient, 'query'>;

export const randomGuestName = () => `Joueur-${randomBytes(3).toString('hex')}`;

async function assertCountryExists(db: Queryable, code: string): Promise<void> {
  const { rowCount } = await db.query('SELECT 1 FROM countries WHERE code = $1', [code]);
  if (!rowCount) throw new AppError(400, 'pays inconnu', 'unknown_country');
}

/** Compte invité : jouable immédiatement, rattaché d'office à la faction de son pays. */
export async function createGuest(
  db: Db,
  input: { countryCode: string; displayName?: string | undefined },
): Promise<string> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertCountryExists(client, input.countryCode);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (kind, display_name, country_code) VALUES ('guest', $1, $2) RETURNING id`,
      [input.displayName ?? randomGuestName(), input.countryCode],
    );
    const id = rows[0]!.id;
    await attachCountryFaction(client, id, input.countryCode);
    await client.query('COMMIT');
    return id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface OAuthProfile {
  provider: OAuthProvider;
  providerUserId: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Nettoie un pseudo fourni par un tiers pour respecter displayNameSchema. */
export function sanitizeDisplayName(raw: string): string {
  const cleaned = raw
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, 24);
  return cleaned.length >= 2 ? cleaned : randomGuestName();
}

/**
 * Résout l'utilisateur après un login OAuth :
 *  1. compte OAuth déjà connu -> on s'y connecte ;
 *  2. sinon, si une session invité est active -> on LIE l'identité à ce compte (la progression est conservée) ;
 *  3. sinon -> nouveau compte.
 * Le cas 1 prime sur le 2 : si l'identité est déjà liée ailleurs, la progression de l'invité courant est abandonnée.
 */
export async function loginWithOAuth(
  db: Db,
  profile: OAuthProfile,
  currentGuestId: string | null,
  countryHint: string | null,
): Promise<string> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query<{ user_id: string }>(
      'SELECT user_id FROM oauth_accounts WHERE provider = $1 AND provider_user_id = $2',
      [profile.provider, profile.providerUserId],
    );
    if (existing.rows[0]) {
      await client.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [
        existing.rows[0].user_id,
      ]);
      await client.query('COMMIT');
      return existing.rows[0].user_id;
    }

    let userId: string;
    if (currentGuestId) {
      // Promotion guest -> oauth ; `kind = 'guest'` dans le WHERE évite d'écraser un vrai compte.
      const upd = await client.query<{ id: string }>(
        `UPDATE users SET kind = 'oauth', avatar_url = coalesce(avatar_url, $2)
         WHERE id = $1 AND kind = 'guest' RETURNING id`,
        [currentGuestId, profile.avatarUrl],
      );
      userId = upd.rows[0]?.id ?? (await createOAuthUser(client, profile, countryHint));
    } else {
      userId = await createOAuthUser(client, profile, countryHint);
    }
    await client.query(
      'INSERT INTO oauth_accounts (provider, provider_user_id, user_id) VALUES ($1, $2, $3)',
      [profile.provider, profile.providerUserId, userId],
    );
    await client.query('COMMIT');
    return userId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function createOAuthUser(
  client: Queryable,
  profile: OAuthProfile,
  countryHint: string | null,
): Promise<string> {
  const known = countryHint
    ? (await client.query('SELECT 1 FROM countries WHERE code = $1', [countryHint])).rowCount
    : 0;
  const country = known ? countryHint : null;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO users (kind, display_name, avatar_url, country_code)
     VALUES ('oauth', $1, $2, $3) RETURNING id`,
    [sanitizeDisplayName(profile.displayName), profile.avatarUrl, country],
  );
  const id = rows[0]!.id;
  // Sans pays connu, le joueur n'a pas encore de faction : le client lui demande son pays (PATCH /me).
  if (country) await attachCountryFaction(client, id, country);
  return id;
}

interface MeRow {
  id: string;
  kind: 'guest' | 'oauth';
  display_name: string;
  avatar_url: string | null;
  country_code: string | null;
  faction_id: number | null;
  faction_kind: 'country' | 'clan' | null;
  faction_name: string | null;
  color: string | null;
  faction_cc: string | null;
  open: boolean | null;
  invite_code: string | null;
  role: 'member' | 'owner' | null;
  member_count: number | null;
}

export async function getMe(db: Db, userId: string): Promise<Pick<MeResponse, 'user' | 'faction'>> {
  const { rows } = await db.query<MeRow>(
    `SELECT u.id, u.kind, u.display_name, u.avatar_url, u.country_code,
            f.id AS faction_id, f.kind AS faction_kind, f.name AS faction_name, f.color,
            f.country_code AS faction_cc, f.open, f.invite_code, m.role,
            (SELECT count(*)::int FROM faction_members x WHERE x.faction_id = f.id) AS member_count
     FROM users u
     LEFT JOIN faction_members m ON m.user_id = u.id
     LEFT JOIN factions f ON f.id = m.faction_id
     WHERE u.id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) return { user: null, faction: null };
  const user: UserDto = {
    id: r.id,
    kind: r.kind,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    countryCode: r.country_code?.trim() ?? null,
  };
  const faction: MyFaction | null =
    r.faction_id !== null && r.faction_kind && r.faction_name && r.color && r.role
      ? {
          id: r.faction_id,
          kind: r.faction_kind,
          name: r.faction_name,
          color: r.color,
          countryCode: r.faction_cc?.trim() ?? null,
          role: r.role,
          memberCount: r.member_count ?? 1,
          open: r.open ?? true,
          // Le code d'invitation n'est révélé qu'au chef du clan.
          inviteCode: r.role === 'owner' ? r.invite_code : null,
        }
      : null;
  return { user, faction };
}

export async function updateProfile(
  db: Db,
  userId: string,
  patch: { displayName?: string | undefined; countryCode?: string | undefined },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Verrou de ligne : sérialise les opérations concurrentes du même joueur (double-clic, deux onglets).
    const cur = await client.query<{
      country_code: string | null;
      cooling: boolean;
      faction_kind: string | null;
    }>(
      `SELECT u.country_code,
              (u.country_changed_at IS NOT NULL
               AND u.country_changed_at > now() - make_interval(days => $2)) AS cooling,
              f.kind AS faction_kind
       FROM users u
       LEFT JOIN faction_members m ON m.user_id = u.id
       LEFT JOIN factions f ON f.id = m.faction_id
       WHERE u.id = $1 FOR UPDATE OF u`,
      [userId, COUNTRY_CHANGE_COOLDOWN_DAYS],
    );
    const row = cur.rows[0];
    if (!row) throw new AppError(404, 'utilisateur introuvable');

    if (patch.displayName !== undefined) {
      await client.query('UPDATE users SET display_name = $2 WHERE id = $1', [
        userId,
        patch.displayName,
      ]);
    }
    if (patch.countryCode !== undefined && patch.countryCode !== row.country_code?.trim()) {
      await assertCountryExists(client, patch.countryCode);
      // Anti-abus (changer de camp pour suivre le rapport de force) : cooldown, sauf premier choix.
      if (row.country_code && row.cooling) {
        throw new AppError(
          429,
          `changement de pays possible une fois tous les ${COUNTRY_CHANGE_COOLDOWN_DAYS} jours`,
          'country_cooldown',
        );
      }
      await client.query(
        'UPDATE users SET country_code = $2, country_changed_at = now() WHERE id = $1',
        [userId, patch.countryCode],
      );
      // Un joueur en clan y reste ; sinon il suit sa nouvelle nationalité.
      if (row.faction_kind !== 'clan') {
        await attachCountryFaction(client, userId, patch.countryCode);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
