import { describe, expect, it } from 'vitest';
import * as d from '../../src/core/dmath.js';

function rel(a: number, b: number): number { return Math.abs(a - b) / Math.max(1e-300, Math.abs(b)); }

describe('deterministic math', () => {
  const xs: number[] = [];
  for (let i = -2000; i <= 2000; i++) xs.push(i * 0.0137 + Math.sin(i) * 1e-3);
  it('exp and log', () => {
    for (const x of xs) expect(rel(d.exp(x), Math.exp(x))).toBeLessThan(1e-14);
    for (const x of xs.map((v) => Math.abs(v) * 37 + 1e-9)) expect(rel(d.log(x), Math.log(x))).toBeLessThan(1e-14);
    expect(d.exp(0)).toBe(1);
    expect(d.log(1)).toBe(0);
    expect(d.exp(800)).toBe(Infinity);
    expect(d.log(0)).toBe(-Infinity);
    expect(Number.isNaN(d.log(-1))).toBe(true);
    expect(rel(d.log(5e-310), Math.log(5e-310))).toBeLessThan(1e-13);
  });
  it('sin, cos, atan2, tanh, pow', () => {
    for (const x of xs) {
      expect(Math.abs(d.sin(x * 10) - Math.sin(x * 10))).toBeLessThan(2e-15);
      expect(Math.abs(d.cos(x * 10) - Math.cos(x * 10))).toBeLessThan(2e-15);
      expect(Math.abs(d.tanh(x) - Math.tanh(x))).toBeLessThan(2e-15);
      expect(Math.abs(d.atan2(x, 1 - x) - Math.atan2(x, 1 - x))).toBeLessThan(2e-15);
      expect(Math.abs(d.atan2(-x, x - 3) - Math.atan2(-x, x - 3))).toBeLessThan(4e-15);
    }
    expect(rel(d.pow(2.5, 3.7), Math.pow(2.5, 3.7))).toBeLessThan(1e-13);
    expect(d.pow(-2, 3)).toBeCloseTo(-8, 12);
    expect(rel(d.cbrt(27), 3)).toBeLessThan(1e-15);
  });
  it('wrapAngle lands in (-pi, pi]', () => {
    for (const x of xs) { const w = d.wrapAngle(x * 9); expect(w).toBeGreaterThan(-Math.PI - 1e-15); expect(w).toBeLessThanOrEqual(Math.PI); }
    expect(d.wrapAngle(-Math.PI)).toBe(d.PI);
  });
});
