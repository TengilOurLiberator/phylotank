/**
 * Fixed-point and quantum helpers (CONTRACT 4.2 rule 5, 9.1).
 */
import { E_B, Q_MASS } from './constants.js';

/** Position-correction fixed point: units of 2^-20 m. */
export const POS_FIXED_SCALE = 1048576;
export function toPosFixed(m: number): number { return Math.round(m * POS_FIXED_SCALE) | 0; }
export function fromPosFixed(q: number): number { return q / POS_FIXED_SCALE; }

/**
 * Quantise a real-valued amount of quanta with a carry lane: q = floor(a + carry),
 * carry := a + carry - q. Carries are bookkeeping, never mass.
 */
export function quantiseWithCarry(amountQ: number, carry: Float64Array, lane: number): number {
  const t = amountQ + carry[lane]!;
  const q = Math.floor(t);
  carry[lane] = t - q;
  return q;
}

export function kgToQ(kg: number): number { return kg / Q_MASS; }
export function qToKg(q: number): number { return q * Q_MASS; }
/** Reserve quanta burnt to supply `joules` of work (CONTRACT 9.2 "burning"). */
export function joulesToReserveQ(joules: number): number { return joules / (Q_MASS * E_B); }
export function reserveQToJoules(q: number): number { return q * Q_MASS * E_B; }

/** Pack an RGBA8 colour (components 0..255) into the creature `colour` column layout. */
export function packRGBA(r: number, g: number, b: number, a = 255): number {
  return ((r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24)) >>> 0;
}
export function unpackRGBA(c: number): [number, number, number, number] {
  return [c & 255, (c >>> 8) & 255, (c >>> 16) & 255, (c >>> 24) & 255];
}
