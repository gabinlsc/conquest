/**
 * PRNG déterministe à partir d'une graine texte (xmur3 pour hacher la graine, mulberry32 pour le flux).
 * N'utilise que des opérations entières (Math.imul) : le client et le serveur obtiennent EXACTEMENT
 * la même séquence, ce qui permet au serveur de rejouer/valider une partie sans la stocker en entier.
 */
export type Rng = () => number;

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

/** Retourne une fonction produisant des flottants uniformes dans [0, 1). */
export function createRng(seed: string): Rng {
  let a = xmur3(seed)();
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randBetween = (rng: Rng, min: number, max: number): number =>
  min + rng() * (max - min);
