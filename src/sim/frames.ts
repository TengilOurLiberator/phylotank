/**
 * View frames from world state (CONTRACT 12). The worker and the host both use these, so a
 * view cannot tell which transport it has. Stable slots: dust slot = creature slot.
 */
import {
  DUST_EMPTY, encodeDust, encodeEnv, LIFE, quantRel, type DustFrame, type EnvFrame, type Rect, type World,
} from '../core/index.js';
import { dayPhase, yearPhase } from './clocks.js';

let scratch: DustFrame | null = null;

/**
 * DUST_FRAME palette (WELCOME `palette`): a 6 x 7 x 6 RGB cube, 252 entries, so any body
 * colour maps to an index without a per-species table. Index 255 is the empty slot.
 */
export function paletteBytes(): Uint8Array {
  const b = new Uint8Array(252 * 3);
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let bl = 0; bl < 6; bl++) {
    const i = (r * 7 + g) * 6 + bl;
    b[i * 3] = r * 51; b[i * 3 + 1] = Math.round((g * 255) / 6); b[i * 3 + 2] = bl * 51;
  }
  return b;
}
/** Palette index of a packed RGBA8 colour. */
export function paletteIndex(rgba: number): number {
  const r = rgba & 255, g = (rgba >>> 8) & 255, b = (rgba >>> 16) & 255;
  return (Math.round(r / 51) * 7 + Math.round((g * 6) / 255)) * 6 + Math.round(b / 51);
}

/** Whole-tank (or rect-culled) DUST_FRAME of every live creature, in creature-slot order. */
export function encodeViewFrames(world: World, rect?: Rect): Uint8Array {
  const r: Rect = rect ?? [0, 0, world.preset.widthM, world.preset.heightM];
  const n = world.cr.highWater;
  if (!scratch || scratch.x.length < n) {
    const cap = Math.max(16, n);
    scratch = { tick: 0, rect: r, n: 0, x: new Uint16Array(cap), y: new Uint16Array(cap), colour: new Uint8Array(cap), glow: new Uint8Array(cap) };
  }
  const f = scratch;
  f.tick = world.g.tick; f.rect = r; f.n = n;
  const c = world.cr.c;
  for (let s = 0; s < n; s++) {
    const x = c.posX[s]!;
    const y = c.posY[s]!;
    const inside = x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
    if (c.life[s] === LIFE.FREE || !inside) {
      f.colour[s] = DUST_EMPTY; f.x[s] = 0; f.y[s] = 0; f.glow[s] = 0;
      continue;
    }
    f.x[s] = quantRel(x, r[0], r[2]);
    f.y[s] = quantRel(y, r[1], r[3]);
    f.colour[s] = paletteIndex(c.colour[s]!);
    f.glow[s] = Math.max(1, Math.min(255, Math.round(c.glow[s]! * 255)));
  }
  return encodeDust(f);
}

export function envFrameFor(world: World): Uint8Array {
  const e: EnvFrame = {
    tick: world.g.tick, dayPhase: dayPhase(world), yearPhase: yearPhase(world), surfaceLight: 1,
    surfaceTempC: 14, turbidity: 0, ySurface: world.g.ySurface, modes: Array.from(world.g.flowModes.subarray(0, 5)),
  };
  return encodeEnv(e);
}
