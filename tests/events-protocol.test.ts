/**
 * Protocol 1.1 predictive BODY_FRAME deltas (src/core/protocol.ts): lossless against keyframes,
 * compatible with 1.0 readers, and the bandwidth before and after on a live fallback world.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BODY_CLASS, BodyDeltaDecoder, BodyDeltaEncoder, decodeBodyFrame, encodeBodyFrame, FRAME_FLAG, LIFE, log2, predictBody,
  quantRel, readHeader, speedToByte, TAU, type BodyFrame, type BodyRecord, type Rect, type World,
} from '../src/core/index.js';
import { sim } from '../src/sim/index.js';

vi.setConfig({ testTimeout: 120_000 });

/** A tiny deterministic generator for the synthetic streams (tests only). */
function lcg(seed: number): () => number { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

function frameOf(tick: number, rect: Rect, recs: (BodyRecord | undefined)[]): BodyFrame {
  const present = new Uint8Array(Math.ceil(recs.length / 8));
  const records: BodyRecord[] = [];
  recs.forEach((r, s) => { if (r) { present[s >> 3]! |= 1 << (s & 7); records.push(r); } });
  return { tick, rect, nSlots: recs.length, present, records };
}

describe('protocol 1.1 body deltas', () => {
  it('decode to exactly the keyframe records, through moving rects, entries and leaves', () => {
    const rnd = lcg(42);
    const enc = new BodyDeltaEncoder(60);
    const dec = new BodyDeltaDecoder();
    const n = 200;
    const pos = Array.from({ length: n }, () => [rnd() * 30 + 1, rnd() * 16 + 1, rnd() * TAU, 0.01 + rnd() * 0.2, 0] as number[]);
    let kinds = { key: 0, delta: 0 };
    for (let f = 0; f < 300; f++) {
      const tick = f * 2;
      const rect: Rect = [0.5 + f * 0.01, 0.3, 31 + f * 0.01, 17.7];
      const recs: (BodyRecord | undefined)[] = [];
      for (let s = 0; s < n; s++) {
        const p = pos[s]!;
        p[2] = p[2]! + (rnd() - 0.5) * 0.2; p[4] = (p[4]! + 9) & 255;
        p[0] = p[0]! + Math.cos(p[2]!) * p[3]! / 15; p[1] = p[1]! + Math.sin(p[2]!) * p[3]! / 15;
        if ((s + f) % 37 === 0) { recs.push(undefined); continue; } // leaves and comes back
        let h = p[2]! % TAU; if (h < 0) h += TAU;
        recs.push({
          x: quantRel(p[0]!, rect[0], rect[2]), y: quantRel(p[1]!, rect[1], rect[3]), heading: Math.round((h / TAU) * 256) & 255,
          speed: speedToByte(p[3]!, log2), phase: p[4]!, bend: s % 5 === 0 ? (f % 7) - 3 : 0, glow: 200 + (f % 3), flags: f % 50 === 0 ? 1 : 0,
        });
      }
      const fr = frameOf(tick, rect, recs);
      const bytes = enc.encode(fr);
      if ((readHeader(bytes).flags & FRAME_FLAG.KEYFRAME) !== 0) kinds.key++; else kinds.delta++;
      const got = dec.decode(bytes);
      expect(got.nSlots).toBe(n);
      expect(got.records).toEqual(fr.records);
      expect([...got.present]).toEqual([...fr.present]);
    }
    expect(kinds.key).toBe(10); // every 2 s of ticks
    expect(kinds.delta).toBe(290);
    expect(enc.deltaBytes / kinds.delta).toBeLessThan(0.75 * (enc.keyBytes / kinds.key));
  });

  it('is invisible to 1.0 readers: keyframes only unless deltas are on, deltas refused by the 1.0 decoder', () => {
    const r: BodyRecord = { x: 100, y: 200, heading: 3, speed: 90, phase: 0, bend: 0, glow: 255, flags: 0 };
    const off = new BodyDeltaEncoder(60, false);
    for (let t = 0; t < 20; t += 2) {
      const b = off.encode(frameOf(t, [0, 0, 32, 18], [r, r]));
      expect(readHeader(b).flags & FRAME_FLAG.KEYFRAME).toBe(FRAME_FLAG.KEYFRAME);
      expect(decodeBodyFrame(b).records).toEqual([r, r]);
    }
    const on = new BodyDeltaEncoder(60, true);
    on.encode(frameOf(0, [0, 0, 32, 18], [r]));
    const d = on.encode(frameOf(2, [0, 0, 32, 18], [r]));
    expect(readHeader(d).version).toBe(0x0101);
    expect(() => decodeBodyFrame(d)).toThrow(/protocol 1\.1/);
    // a delta whose base the decoder never saw is refused (the view resyncs)
    expect(() => new BodyDeltaDecoder().decode(d)).toThrow(/base/);
  });

  it('predicts by dead reckoning and sends a still creature in zero bytes', () => {
    const r: BodyRecord = { x: 30000, y: 30000, heading: 0, speed: 160, phase: 10, bend: 0, glow: 9, flags: 0 };
    const p = predictBody(r, 0, 4, [0, 0, 32, 18], [0, 0, 32, 18], 1);
    expect(p.x - r.x).toBe(quantRel(32 * 30000 / 65535 + 2 ** (160 / 16 - 10), 0, 32) - r.x); // 1 m/s for 1 s
    expect(p.phase).toBe(14);
    const enc = new BodyDeltaEncoder();
    const still: BodyRecord = { ...r, speed: 0, phase: 0 };
    enc.encode(frameOf(0, [0, 0, 32, 18], Array(64).fill(still)));
    const d = enc.encode(frameOf(2, [0, 0, 32, 18], Array(64).fill(still)));
    // header 8 + rect 16 + nSlots 2 + base 4 + 16 class bytes, no per-slot bytes
    expect(d.length).toBe(46);
    expect(d[30]! & 3).toBe(BODY_CLASS.PREDICTED);
  });
});

/** Body records of every live creature, slot = creature slot (the worker's stable slots). */
function bodyFrameOf(w: World, rect: Rect): BodyFrame {
  const c = w.cr.c;
  const recs: (BodyRecord | undefined)[] = new Array(w.cr.highWater);
  for (let s = 0; s < w.cr.highWater; s++) {
    if (c.life[s] !== LIFE.ALIVE) continue;
    let h = c.heading[s]! % TAU; if (h < 0) h += TAU;
    recs[s] = {
      x: quantRel(c.posX[s]!, rect[0], rect[2]), y: quantRel(c.posY[s]!, rect[1], rect[3]), heading: Math.round((h / TAU) * 256) & 255,
      speed: speedToByte(Math.sqrt(c.velX[s]! ** 2 + c.velY[s]! ** 2), log2), phase: 0, bend: 0,
      glow: Math.max(1, Math.min(255, Math.round(c.glow[s]! * 255))), flags: c.flags[s]! & 0xff,
    };
  }
  return frameOf(w.g.tick, rect, recs);
}

describe('protocol 1.1 bandwidth on a live world', () => {
  it('cuts BODY_FRAME bytes against keyframes only (measured)', () => {
    const w = sim.create({ preset: 'small', seedLo: 3, seedHi: 9, backend: 'cpu', skeletonMotes: 1500 });
    for (let i = 0; i < 300; i++) sim.step(w);
    const key = new BodyDeltaEncoder(60, false);
    const delta = new BodyDeltaEncoder(60, true);
    const dec = new BodyDeltaDecoder();
    let bodies = 0; let frames = 0;
    let rect: Rect = [0, 0, 32, 18];
    for (let i = 0; i < 900; i++) { // 30 s of sim time, frames at 15 Hz
      sim.step(w);
      if (w.g.tick % 2 !== 0) continue;
      if (i >= 450) rect = [2 + (i - 450) * 0.004, 1, 18 + (i - 450) * 0.004, 10]; // a slow director pan
      const f = bodyFrameOf(w, rect);
      key.encode(f);
      const got = dec.decode(delta.encode(f));
      expect(got.records).toEqual(f.records);
      bodies += f.records.length; frames++;
    }
    const seconds = frames / 15;
    const before = key.keyBytes / seconds; const after = (delta.keyBytes + delta.deltaBytes) / seconds;
    // eslint-disable-next-line no-console
    console.log(`BODY_FRAME bandwidth, ${Math.round(bodies / frames)} bodies at 15 Hz: 1.0 keyframes ${(before / 1024).toFixed(1)} KB/s, 1.1 deltas ${(after / 1024).toFixed(1)} KB/s (${(100 * after / before).toFixed(1)}%), ${((delta.keyBytes + delta.deltaBytes) / bodies).toFixed(2)} B per body per frame; classes ${delta.classCounts.join('/')}`);
    expect(after).toBeLessThan(0.6 * before);
  });
});
