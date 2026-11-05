/**
 * Five LOD tiers with hysteresis and per-profile caps (06 §6.1.4, §6.1.9).
 *
 *   D  density  below 0.75 px   splatted into the soft density texture
 *   L3 speck    0.75 to 4 px    one additive gaussian
 *   L2 small    4 to 28 px      a three-capsule SDF (the design's impostor tier, see docs/modules/render.md)
 *   L1 body     28 to 110 px    SDF over at most 8 macro capsules
 *   L0 hero     above 110 px    the full SDF skeleton
 *
 * Thresholds carry +-15% hysteresis per instance and a change of tier cross-fades over 250 ms.
 */
import type { ViewMode } from '../core/index.js';

export const TIER = { D: 0, L3: 1, L2: 2, L1: 3, L0: 4 } as const;
export type Tier = (typeof TIER)[keyof typeof TIER];
export const TIER_NAMES = ['D', 'L3', 'L2', 'L1', 'L0'] as const;
/** Lower screen-size bound in px of tiers L3, L2, L1, L0. */
export const TIER_PX = [0.75, 4, 28, 110] as const;
export const HYSTERESIS = 0.15;
export const FADE_S = 0.25;

/** Caps per profile (06 §6.1.9, 5090 column; the laptop caps arrive with adaptive quality). */
export interface TierCaps { l0: number; l1: number; l2: number; l3: number }
export const TIER_CAPS: Readonly<Record<ViewMode | 'tvLocal', TierCaps>> = {
  wallpaper: { l0: 16, l1: 800, l2: 20000, l3: 1_000_000 },
  screensaver: { l0: 128, l1: 4000, l2: 50000, l3: 2_000_000 },
  tv: { l0: 64, l1: 2000, l2: 20000, l3: 1_000_000 },
  tvLocal: { l0: 8, l1: 300, l2: 4000, l3: 150_000 },
  god: { l0: 128, l1: 4000, l2: 50000, l3: 2_000_000 },
};

/** Tier from screen size alone, with hysteresis relative to the previous tier. */
export function tierFor(sizePx: number, prev: Tier | -1): Tier {
  let t: Tier = TIER.D;
  for (let i = 0; i < 4; i++) if (sizePx >= TIER_PX[i]!) t = (i + 1) as Tier;
  if (prev < 0 || prev === t) return t;
  const px: readonly number[] = TIER_PX;
  // moving up needs the size to clear the boundary by 15%, moving down to fall 15% under it
  if (t > prev) {
    let up: Tier = prev as Tier;
    for (let i = prev; i < 4; i++) if (sizePx >= px[i]! * (1 + HYSTERESIS)) up = (i + 1) as Tier;
    return up;
  }
  let down: Tier = prev as Tier;
  for (let i = prev - 1; i >= 0; i--) if (sizePx < px[i]! * (1 - HYSTERESIS)) down = i as Tier;
  return down;
}

export interface LodCandidate { id: number; sizePx: number; priority: number }

/**
 * Classify a frame's instances. `prev` maps id to the previous tier and is updated in place.
 * When a cap is hit the largest on screen keep the tier (priority first, so the director's
 * subject is never demoted) and the rest drop a tier.
 */
export function classify(cands: readonly LodCandidate[], prev: Map<number, Tier>, caps: TierCaps, out: Tier[]): number[] {
  out.length = cands.length;
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]!;
    out[i] = tierFor(c.sizePx, prev.get(c.id) ?? -1);
  }
  const capOf = [Infinity, caps.l3, caps.l2, caps.l1, caps.l0];
  // enforce caps from the top tier down; demoted instances may push the next tier over its cap
  for (let tier = TIER.L0; tier >= TIER.L3; tier--) {
    const idx: number[] = [];
    for (let i = 0; i < out.length; i++) if (out[i] === tier) idx.push(i);
    if (idx.length > capOf[tier]!) {
      idx.sort((a, b) => (cands[b]!.priority - cands[a]!.priority) || (cands[b]!.sizePx - cands[a]!.sizePx) || (cands[a]!.id - cands[b]!.id));
      for (let k = capOf[tier]!; k < idx.length; k++) out[idx[k]!] = (tier - 1) as Tier;
    }
  }
  for (let i = 0; i < out.length; i++) { counts[out[i]!]!++; prev.set(cands[i]!.id, out[i]!); }
  return counts;
}
