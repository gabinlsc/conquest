import {
  garrisonFor,
  influenceGain,
  tileOf,
  type AttackEffect,
  type CityDelta,
  type GameEvent,
} from '@conquest/shared';
import type { Db } from '../db/pool';
import type { EventService } from '../events/service';
import type { CityIndex } from '../world/geo';
import type { FactionDirectory } from '../world/factions';
import type { WorldStore } from '../world/store';

/** Sortie vers les clients temps réel (implémentée par la passerelle Socket.IO). */
export interface Publisher {
  delta(tile: string, delta: CityDelta): void;
  event(event: GameEvent): void;
}

const NOOP_PUBLISHER: Publisher = { delta: () => undefined, event: () => undefined };

interface AttackRow {
  id: string;
  user_id: string;
  faction_id: number | null;
  city_id: number;
  score: number | null;
  max_score: number | null;
  validated: boolean | null;
  status: string;
  applied_at: Date | null;
  effect: AttackEffect | null;
  display_name: string | null;
}

/**
 * Applique l'effet d'une attaque validée sur le monde (influence, capture) puis le diffuse.
 * Chaque étape est idempotente ; une panne à n'importe quel point est rattrapée en rejouant l'attaque :
 *  - Redis : le script Lua mémorise le résultat par attackId ;
 *  - Postgres : `applied_at` n'est posé qu'une fois ; l'événement est protégé par UNIQUE(attack_id).
 */
export class EffectService {
  publisher: Publisher = NOOP_PUBLISHER;

  constructor(
    private readonly deps: {
      db: Db;
      store: WorldStore;
      geo: CityIndex;
      factions: FactionDirectory;
      events: EventService;
    },
  ) {}

  /** Retourne l'effet, ou null s'il est en attente (Redis indisponible) ou sans objet (partie invalide). */
  async applyById(attackId: string): Promise<AttackEffect | null> {
    const { db, store, geo, factions, events } = this.deps;
    const { rows } = await db.query<AttackRow>(
      `SELECT a.id, a.user_id, a.faction_id, a.city_id, a.score, a.max_score, a.validated, a.status,
              a.applied_at, a.effect, u.display_name
       FROM attacks a JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
      [attackId],
    );
    const a = rows[0];
    if (!a || a.status !== 'submitted' || !a.validated) return null;
    if (a.applied_at) return a.effect; // déjà appliquée : on rejoue la réponse enregistrée
    const city = geo.get(a.city_id);
    if (!city || a.faction_id === null) return null;

    const gain = influenceGain(a.score ?? 0, a.max_score ?? 0);
    let res;
    try {
      res = await store.applyAttack({ attackId, cityId: a.city_id, factionId: a.faction_id, gain });
    } catch {
      return null; // Redis indisponible : l'attaque reste « en attente », le réconciliateur la rejouera
    }

    const effect: AttackEffect = {
      cityId: a.city_id,
      gain,
      captured: res.captured,
      defended: res.defended,
      shielded: res.shielded,
      ownerFactionId: res.owner || null,
      prevOwnerFactionId: res.prevOwner || null,
      ownerInfluence: res.ownerInfluence,
      garrison: garrisonFor(city.value),
      influence: res.influence.map(([factionId, value]) => ({ factionId, value })),
    };
    await db.query(
      'UPDATE attacks SET effect = $2, applied_at = now() WHERE id = $1 AND applied_at IS NULL',
      [attackId, JSON.stringify(effect)],
    );

    const faction = await factions.get(res.owner);
    if (res.captured && faction) {
      const from = await factions.get(res.prevOwner);
      const recorded = await events.recordCapture(attackId, a.user_id, {
        type: 'capture',
        at: Date.now(),
        cityId: city.id,
        cityName: city.name,
        countryCode: city.countryCode,
        lon: city.lon,
        lat: city.lat,
        by: a.display_name,
        faction,
        from,
      });
      // Seul un événement NOUVEAU est diffusé : rejouer une attaque ne re-notifie personne.
      if (recorded) this.publisher.event(recorded);
    }
    if (!res.replay) {
      this.publisher.delta(tileOf(city.lon, city.lat), {
        id: city.id,
        owner: res.owner,
        ver: res.ver,
        inf: res.influence,
        faction,
        at: Date.now(),
      });
    }
    return effect;
  }

  /** Rejoue les attaques validées restées « en attente » (Redis était indisponible). */
  async reconcile(limit = 50): Promise<number> {
    if (!this.deps.store.isUp()) return 0;
    const { rows } = await this.deps.db.query<{ id: string }>(
      `SELECT id FROM attacks
       WHERE status = 'submitted' AND validated AND applied_at IS NULL
         AND submitted_at < now() - interval '3 seconds'
       ORDER BY submitted_at LIMIT $1`,
      [limit],
    );
    let applied = 0;
    for (const r of rows) {
      if (await this.applyById(r.id)) applied++;
    }
    return applied;
  }

  /** Un clan dissous rend ses villes à leur pays : met à jour Redis et prévient les cartes concernées. */
  async onFactionDisbanded(factionId: number): Promise<void> {
    const { store, geo, factions } = this.deps;
    const changed = await store.reassignFaction(factionId, (cityId) => {
      const c = geo.get(cityId);
      return c ? factions.countryFactionId(c.countryCode) : 0;
    });
    factions.forget(factionId);
    for (const { cityId, owner, ver } of changed) {
      const c = geo.get(cityId);
      if (!c) continue;
      this.publisher.delta(tileOf(c.lon, c.lat), {
        id: cityId,
        owner,
        ver,
        inf: [],
        faction: await factions.get(owner),
        at: Date.now(),
      });
    }
  }
}
