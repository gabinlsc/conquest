import type { EffectService } from '../attacks/effects';
import type { EventService } from '../events/service';
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
}
