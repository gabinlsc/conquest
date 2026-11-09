import type { GameEvent } from '@conquest/shared';
import type { Db } from '../db/pool';

export class EventService {
  constructor(private readonly db: Db) {}

  /**
   * Enregistre un événement de capture. Retourne l'événement s'il est NOUVEAU, null s'il existait déjà
   * (attaque rejouée) : l'appelant ne diffuse que les nouveaux événements.
   */
  async recordCapture(
    attackId: string,
    userId: string,
    event: Omit<GameEvent, 'id'>,
  ): Promise<GameEvent | null> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO events (type, attack_id, city_id, faction_id, from_faction_id, user_id, payload)
       VALUES ('capture', $1, $2, $3, $4, $5, $6)
       ON CONFLICT (attack_id) DO NOTHING
       RETURNING id`,
      [
        attackId,
        event.cityId,
        event.faction.id,
        event.from?.id ?? null,
        userId,
        JSON.stringify(event),
      ],
    );
    const row = rows[0];
    return row ? { ...event, id: Number(row.id) } : null;
  }

  /** Derniers événements (du plus récent au plus ancien). */
  async recent(limit = 20, beforeId?: number): Promise<GameEvent[]> {
    const { rows } = await this.db.query<{ id: string; payload: Omit<GameEvent, 'id'> }>(
      `SELECT id, payload FROM events
       WHERE type = 'capture' AND ($2::bigint IS NULL OR id < $2)
       ORDER BY id DESC LIMIT $1`,
      [limit, beforeId ?? null],
    );
    return rows.map((r) => ({ ...r.payload, id: Number(r.id) }));
  }
}
