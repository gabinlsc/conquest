/** Statistiques en ligne (algorithme de Welford) : moyenne/variance sans conserver les échantillons. */
export interface RunningStats {
  n: number;
  mean: number;
  m2: number;
}

export function welfordUpdate(s: RunningStats, x: number): RunningStats {
  const n = s.n + 1;
  const delta = x - s.mean;
  const mean = s.mean + delta / n;
  return { n, mean, m2: s.m2 + delta * (x - mean) };
}

export const stdDev = (s: RunningStats): number => (s.n > 1 ? Math.sqrt(s.m2 / (s.n - 1)) : 0);

/** Écart (en écarts-types) à la moyenne ; l'écart-type est plancher pour ne pas exploser sur une population homogène. */
export function zScore(s: RunningStats, x: number, minSd = 0.05): number {
  return (x - s.mean) / Math.max(stdDev(s), minSd);
}

/**
 * Poids de suspicion par drapeau. Un joueur honnête déclenche de temps en temps un drapeau « doux » ;
 * c'est leur ACCUMULATION (avec décroissance de moitié par jour) qui mène à une sanction.
 */
export const FLAG_WEIGHTS: Record<string, number> = {
  'soft:click_burst': 3,
  'soft:tap_burst': 3,
  'soft:perfect_run': 10,
  'soft:fast_average': 10,
  'soft:robotic_timing': 20,
  'soft:perfect_precision': 25,
  'soft:score_outlier': 25,
  'soft:ip_cluster': 15,
  // Rejouer un enregistrement : quasi impossible par hasard, donc très lourd.
  'soft:replayed_pattern': 70,
};
/** Un drapeau « dur » (entrée impossible : réactions inhumaines, soumission instantanée…) pèse 30. */
export const HARD_FLAG_WEIGHT = 30;
/** Plafond par partie : une seule partie ne suffit pas à faire sanctionner quelqu'un... sauf rejeu avéré + autre signal. */
export const MAX_SUSPICION_PER_ATTACK = 80;
export const SHADOW_BAN_THRESHOLD = 100;

export function weightOf(flags: readonly string[]): { total: number; reasons: string[] } {
  let total = 0;
  const reasons: string[] = [];
  for (const f of flags) {
    const w = f.startsWith('hard:') ? HARD_FLAG_WEIGHT : (FLAG_WEIGHTS[f] ?? 0);
    if (w > 0) {
      total += w;
      reasons.push(f);
    }
  }
  return { total: Math.min(total, MAX_SUSPICION_PER_ATTACK), reasons };
}
