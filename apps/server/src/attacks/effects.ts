import {
  attackPoints,
  garrisonFor,
  influenceGain,
  resolveAttack,
  tileOf,
  type AttackEffect,
  type CityDelta,
  type GameEvent,
  type SeasonInfo,
} from '@conquest/shared';
import type { Db } from '../db/pool';
import type { AntiCheatService } from '../anticheat/service';
import type { EventService } from '../events/service';
import type { LeaderboardService } from '../seasons/leaderboards';
import type { SeasonService } from '../seasons/service';
import type { CityIndex } from '../world/geo';
import type { FactionDirectory } from '../world/factions';
import type { WorldStore } from '../world/store';

/** Sortie vers les clients temps réel (implémentée par la passerelle Socket.IO). */
export interface Publisher {
  delta(tile: string, delta: CityDelta): void;
  event(event: GameEvent): void;
  season(info: SeasonInfo, reset: boolean): void;
}

const NOOP_PUBLISHER: Publisher = {
  delta: () => undefined,
  event: () => undefined,
  season: () => undefined,
};

interface AttackRow {
  id: string;
  user_id: string;
  faction_id: number | null;
  city_id: number;
  minigame: string;
  score: number | null;
  max_score: number | null;
  validated: boolean | null;
  status: string;
  applied_at: Date | null;
  effect: AttackEffect | null;
  flags: string[];
  fingerprint: string | null;
  ip_hash: string | null;
  display_name: string | null;
  country_code: string | null;
}

/**
 * Applique l'effet d'une attaque validée sur le monde (influence, capture, points) puis le diffuse.
 * Chaque étape est idempotente ; une panne à n'importe quel point est rattrapée en rejouant l'attaque :
 *  - Redis : le script Lua d'application et celui des points mémorisent le résultat par attackId ;
 *  - Postgres : `applied_at` n'est posé qu'à la fin ; l'événement est protégé par UNIQUE(attack_id).
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
      leaderboards?: LeaderboardService;
      seasons?: SeasonService;
      anticheat?: AntiCheatService;
    },
  ) {}

  /** Retourne l'effet, ou null s'il est en attente (Redis indisponible) ou sans objet (partie invalide). */
  async applyById(attackId: string): Promise<AttackEffect | null> {
    const { db, store, geo, factions, events, leaderboards, seasons, anticheat } = this.deps;
    const { rows } = await db.query<AttackRow>(
      `SELECT a.id, a.user_id, a.faction_id, a.city_id, a.minigame, a.score, a.max_score, a.validated, a.status,
              a.applied_at, a.effect, a.flags, a.fingerprint, a.ip_hash, u.display_name, u.country_code
       FROM attacks a JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
      [attackId],
    );
    const a = rows[0];
    if (!a || a.status !== 'submitted' || !a.validated) return null;
    if (a.applied_at) return a.effect; // déjà appliquée : on rejoue la réponse enregistrée
    const city = geo.get(a.city_id);
    if (!city || a.faction_id === null) return null;

    const gain = influenceGain(a.score ?? 0, a.max_score ?? 0);

    // Analyse anti-triche : un joueur « shadow banni » est jugé comme les autres mais n'agit plus sur le monde.
    const verdict = anticheat
      ? await anticheat
          .assess({
            attackId,
            userId: a.user_id,
            minigame: a.minigame,
            score: a.score ?? 0,
            maxScore: a.max_score ?? 0,
            flags: a.flags,
            fingerprint: a.fingerprint,
            ipHash: a.ip_hash,
          })
          .catch(() => null)
      : null;
    if (verdict?.shadow) return this.applyGhost(a, gain);

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

    // Points de classement (atomiques et idempotents). Un échec laisse l'attaque « en attente » : rejouée plus tard.
    let points = 0;
    let seasonId: number | null = null;
    if (leaderboards && seasons) {
      points = attackPoints(gain, res.captured, city.value);
      const season = await seasons.current();
      seasonId = season.id;
      const faction = await factions.get(a.faction_id);
      if (faction) {
        try {
          await leaderboards.award({
            attackId,
            seasonId,
            userId: a.user_id,
            countryCode: a.country_code?.trim() ?? null,
            factionId: faction.id,
            factionKind: faction.kind,
            points,
          });
        } catch {
          return null;
        }
      }
    }

    await db.query(
      `UPDATE attacks SET effect = $2, applied_at = now(), points = $3, season_id = $4
       WHERE id = $1 AND applied_at IS NULL`,
      [attackId, JSON.stringify(effect), points, seasonId],
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

  /**
   * Effet « fantôme » d'un joueur sanctionné : le résultat affiché ressemble à celui d'une partie normale
   * (calculé par la même fonction pure sur l'état courant) mais rien n'est écrit : ni influence, ni capture,
   * ni points. Le joueur n'a ainsi aucun signal pour contourner la détection.
   */
  private async applyGhost(a: AttackRow, gain: number): Promise<AttackEffect | null> {
    const { db, store, geo } = this.deps;
    const city = geo.get(a.city_id);
    if (!city || a.faction_id === null) return null;
    let live;
    try {
      live = await store.getInfluenceState(a.city_id);
    } catch {
      return null;
    }
    if (!live) return null;
    const sim = resolveAttack(live, a.faction_id, gain, Date.now(), city.value);
    const effect: AttackEffect = {
      cityId: a.city_id,
      gain,
      captured: sim.captured,
      defended: sim.defended,
      shielded: sim.shielded,
      ownerFactionId: sim.state.owner || null,
      prevOwnerFactionId: sim.prevOwner || null,
      ownerInfluence: sim.ownerInfluence,
      garrison: garrisonFor(city.value),
      influence: Object.entries(sim.state.influence).map(([f, v]) => ({
        factionId: Number(f),
        value: v,
      })),
    };
    await db.query(
      `UPDATE attacks SET effect = $2, applied_at = now(), points = 0, flags = flags || ARRAY['ghost']
       WHERE id = $1 AND applied_at IS NULL`,
      [a.id, JSON.stringify(effect)],
    );
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
