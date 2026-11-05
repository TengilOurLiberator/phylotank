/** Diversity indices (07 §3.6): richness S, Shannon H' and exp(H'), Simpson 1 - sum p^2. */
export interface Diversity { richness: number; shannon: number; effective: number; simpson: number }
export function diversity(counts: readonly number[]): Diversity {
  const live = counts.filter((c) => c > 0);
  const total = live.reduce((a, b) => a + b, 0);
  if (total === 0) return { richness: 0, shannon: 0, effective: 0, simpson: 0 };
  let h = 0, s = 0;
  for (const c of live) { const p = c / total; h -= p * Math.log(p); s += p * p; }
  return { richness: live.length, shannon: h, effective: Math.exp(h), simpson: 1 - s };
}
/** Counts per species id from a history sample [speciesId, count, ...]. */
export function sampleCounts(flat: readonly number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i + 1 < flat.length; i += 2) m.set(flat[i]!, flat[i + 1]!);
  return m;
}
