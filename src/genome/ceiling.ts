/** The size ceiling and the leviathan flag (CONTRACT 3.3, review R2). */
import { GENOME_FLAG_LEVIATHAN, decodeQ, encodeQ, type Genome } from '../core/index.js';
import { TI, trait, traitSpec } from './genes.js';

export const isLeviathan = (g: Genome): boolean => (g.flags & GENOME_FLAG_LEVIATHAN) !== 0;

/** Expressed adult length after the world ceiling. */
export function expressedAdultLength(g: Genome, lCeilingM: number): number {
  const L = trait(g, TI.ADULT_LENGTH);
  return isLeviathan(g) ? L : Math.min(L, lCeilingM);
}

/** Clamp the stored ADULT_LENGTH q so the decoded value is at most the ceiling, unless a leviathan. */
export function clampToCeiling(g: Genome, lCeilingM: number): void {
  if (isLeviathan(g) || !(lCeilingM > 0)) return;
  const spec = traitSpec(TI.ADULT_LENGTH);
  let qMax = encodeQ(lCeilingM, spec);
  // encodeQ rounds to the nearest step; step down until the decoded value is within the ceiling
  while (qMax > 0 && decodeQ(qMax, spec) > lCeilingM) qMax--;
  if (g.traits[TI.ADULT_LENGTH]! > qMax) g.traits[TI.ADULT_LENGTH] = qMax;
}
