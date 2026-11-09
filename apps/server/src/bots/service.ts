import { randomUUID } from 'node:crypto';

import type { Db } from '../db/pool';
import type { EffectService } from '../attacks/effects';
import type { Metrics } from '../metrics';
import type { SeasonService } from '../seasons/service';
import type { FactionDirectory } from '../world/factions';
import type { CityIndex } from '../world/geo';
import { K, type WorldStore } from '../world/store';

export interface BotConfig {
  count: number;
  intervalMs: number;
  /** Les bots se taisent quand au moins autant de connectés sont là (les vrais joueurs suffisent). */
  maxOnline: number;
}

interface Bot {
  userId: string;
  countryCode: string;
  factionId: number;
}

const NAMES = [
  'Aiko',
  'Bruno',
  'Chloé',
  'Dario',
  'Elif',
  'Farid',
  'Greta',
  'Hugo',
  'Ines',
  'Jonas',
  'Kenji',
  'Lea',
  'Mateo',
  'Nora',
  'Omar',
  'Pia',
  'Quentin',
  'Rosa',
  'Sven',
  'Tara',
  'Uma',
  'Viktor',
  'Wen',
  'Xavi',
  'Yara',
  'Zoe',
];

const BOT_MAX_SCORE = 4_000;

/**
 * Bots d'animation : de vrais comptes (`is_bot`) qui lancent des attaques « virtuelles » pour que la carte ne
 * soit pas vide au démarrage. Leurs attaques passent par le MÊME chemin que celles des joueurs
 * (script Lua atomique, événements, deltas, alertes), mais :
 *  - ils ne jouent pas de mini-jeu : le score est tiré au hasard autour d'un joueur moyen ;
 *  - ils n'ont aucun point de classement ni analyse anti-triche : ils n'écrasent jamais les vrais joueurs ;
 *  - ils se mettent en pause dès qu'assez de vrais joueurs sont connectés, ou pendant un changement de saison.
 * Comportement : « guerres de frontière » (attaque d'une ville étrangère proche d'une ville du pays du bot)
 * et un peu de défense du territoire national.
 */
export class BotService {
  private bots: Bot[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(
    private readonly deps: {
      db: Db;
      store: WorldStore;
      geo: CityIndex;
      factions: FactionDirectory;
      effects: EffectService;
      seasons: SeasonService;
      online: () => number;
      config: BotConfig;
      metrics?: Metrics;
      /** Injectable pour des tests déterministes. */
      random?: () => number;
    },
  ) {}

  private get rnd(): number {
    return (this.deps.random ?? Math.random)();
  }

  /** Crée les comptes manquants (idempotent) et charge la liste des bots. */
  async init(): Promise<number> {
    const { db, geo, factions, config } = this.deps;
    const { rows: existing } = await db.query<{ id: string; country_code: string }>(
      'SELECT id, country_code FROM users WHERE is_bot ORDER BY created_at LIMIT $1',
      [config.count],
    );
    const bots: Bot[] = existing.map((r) => ({
      userId: r.id,
      countryCode: r.country_code.trim(),
      factionId: factions.countryFactionId(r.country_code.trim()),
    }));
    // Les bots se répartissent sur les pays les plus riches en villes (là où la carte est dense).
    const countries = geo.countriesByCityCount().slice(0, 30);
    for (let i = bots.length; i < config.count && countries.length > 0; i++) {
      const cc = countries[i % countries.length]!;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO users (kind, display_name, country_code, is_bot)
         VALUES ('bot', $1, $2, true) RETURNING id`,
        [`🤖 ${NAMES[i % NAMES.length]}`, cc],
      );
      bots.push({ userId: rows[0]!.id, countryCode: cc, factionId: factions.countryFactionId(cc) });
    }
    this.bots = bots.filter((b) => b.factionId !== 0);
    return this.bots.length;
  }

  start(): void {
    if (!this.stopped || this.bots.length === 0) return;
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.tick()
        .catch(() => undefined)
        .finally(() => {
          if (this.stopped) return;
          // Cadence irrégulière (0,5x à 1,5x) : l'activité paraît naturelle.
          this.timer = setTimeout(loop, this.deps.config.intervalMs * (0.5 + this.rnd));
          this.timer.unref();
        });
    };
    this.timer = setTimeout(loop, 1_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Une action de bot. Retourne vrai si une attaque a été lancée. */
  async tick(): Promise<boolean> {
    const { store, seasons, config, online } = this.deps;
    if (this.bots.length === 0 || seasons.paused || !store.isUp() || online() >= config.maxOnline)
      return false;
    const bot = this.bots[Math.floor(this.rnd * this.bots.length)]!;
    const defend = this.rnd < 0.25;
    const cityId = defend ? await this.pickOwnCity(bot) : await this.pickBorderTarget(bot);
    if (cityId === null) return false;
    // Un joueur moyen : ~55 % du maximum, avec une dispersion réaliste.
    const ratio = Math.min(0.95, Math.max(0.2, 0.55 + (this.rnd - 0.5) * 0.5));
    await this.attack(bot, cityId, Math.round(ratio * BOT_MAX_SCORE));
    this.deps.metrics?.botAction(defend ? 'defend' : 'attack');
    return true;
  }

  /** Une ville étrangère proche d'une ville du pays du bot, tirée plutôt parmi les moins précieuses. */
  private async pickBorderTarget(bot: Bot): Promise<number | null> {
    const { geo, store } = this.deps;
    const own = geo.idsInCountry(bot.countryCode);
    if (own.length === 0) return null;
    const anchor = geo.get(own[Math.floor(this.rnd * own.length)]!);
    if (!anchor) return null;
    const near = [...geo.idsInTile(anchor.tile)].filter(
      (id) => geo.get(id)?.countryCode !== bot.countryCode,
    );
    if (near.length === 0) return null;
    // Échantillon borné (la tuile peut contenir des milliers de villes).
    const sample = Array.from(
      { length: Math.min(12, near.length) },
      () => near[Math.floor(this.rnd * near.length)]!,
    );
    const owners = await store.redis.hmget(K.owners, ...sample.map(String));
    const foreign = sample.filter((_, i) => Number(owners[i] ?? 0) !== bot.factionId);
    if (foreign.length === 0) return null;
    // Poids inversement proportionnel à la valeur : les petites villes tombent plus souvent.
    const weights = foreign.map((id) => 1 / (geo.get(id)?.value ?? 1));
    let r = this.rnd * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < foreign.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return foreign[i]!;
    }
    return foreign[0]!;
  }

  /** Une ville actuellement détenue par la faction du bot dans son pays. */
  private async pickOwnCity(bot: Bot): Promise<number | null> {
    const { geo, store } = this.deps;
    const own = geo.idsInCountry(bot.countryCode);
    if (own.length === 0) return null;
    const sample = Array.from(
      { length: Math.min(8, own.length) },
      () => own[Math.floor(this.rnd * own.length)]!,
    );
    const owners = await store.redis.hmget(K.owners, ...sample.map(String));
    const mine = sample.filter((_, i) => Number(owners[i] ?? 0) === bot.factionId);
    return mine.length > 0 ? mine[Math.floor(this.rnd * mine.length)]! : null;
  }

  /** Enregistre une partie « virtuelle » déjà validée puis applique son effet par le chemin normal. */
  private async attack(bot: Bot, cityId: number, score: number): Promise<void> {
    const { db, effects } = this.deps;
    const id = randomUUID();
    await db.query(
      `INSERT INTO attacks (id, user_id, faction_id, city_id, minigame, seed, status, score, max_score, validated,
                            stats, flags, submitted_at, assessed)
       VALUES ($1, $2, $3, $4, 'reflex', 'bot', 'submitted', $5, $6, true, '{}'::jsonb, ARRAY['bot'], now(), true)`,
      [id, bot.userId, bot.factionId, cityId, score, BOT_MAX_SCORE],
    );
    await effects.applyById(id);
  }

  get size(): number {
    return this.bots.length;
  }
}
