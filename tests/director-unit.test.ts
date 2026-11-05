/** Director unit tests (06 §6.8.2): springs, the van Wijk path, scoring factors, the StoryBook. */
import { describe, expect, it } from 'vitest';
import { log, TICK_HZ, type SimEvent } from '../src/core/index.js';
import {
  captionFor, createDirector, ExposureMemory, speciesName, springCritical, StoryBook, trapezoid, ZoomPath,
} from '../src/director/index.js';
import { storm } from '../src/director/replay.js';

const ev = (e: object, tS = 0): SimEvent => ({ t: Math.round(tS * TICK_HZ), eid: 1, epoch: 0, ...e } as SimEvent);
const book = () => new StoryBook({ maxStories: 512, mergeRadiusM: 20, mergeWindowS: 10, lCeilingM: 0.2, tankW: 64, tankH: 36 });

describe('critically damped spring', () => {
  it('never overshoots a step from rest, and is frame-rate independent within 1e-6', () => {
    for (const omega of [0.4, 0.8, 1.5, 4]) {
      const end: number[] = [];
      for (const hz of [30, 60, 144]) {
        let x = 0; let v = 0;
        const dt = 1 / hz;
        const o = { x: 0, v: 0 };
        for (let i = 0; i < hz * 10; i++) {
          springCritical(x, v, 1, omega, dt, o);
          x = o.x; v = o.v;
          expect(x).toBeLessThanOrEqual(1 + 1e-12);
          expect(v).toBeGreaterThanOrEqual(-1e-12);
        }
        end.push(x);
      }
      expect(Math.abs(end[0]! - end[1]!)).toBeLessThan(1e-6);
      expect(Math.abs(end[0]! - end[2]!)).toBeLessThan(1e-6);
    }
  });
});

describe('van Wijk and Nuij zoom path', () => {
  const cases: [number, number, number, number, number, number][] = [
    [0, 0, 1, 10, 0, 1], [0, 0, 0.5, 30, 5, 4], [5, 5, 8, 6, 5, 0.25], [0, 0, 2, 0, 0, 16], [10, 3, 1, 10.0000001, 3, 1],
  ];
  it('ends exactly at the endpoints and is continuous into them', () => {
    for (const c of cases) {
      const p = new ZoomPath(...c);
      const a = p.at(0); const b = p.at(p.S);
      expect([a.x, a.y, a.w]).toEqual([c[0], c[1], c[2]]);
      if (p.S > 0) expect([b.x, b.y, b.w]).toEqual([c[3], c[4], c[5]]);
      else expect(Math.abs(b.x - c[3])).toBeLessThan(1e-6); // a sub-micro-screen hop is no move
      if (p.S > 1e-6) {
        const n = p.at(p.S * (1 - 1e-9));
        expect(Math.abs(n.x - c[3]) / c[5]).toBeLessThan(1e-6);
        expect(Math.abs(n.w - c[5]) / c[5]).toBeLessThan(1e-6);
      }
    }
  });
  it('its length under the perceptual metric matches the closed form S', () => {
    for (const c of cases.slice(0, 4)) {
      const p = new ZoomPath(...c);
      let L = 0;
      const n = 20000;
      let prev = p.at(0, { x: 0, y: 0, w: 0 });
      for (let i = 1; i <= n; i++) {
        const q = p.at((p.S * i) / n, { x: 0, y: 0, w: 0 });
        const du = Math.hypot(q.x - prev.x, q.y - prev.y);
        const wm = (q.w + prev.w) / 2;
        L += Math.sqrt(p.rho * p.rho * (du / wm) ** 2 + (log(q.w / prev.w) / p.rho) ** 2);
        prev = q;
      }
      expect(Math.abs(L - p.S) / p.S).toBeLessThan(1e-3);
    }
  });
  it('perceived speed is constant within 2% at constant ds/dt (and in the trapezoid middle)', () => {
    for (const c of cases.slice(0, 4)) {
      const p = new ZoomPath(...c);
      const T = 6;
      const speeds: number[] = [];
      for (let i = 1; i < 600; i++) {
        const t0 = (T * i) / 600; const t1 = t0 + 0.001;
        const f0 = trapezoid(t0, T, 0.3); const f1 = trapezoid(t1, T, 0.3);
        if (t0 < 0.3 * T || t1 > 0.7 * T) continue;
        const a = p.at(p.S * f0, { x: 0, y: 0, w: 0 }); const b = p.at(p.S * f1, { x: 0, y: 0, w: 0 });
        const du = Math.hypot(b.x - a.x, b.y - a.y); const wm = (a.w + b.w) / 2;
        speeds.push(Math.sqrt(p.rho ** 2 * (du / wm) ** 2 + (log(b.w / a.w) / p.rho) ** 2) / 0.001);
      }
      const mean = speeds.reduce((s, v) => s + v, 0) / speeds.length;
      for (const v of speeds) expect(Math.abs(v - mean) / mean).toBeLessThan(0.02);
    }
  });
});

describe('scoring factors', () => {
  it('exposure decays with the 30 min, 10 min, 4 min and 3 min half-lives', () => {
    const e = new ExposureMemory({
      halfLife: { entity: 1800, species: 600, type: 240, region: 180 },
      beta: { entity: 0.15, species: 0.04, type: 0.01, region: 0.01 }, regionCellM: 32,
    });
    e.entity.add(1, 30, 0); e.species.add(2, 30, 0); e.type.add('hunt', 30, 0); e.region.add(e.regionKey(1, 1), 30, 0);
    expect(e.entity.get(1, 1800)).toBeCloseTo(15, 9);
    expect(e.species.get(2, 600)).toBeCloseTo(15, 9);
    expect(e.type.get('hunt', 240)).toBeCloseTo(15, 9);
    expect(e.region.get(e.regionKey(1, 1), 180)).toBeCloseTo(15, 9);
    // a shark followed for 30 s: N about exp(-4.5) from entity exposure alone; back to about 0.25 after an hour
    const n0 = e.novelty([1], [], 'x', 1000, 1000, 0);
    expect(n0).toBeCloseTo(Math.exp(-4.5), 6);
    const e2 = new ExposureMemory(e.cfg);
    e2.entity.add(1, 30, 0);
    expect(e2.novelty([1], [], 'x', 1000, 1000, 3600)).toBeCloseTo(Math.exp(-4.5 / 4), 6);
  });
  it('recency decays with the type time constant, and disasters are exempt from travel and novelty', () => {
    const d = createDirector({ mode: 'screensaver', tankW: 64, tankH: 36, viewWpx: 1920, viewHpx: 1080 });
    d.step([ev({ k: 'hunt', phase: 'start', pred: 1, prey: 2, pos: [60, 30] })], 1 / 30);
    const s = [...d.book.stories.values()][0]!;
    const s0 = d.score(s, false);
    for (let i = 0; i < 8 * 30; i++) d.step([], 1 / 30); // 8 s: one tau for hunts
    const s1 = d.score(s, false);
    // recency alone gives e^-1; exposure from filming it meanwhile can only lower it further
    expect(s1 / s0).toBeGreaterThan(Math.exp(-1) * 0.3);
    expect(s1 / s0).toBeLessThan(Math.exp(-1) * 1.05);
    // a far disaster scores its full base, a far hunt pays for travel
    const g = createDirector({ mode: 'screensaver', tankW: 64, tankH: 36, viewWpx: 1920, viewHpx: 1080 });
    g.step([], 1 / 30);
    g.step([
      ev({ k: 'god', cmdId: 'a', power: 'meteor', author: 'god', tFire: 90, pos: [63, 35], radius: 3, strength: 1, major: true }),
      ev({ k: 'hunt', phase: 'start', pred: 5, prey: 6, pos: [63, 35] }),
    ], 1 / 30);
    const dis = [...g.book.stories.values()].find((x) => x.type === 'disaster')!;
    const hunt = [...g.book.stories.values()].find((x) => x.type === 'hunt')!;
    const base = 10 * (1 + 0.5 * Math.log(1 + (3 * 1.5) / 5));
    expect(g.score(dis, false)).toBeCloseTo(base, 6);
    expect(g.travel(hunt.pos[0], hunt.pos[1], 8)).toBeGreaterThan(1);
  });
});

describe('StoryBook', () => {
  it('merges by key, and by type within 20 m and 10 s for area stories', () => {
    const b = book();
    b.ingest(ev({ k: 'hunt', phase: 'start', pred: 1, prey: 2, pos: [1, 1] }, 0));
    b.ingest(ev({ k: 'hunt', phase: 'update', pred: 1, prey: 2, pos: [2, 1] }, 1));
    expect(b.stories.size).toBe(1);
    b.ingest(ev({ k: 'massDeath', centroid: [10, 10], radius: 3, deaths: 25, z: 6 }, 2));
    b.ingest(ev({ k: 'massDeath', centroid: [25, 12], radius: 3, deaths: 25, z: 6 }, 8)); // 15 m, 6 s: merges
    b.ingest(ev({ k: 'massDeath', centroid: [60, 30], radius: 3, deaths: 25, z: 6 }, 9)); // far: new story
    b.ingest(ev({ k: 'massDeath', centroid: [10, 10], radius: 3, deaths: 25, z: 6 }, 30)); // late: new story
    const md = [...b.stories.values()].filter((s) => s.type === 'massDeath');
    expect(md.length).toBe(3);
    expect(md.find((s) => s.magnitude === 50)).toBeDefined();
  });
  it('a kill ends its hunt and spawns an aftermath; a giant in a hunt promotes it to giantKill', () => {
    const b = book();
    b.ingest(ev({ k: 'hunt', phase: 'start', pred: 1, prey: 2, pos: [1, 1] }, 0));
    b.ingest(ev({ k: 'death', id: 2, species: 3, pos: [1.5, 1], size: 0.01, cause: 'predation', killer: 1 }, 5));
    expect(b.stories.get('hunt:1')!.ended).toBe(true);
    expect(b.stories.get('kill:2')!.type).toBe('kill');
    b.ingest(ev({ k: 'giant', id: 9, species: 4, size: 0.18, percentile: 99.9 }, 6));
    b.ingest(ev({ k: 'hunt', phase: 'start', pred: 9, prey: 10, pos: [5, 5] }, 7));
    expect(b.stories.get('hunt:9')!.type).toBe('giantKill');
  });
  it('stays bounded under 10k events per second, evicting ended and low-scoring stories first', () => {
    const lg = storm(2, 10000, 2);
    const b = book();
    let keep = 0;
    b.ingest(ev({ k: 'god', cmdId: 'keep', power: 'meteor', author: 'god', tFire: 90, pos: [3, 3], radius: 3, strength: 1, major: true }));
    b.stories.get('god:keep')!.score = 1e9;
    for (const e of lg.events) { b.ingest(e); keep = b.stories.size > keep ? b.stories.size : keep; }
    expect(keep).toBeLessThanOrEqual(512);
    expect(b.stories.has('god:keep')).toBe(true);
    expect(b.evictions).toBeGreaterThan(19000);
  });
});

describe('captions', () => {
  it('names are stable and original, and templates fill from the story', () => {
    expect(speciesName(42)).toEqual(speciesName(42));
    expect(speciesName(42).binomial).not.toBe(speciesName(43).binomial);
    const b = book();
    const s = b.ingest(ev({ k: 'speciation', parent: 5, child: 6, founders: [1, 2, 3], pos: [1, 1] }))!;
    const c = captionFor(s)!;
    expect(c.line2).toContain(speciesName(6).common);
    expect(c.line2).toContain(speciesName(5).common);
    expect(c.line2).not.toMatch(/\u2014/); // no em-dashes
  });
});

describe('idle drift (the wallpaper camera)', () => {
  it('drifts towards lit, lively cells of the heat map and avoids dark ones', () => {
    const w = 64; const h = 36;
    const data = new Uint8Array(w * h * 4);
    // one bright, busy patch in the lower right; everything else dark and empty
    for (let iy = 26; iy < 32; iy++) for (let ix = 48; ix < 56; ix++) { data[(iy * w + ix) * 4] = 200; data[(iy * w + ix) * 4 + 1] = 255; }
    const d = createDirector({ mode: 'wallpaper', tankW: 64, tankH: 36, viewWpx: 1920, viewHpx: 1080, seedLo: 3 });
    d.setCensus({ species: [], heat: data, heatW: w, heatH: h, heatCh: 4 });
    let near = 0; let n = 0;
    for (let i = 0; i < 30 * 600; i++) {
      const f = d.step([], 1 / 30);
      if (i > 30 * 120 && i % 30 === 0) {
        n++;
        // the bright patch is in view (the zoom breathes between the whole tank and one school)
        const c = f.camera;
        const hw = 1920 / 2 ** c.zeta / 2; const hh = 1080 / 2 ** c.zeta / 2;
        if (Math.abs(52 - c.cx) < hw && Math.abs(29 - c.cy) < hh) near++;
      }
    }
    expect(near / n).toBeGreaterThan(0.8);
    expect(d.shots.every((s) => s.kind === 'drift')).toBe(true);
  });
});
