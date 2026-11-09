import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { MAX_CLAN_MEMBERS, colorForKey, type ClanDetail, type ClanSummary } from '@conquest/shared';
import type { Db } from '../db/pool';
import { AppError } from '../http-error';

type Queryable = Pick<PoolClient, 'query'>;

/**
 * Rattache un joueur à la faction de son pays (upsert : un joueur n'a qu'une ligne dans faction_members).
 * Retourne false si le pays n'a pas de faction (code inconnu).
 */
export async function attachCountryFaction(
  db: Queryable,
  userId: string,
  countryCode: string,
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO faction_members (user_id, faction_id, role)
     SELECT $1, id, 'member' FROM factions WHERE slug = 'country:' || lower($2)
     ON CONFLICT (user_id) DO UPDATE
       SET faction_id = EXCLUDED.faction_id, role = 'member', joined_at = now()`,
    [userId, countryCode],
  );
  return (res.rowCount ?? 0) > 0;
}

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O/1/I : lisible à l'oral
const newInviteCode = () =>
  Array.from(randomBytes(8), (b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join('');

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';

interface Membership {
  faction_id: number | null;
  faction_kind: 'country' | 'clan' | null;
  role: 'member' | 'owner' | null;
  country_code: string | null;
}

/** Verrouille la ligne user (sérialise les actions concurrentes du joueur) et lit son appartenance. */
async function lockMembership(client: PoolClient, userId: string): Promise<Membership> {
  const { rows } = await client.query<Membership>(
    `SELECT m.faction_id, f.kind AS faction_kind, m.role, u.country_code
     FROM users u
     LEFT JOIN faction_members m ON m.user_id = u.id
     LEFT JOIN factions f ON f.id = m.faction_id
     WHERE u.id = $1 FOR UPDATE OF u`,
    [userId],
  );
  const row = rows[0];
  if (!row) throw new AppError(404, 'utilisateur introuvable');
  return row;
}

async function inTx<T>(db: Db, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createClan(
  db: Db,
  userId: string,
  input: { name: string; color?: string | undefined; open: boolean },
): Promise<number> {
  return inTx(db, async (client) => {
    const me = await lockMembership(client, userId);
    if (me.faction_kind === 'clan') {
      throw new AppError(409, 'quittez votre clan actuel avant d’en créer un', 'already_in_clan');
    }
    const slug = slugify(input.name) || randomBytes(4).toString('hex');
    try {
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO factions (kind, slug, name, color, open, invite_code)
         VALUES ('clan', $1, $2, $3, $4, $5) RETURNING id`,
        [`clan:${slug}`, input.name, input.color ?? colorForKey(slug), input.open, newInviteCode()],
      );
      const id = rows[0]!.id;
      await client.query(
        `INSERT INTO faction_members (user_id, faction_id, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (user_id) DO UPDATE SET faction_id = EXCLUDED.faction_id, role = 'owner', joined_at = now()`,
        [userId, id],
      );
      return id;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, 'ce nom de clan est déjà pris', 'name_taken');
      }
      throw err;
    }
  });
}

export async function joinClan(
  db: Db,
  userId: string,
  clanId: number,
  inviteCode?: string,
): Promise<void> {
  await inTx(db, async (client) => {
    const me = await lockMembership(client, userId);
    if (me.faction_kind === 'clan') {
      throw new AppError(
        409,
        'quittez votre clan actuel avant d’en rejoindre un',
        'already_in_clan',
      );
    }
    // Verrou sur le clan : sérialise les inscriptions concurrentes (contrôle de capacité) et la dissolution.
    const { rows } = await client.query<{ open: boolean; invite_code: string | null }>(
      `SELECT open, invite_code FROM factions WHERE id = $1 AND kind = 'clan' FOR UPDATE`,
      [clanId],
    );
    const clan = rows[0];
    if (!clan) throw new AppError(404, 'clan introuvable');
    if (!clan.open && (!inviteCode || inviteCode.toUpperCase() !== clan.invite_code)) {
      throw new AppError(403, 'code d’invitation requis ou invalide', 'invite_required');
    }
    const count = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM faction_members WHERE faction_id = $1',
      [clanId],
    );
    if ((count.rows[0]?.n ?? 0) >= MAX_CLAN_MEMBERS) {
      throw new AppError(409, 'ce clan est complet', 'clan_full');
    }
    await client.query(
      `INSERT INTO faction_members (user_id, faction_id, role) VALUES ($1, $2, 'member')
       ON CONFLICT (user_id) DO UPDATE SET faction_id = EXCLUDED.faction_id, role = 'member', joined_at = now()`,
      [userId, clanId],
    );
  });
}

/**
 * Quitte le clan et retourne dans la faction de son pays.
 * Si le chef part : le plus ancien membre hérite du titre ; s'il était seul, le clan est dissous
 * et ses villes reviennent à la faction de leur pays (sinon la FK city_state -> factions bloquerait,
 * et surtout des villes resteraient détenues par un clan fantôme).
 * NB phase 4 : la dissolution devra aussi mettre à jour l'état chaud Redis.
 */
export async function leaveClan(
  db: Db,
  userId: string,
): Promise<{ disbanded: boolean; clanId: number }> {
  return inTx(db, async (client) => {
    const me = await lockMembership(client, userId);
    if (me.faction_kind !== 'clan' || me.faction_id === null) {
      throw new AppError(409, 'vous n’êtes dans aucun clan', 'not_in_clan');
    }
    const clanId = me.faction_id;
    await client.query('SELECT 1 FROM factions WHERE id = $1 FOR UPDATE', [clanId]);

    let disbanded = false;
    if (me.role === 'owner') {
      const next = await client.query<{ user_id: string }>(
        `SELECT user_id FROM faction_members WHERE faction_id = $1 AND user_id <> $2
         ORDER BY joined_at, user_id LIMIT 1`,
        [clanId, userId],
      );
      if (next.rows[0]) {
        await client.query(`UPDATE faction_members SET role = 'owner' WHERE user_id = $1`, [
          next.rows[0].user_id,
        ]);
      } else {
        disbanded = true;
        await client.query(
          `UPDATE city_state s SET owner_faction_id = cf.id, updated_at = now()
           FROM cities c JOIN factions cf ON cf.slug = 'country:' || lower(c.country_code)
           WHERE c.geonames_id = s.geonames_id AND s.owner_faction_id = $1`,
          [clanId],
        );
        // Villes dont le pays n'a pas de faction : neutres.
        await client.query(
          'UPDATE city_state SET owner_faction_id = NULL, updated_at = now() WHERE owner_faction_id = $1',
          [clanId],
        );
      }
    }

    await client.query('DELETE FROM faction_members WHERE user_id = $1', [userId]);
    if (disbanded) await client.query('DELETE FROM factions WHERE id = $1', [clanId]);
    if (me.country_code) await attachCountryFaction(client, userId, me.country_code.trim());
    return { disbanded, clanId };
  });
}

const CLAN_SELECT = `
  SELECT f.id, f.name, f.color, f.open,
         (SELECT count(*)::int FROM faction_members m WHERE m.faction_id = f.id) AS member_count,
         (SELECT count(*)::int FROM city_state s WHERE s.owner_faction_id = f.id) AS city_count
  FROM factions f WHERE f.kind = 'clan'`;

interface ClanRow {
  id: number;
  name: string;
  color: string;
  open: boolean;
  member_count: number;
  city_count: number;
}

const toSummary = (r: ClanRow): ClanSummary => ({
  id: r.id,
  name: r.name,
  color: r.color,
  open: r.open,
  memberCount: r.member_count,
  cityCount: r.city_count,
});

export async function listClans(
  db: Db,
  q: { q?: string | undefined; limit: number; offset: number },
): Promise<{ items: ClanSummary[]; total: number }> {
  const params: unknown[] = [];
  let filter = '';
  if (q.q) {
    params.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`);
    filter = `AND f.name ILIKE $${params.length}`;
  }
  params.push(q.limit, q.offset);
  const { rows } = await db.query<ClanRow & { total: string }>(
    `SELECT *, count(*) OVER () AS total FROM (${CLAN_SELECT} ${filter}) c
     ORDER BY city_count DESC, member_count DESC, id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows.map(toSummary), total: Number(rows[0]?.total ?? 0) };
}

export async function getClan(db: Db, id: number): Promise<ClanDetail | null> {
  const { rows } = await db.query<ClanRow>(`${CLAN_SELECT} AND f.id = $1`, [id]);
  const row = rows[0];
  if (!row) return null;
  const members = await db.query<{ display_name: string; role: 'member' | 'owner' }>(
    `SELECT u.display_name, m.role FROM faction_members m JOIN users u ON u.id = m.user_id
     WHERE m.faction_id = $1 ORDER BY (m.role = 'owner') DESC, m.joined_at LIMIT 50`,
    [id],
  );
  return {
    ...toSummary(row),
    members: members.rows.map((m) => ({ displayName: m.display_name, role: m.role })),
  };
}
