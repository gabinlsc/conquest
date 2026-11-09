import { describe, expect, it } from 'vitest';
import { TICKS_PER_HOUR, attackPoints } from './season';

describe('attackPoints', () => {
  it('vaut l’influence, plus un bonus croissant avec la valeur en cas de capture', () => {
    expect(attackPoints(60, false, 5)).toBe(60);
    expect(attackPoints(60, true, 1)).toBe(60 + 25 + 10);
    expect(attackPoints(60, true, 10)).toBeGreaterThan(attackPoints(60, true, 1));
  });
  it('12 tranches de 5 minutes par heure', () => {
    expect(TICKS_PER_HOUR).toBe(12);
  });
});
