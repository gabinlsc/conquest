import { describe, expect, it } from 'vitest';
import {
  DECAY_PER_HOUR,
  GARRISON_BASE,
  MAX_DEFENSE_FACTOR,
  SHIELD_MS,
  garrisonFor,
  influenceGain,
  isTileKey,
  resolveAttack,
  tileOf,
  tilesForBounds,
  type CityInfluenceState,
} from './capture';

const FR = 1;
const DE = 2;
const US = 3;
const HOUR = 3_600_000;
const city = (over: Partial<CityInfluenceState> = {}): CityInfluenceState => ({
  owner: FR,
  influence: {},
  lastTouch: 0,
  shieldUntil: 0,
  ...over,
});

describe('garrisonFor / influenceGain', () => {
  it('la garnison croît avec la valeur de la ville', () => {
    expect(garrisonFor(1)).toBe(GARRISON_BASE + 20);
    expect(garrisonFor(10)).toBe(240);
  });
  it('convertit un score en 0-100 points, borné', () => {
    expect(influenceGain(0, 4000)).toBe(0);
    expect(influenceGain(2000, 4000)).toBe(50);
    expect(influenceGain(4000, 4000)).toBe(100);
    expect(influenceGain(9999, 4000)).toBe(100);
    expect(influenceGain(10, 0)).toBe(0);
  });
});

describe('resolveAttack', () => {
  const G = garrisonFor(1); // 60

  it('une attaque insuffisante ajoute de l’influence sans capturer', () => {
    const r = resolveAttack(city(), DE, 50, 1000, 1);
    expect(r.captured).toBe(false);
    expect(r.state.owner).toBe(FR);
    expect(r.state.influence[DE]).toBe(50);
    expect(r.state.influence[FR]).toBe(G); // garnison matérialisée
  });

  it('capture quand l’influence dépasse strictement celle de l’occupant', () => {
    const tie = resolveAttack(city({ influence: { [DE]: 10 } }), DE, 50, 1000, 1);
    expect(tie.captured).toBe(false); // 60 vs 60 : égalité, l'occupant tient
    const win = resolveAttack(city({ influence: { [DE]: 11 } }), DE, 50, 1000, 1);
    expect(win.captured).toBe(true);
    expect(win.state.owner).toBe(DE);
    expect(win.prevOwner).toBe(FR);
    expect(win.state.shieldUntil).toBe(1000 + SHIELD_MS);
  });

  it('l’influence s’accumule entre joueurs d’une même faction', () => {
    let s = city();
    s = resolveAttack(s, DE, 40, 1000, 1).state;
    const r = resolveAttack(s, DE, 40, 2000, 1);
    expect(r.captured).toBe(true);
    expect(r.state.influence[DE]).toBe(80);
  });

  it('après capture : l’ancien occupant garde la moitié, les tiers sont divisés par deux', () => {
    const before = city({ influence: { [FR]: 100, [DE]: 80, [US]: 30 } });
    const r = resolveAttack(before, DE, 40, 1000, 1);
    expect(r.captured).toBe(true);
    expect(r.state.influence[FR]).toBe(50);
    expect(r.state.influence[US]).toBe(15);
    expect(r.state.influence[DE]).toBe(120);
  });

  it('le bouclier empêche un second changement de main immédiat, puis expire', () => {
    const first = resolveAttack(city(), DE, 61, 1000, 1);
    expect(first.captured).toBe(true);
    // Les États-Unis dépassent DE pendant le bouclier : pas de capture.
    const during = resolveAttack(first.state, US, 100, 2000, 1);
    expect(during).toMatchObject({ captured: false, shielded: true });
    expect(during.state.owner).toBe(DE);
    // Après expiration du bouclier, leur influence suffit.
    const after = resolveAttack(during.state, US, 1, 1000 + SHIELD_MS, 1);
    expect(after.captured).toBe(true);
    expect(after.state.owner).toBe(US);
  });

  it('défendre renforce l’occupant, plafonné à 3x la garnison', () => {
    let s = city();
    s = resolveAttack(s, FR, 100, 1000, 1).state;
    expect(s.influence[FR]).toBe(G + 100);
    s = resolveAttack(s, FR, 100, 1000, 1).state;
    s = resolveAttack(s, FR, 100, 1000, 1).state;
    expect(s.influence[FR]).toBe(G * MAX_DEFENSE_FACTOR);
  });

  it('une défense réussie repousse un assaillant', () => {
    let s = resolveAttack(city(), DE, 50, 1000, 1).state; // DE: 50 vs 60
    s = resolveAttack(s, FR, 40, 1000, 1).state; // FR: 100
    const r = resolveAttack(s, DE, 40, 1000, 1); // DE: 90 < 100
    expect(r.captured).toBe(false);
  });

  it('l’influence s’érode de 10 points/heure ; l’occupant ne descend pas sous sa garnison', () => {
    const before = city({ influence: { [FR]: 150, [DE]: 40 }, lastTouch: 0 });
    const r = resolveAttack(before, US, 0, 2 * HOUR, 1);
    expect(r.state.influence[DE]).toBe(40 - 2 * DECAY_PER_HOUR);
    expect(r.state.influence[FR]).toBe(150 - 2 * DECAY_PER_HOUR);
    const later = resolveAttack(before, US, 0, 100 * HOUR, 1);
    expect(later.state.influence[DE]).toBeUndefined();
    expect(later.state.influence[FR]).toBe(G);
  });

  it('une ville neutre est capturée dès que l’influence dépasse la garnison', () => {
    const neutral = city({ owner: 0 });
    expect(resolveAttack(neutral, DE, 60, 1000, 1).captured).toBe(false);
    expect(resolveAttack(neutral, DE, 61, 1000, 1).captured).toBe(true);
  });

  it('un gain nul ne change rien d’autre que l’érosion', () => {
    const r = resolveAttack(city(), DE, 0, 1000, 1);
    expect(r.captured).toBe(false);
    expect(r.state.influence[DE]).toBe(0);
  });

  it('les grandes villes résistent davantage', () => {
    const small = resolveAttack(city(), DE, 70, 1000, 1);
    const big = resolveAttack(city(), DE, 70, 1000, 10);
    expect(small.captured).toBe(true);
    expect(big.captured).toBe(false);
  });
});

describe('tuiles', () => {
  it('tileOf place les coordonnées dans la bonne tuile (bornes incluses)', () => {
    expect(tileOf(2.35, 48.85)).toBe('8:6'); // Paris
    expect(tileOf(-180, -90)).toBe('0:0');
    expect(tileOf(180, 90)).toBe('15:7');
    expect(tileOf(-74, 40.7)).toBe('4:5'); // New York
  });

  it('tilesForBounds couvre un rectangle, trie et déduplique', () => {
    expect(tilesForBounds(0, 40, 10, 50)).toEqual(['8:5', '8:6']);
    expect(tilesForBounds(-5, 40, 30, 50)).toEqual(['7:5', '7:6', '8:5', '8:6', '9:5', '9:6']);
  });

  it('gère l’antiméridien et les copies du monde', () => {
    const wrapped = tilesForBounds(170, 0, -170, 10);
    expect(wrapped).toEqual(['0:4', '15:4']);
    expect(tilesForBounds(-540, -90, 540, 90)).toHaveLength(16 * 8);
    expect(tilesForBounds(190, 0, 200, 10)).toEqual(['0:4']); // 190° ≡ -170°
  });

  it('isTileKey valide le format', () => {
    expect(isTileKey('15:7')).toBe(true);
    expect(isTileKey('16:0')).toBe(false);
    expect(isTileKey('3:8')).toBe(false);
    expect(isTileKey('a:b')).toBe(false);
  });
});
