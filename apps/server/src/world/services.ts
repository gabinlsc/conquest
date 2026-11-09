import type { EffectService } from '../attacks/effects';
import type { AntiCheatService } from '../anticheat/service';
import type { EventService } from '../events/service';
import type { LeaderboardService } from '../seasons/leaderboards';
import type { SeasonService } from '../seasons/service';
import type { CityIndex } from './geo';
import type { FactionDirectory } from './factions';
import type { WorldStore } from './store';

/** Regroupe les services de l'état chaud du monde ; absent => l'API fonctionne en lecture seule sur Postgres. */
export interface WorldServices {
  store: WorldStore;
  geo: CityIndex;
  factions: FactionDirectory;
  effects: EffectService;
  events: EventService;
  leaderboards: LeaderboardService;
  seasons: SeasonService;
  anticheat: AntiCheatService;
}
