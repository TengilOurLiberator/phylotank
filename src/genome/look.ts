/**
 * Small trait readers for other modules: the diet enzyme simplex (CONTRACT 9.3), the look block
 * and the packed far-LOD body colour for creature column `colour` (CONTRACT 5.1).
 */
import { T, packRGBA, type Genome } from '../core/index.js';
import { TI, trait } from './genes.js';

/** e_plant = x1 (1 - x2), e_meat = (1 - x1)(1 - x2), e_det = x2 (CONTRACT 9.3). They sum to 1. */
export function enzymes(g: Genome): [number, number, number] {
  const x1 = trait(g, TI.DIET_PLANT), x2 = trait(g, TI.DIET_DETRITUS);
  return [x1 * (1 - x2), (1 - x1) * (1 - x2), x2];
}

export interface Look {
  hue: number; sat: number; lum: number; translucency: number; glowHue: number; glowBase: number;
  pulseHz: number; pulseShape: number; patternKind: number; patternFreq: number; patternContrast: number; trail: number;
}
export function lookOf(g: Genome): Look {
  return {
    hue: trait(g, TI.BODY_HUE), sat: trait(g, T.BODY_SAT!), lum: trait(g, T.BODY_LUM!), translucency: trait(g, T.TRANSLUCENCY!),
    glowHue: trait(g, TI.GLOW_HUE), glowBase: trait(g, TI.GLOW_BASE), pulseHz: trait(g, TI.PULSE_FREQ),
    pulseShape: trait(g, T.PULSE_SHAPE!), patternKind: Math.min(3, Math.floor(trait(g, T.PATTERN_KIND!) * 4)),
    patternFreq: trait(g, T.PATTERN_FREQ!), patternContrast: trait(g, T.PATTERN_CONTRAST!), trail: trait(g, T.TRAIL_LENGTH!),
  };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 1) + 1) % 1) * 6;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] = hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m];
}

/** Packed RGBA8 body colour (alpha = 1 - translucency) for far LOD. Arithmetic only, so deterministic. */
export function packedColour(g: Genome): number {
  const lk = lookOf(g);
  const [r, gg, b] = hslToRgb(lk.hue, lk.sat, lk.lum);
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return packRGBA(q(r), q(gg), q(b), q(1 - 0.7 * lk.translucency));
}
