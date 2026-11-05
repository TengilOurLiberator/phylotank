/** Ecosystem unit and integration tests (04 §4.14, CONTRACT 9, 13). */
import { describe, expect, it } from 'vitest';
import {
  allocWorld, DAY_S, DT, isMajorPower, LIFE, MATERIAL, NATURE_POWERS, Q_MASS, RngStreams, M_REF_1CM, mRef, CORE_POWERS,
  POWER_IDS, type GodEventScheduled, type StepContext, type World,
} from '../src/core/index.js';
import {
  agentCapFeeKg, assimilation, basalPowerW, bindProb, computeMetrics, ecoState, ecosystem, envelopeFor, envelopeValue,
  hill, hollingFilter, infectProb, keySim, leadTicks, leniaG, leviathanEndowment, natureEvent, planCast, popcount32,
  recogProb, repairPowerW, ringKernel, roleOf, trophicLevels, transportQ, HABITATS, newStrain,
} from '../src/ecosystem/index.js';
import { stepCycling } from '../src/ecosystem/producers.js';
import { makeHarness, hash, type Harness } from './ecosystem-harness.js';

function ctxOf(w: World): StepContext {
  const rng = new RngStreams(w.g.seedLo, w.g.seedHi);
  return { tick: w.g.tick, config: w.config, rng, events: { emit() {} } };
}
function world(habitat = 'basin', seed = 5): World {
  const w = allocWorld({ preset: 'small', seedLo: seed, seedHi: 1, backend: 'cpu', habitat } as never);
  ecosystem.initWorld(w, ctxOf(w));
  return w;
}
function populate(H: Harness, n: number, sizes = [0.002, 0.004, 0.01, 0.02]): void {
  const d = H.rng.draw(1, 0, 4242);
  for (let i = 0; i < n; i++) {
    const L = sizes[i % sizes.length]!;
    H.spawn({ x: 2 + d.u01() * 28, y: 0.4 + d.u01() * 3, lengthM: L, species: 1 + (i % sizes.length), maturity: 0.8, reserveFrac: 0.28,
      traits: { ADULT_LENGTH: L, DIET_PLANT: 0.95, DIET_DETRITUS: 0.05, GROWTH_RATE: 2, CLUTCH_SIZE: 1, REPRO_RESERVE: 0.1 } });
  H.powerFactor = 0.3;
  }
}

describe('habitat presets and the terrain distance field', () => {
  it('Basin has every habitat class, no sealed pockets, and an SDF whose sign matches the material', () => {
    const w = world('basin');
    const t = ecoState(w).terrain;
    expect(t.classes).toEqual({ shelf: true, cave: true, plain: true, vent: true });
    expect(t.vents.length).toBeGreaterThanOrEqual(1);
    const [sw, sh] = w.fields.sdfGrid;
    // flood fill from the surface reaches every water cell
    const seen = new Uint8Array(sw * sh);
    const st: number[] = [];
    for (let x = 0; x < sw; x++) if (w.fields.material[x] === MATERIAL.WATER) { seen[x] = 1; st.push(x); }
    while (st.length) {
      const i = st.pop()!; const x = i % sw, y = (i - x) / sw;
      for (const j of [x > 0 ? i - 1 : -1, x < sw - 1 ? i + 1 : -1, y > 0 ? i - sw : -1, y < sh - 1 ? i + sw : -1]) {
        if (j >= 0 && !seen[j] && w.fields.material[j] === MATERIAL.WATER) { seen[j] = 1; st.push(j); }
      }
    }
    let water = 0, unreached = 0, signBad = 0;
    for (let i = 0; i < sw * sh; i++) {
      const isW = w.fields.material[i] === MATERIAL.WATER;
      if (isW) { water++; if (!seen[i]) unreached++; }
      if (isW !== w.fields.sdf[i]! > 0) signBad++;
    }
    expect(unreached).toBe(0);
    expect(signBad).toBe(0);
    expect(water / (sw * sh)).toBeGreaterThan(0.4);
    // |grad sdf| is about 1 in open water away from the boundary
    const cs = w.preset.widthM / sw;
    let n = 0, err = 0;
    for (let y = 2; y < sh - 2; y++) for (let x = 2; x < sw - 2; x++) {
      const i = y * sw + x; const s = w.fields.sdf[i]!;
      if (s < 0.5 || s > 2) continue;
      const gx = (w.fields.sdf[i + 1]! - w.fields.sdf[i - 1]!) / (2 * cs), gy = (w.fields.sdf[i + sw]! - w.fields.sdf[i - sw]!) / (2 * cs);
      err += Math.abs(Math.sqrt(gx * gx + gy * gy) - 1); n++;
    }
    expect(err / n).toBeLessThan(0.1);
  });
  it('every preset generates deterministically and differently per seed', () => {
    for (const h of HABITATS) {
      const a = world(h, 9), b = world(h, 9), c = world(h, 10);
      expect(Buffer.from(a.fields.material).equals(Buffer.from(b.fields.material))).toBe(true);
      if (h !== 'open') expect(Buffer.from(a.fields.material).equals(Buffer.from(c.fields.material))).toBe(false);
    }
  });
});

describe('flow, light and temperature', () => {
  it('face fluxes are discretely divergence-free and nothing flows into rock', () => {
    const w = world('basin');
    const s = ecoState(w);
    const [cw, ch] = w.fields.coarse;
    let maxDiv = 0, maxRock = 0;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const div = s.uFace[y * (cw + 1) + x + 1]! - s.uFace[y * (cw + 1) + x]! + s.vFace[(y + 1) * cw + x]! - s.vFace[y * cw + x]!;
      maxDiv = Math.max(maxDiv, Math.abs(div));
      const i = y * cw + x;
      if (!s.wetC[i]) {
        maxRock = Math.max(maxRock, Math.abs(s.uFace[y * (cw + 1) + x]!), Math.abs(s.uFace[y * (cw + 1) + x + 1]!), Math.abs(s.vFace[y * cw + x]!), Math.abs(s.vFace[(y + 1) * cw + x]!));
      }
    }
    expect(maxDiv).toBeLessThan(1e-12);
    expect(maxRock).toBe(0);
  });
  it('light falls as exp(-k_w y) in clear water, rock casts shadows, and is dark at night', () => {
    const H = makeHarness({ habitat: 'open' } as never);
    const w = H.world;
    const f = w.fields;
    f.qP.fill(0); f.qBphoto.fill(0);
    w.g.tick = Math.round(0.5 * DAY_S / DT); // noon
    ecosystem.stepSlow(w, H.ctx());
    const [cw] = f.coarse;
    const col = 40;
    const ratio = f.light[40 * cw + col]! / f.light[20 * cw + col]!;
    expect(ratio).toBeCloseTo(Math.exp(-0.2 * 20 * 0.25), 3);
    // an overhang: rock in coarse rows 10..12 over columns 60..70 shades the cells below
    const [sw] = f.sdfGrid;
    for (let y = 20; y < 26; y++) for (let x = 120; x < 142; x++) f.material[y * sw + x] = MATERIAL.ROCK;
    ecosystem.stepSlow(w, H.ctx());
    expect(f.light[16 * cw + 65]!).toBeLessThan(0.2 * f.light[16 * cw + 30]!);
    w.g.tick = 0; // midnight
    ecosystem.stepSlow(w, H.ctx());
    expect(f.light[2 * cw + col]!).toBeLessThan(0.05);
  });
  it('the thermocline is warm above and cold below, seasonally', () => {
    const w = world('basin');
    const s = ecoState(w);
    const T = (y: number): number => s.env.tSurf; void T;
    w.g.tick = Math.round(0.5 * 20 * DAY_S / DT); // midsummer
    ecosystem.stepSlow(w, ctxOf(w));
    const summer = s.env.tSurf;
    expect(summer).toBeGreaterThan(17);
    w.g.tick = 0;
    ecosystem.stepSlow(w, ctxOf(w));
    expect(s.env.tSurf).toBeLessThan(10);
    expect(s.env.strat).toBeLessThan(0.6);
  });
});

describe('the ledger is exact', () => {
  it('conservative transport keeps a blob exact and non-negative over a gyre', () => {
    const w = world('open');
    const s = ecoState(w);
    const f = w.fields;
    const [cw, ch] = f.coarse;
    f.qN.fill(0);
    f.qN[30 * cw + 40] = 123456789;
    const rng = new RngStreams(1, 2);
    const g = { w: cw, h: ch, cs: 0.25, wet: s.wetC, uFace: s.uFace, vFace: s.vFace };
    for (let k = 0; k < 400; k++) transportQ(g, f.qN, { dt: 0.5, kh: 0.002, kz: new Float64Array(ch + 1).fill(1e-4), ws: 0 }, rng, k, 3);
    let sum = 0, neg = 0, spread = 0;
    for (let i = 0; i < f.qN.length; i++) { sum += f.qN[i]!; if (f.qN[i]! < 0) neg++; if (f.qN[i]! > 0) spread++; if (!Number.isInteger(f.qN[i]!)) neg++; }
    expect(sum).toBe(123456789);
    expect(neg).toBe(0);
    expect(spread).toBeGreaterThan(20);
  });
  it('audit is exact on every ecology tick of a populated world for 10,000 ticks with births, deaths, floods and culls', () => {
    const H = makeHarness({ habitat: 'basin' } as never);
    populate(H, 150);
    const w = H.world;
    const ev = (power: GodEventScheduled['power'], intensity: number, at: number): GodEventScheduled =>
      planCast({ t: 'cast', id: `${power}-${at}`, epoch: 0, power, target: { kind: 'global' }, intensity, seed: at }, at, 1);
    H.pending.push(ev('nutrientFlood', 0.2, 1500), ev('cull', 0.3, 3000), ev('meteor', 0.2, 4500), ev('bless', 0.5, 6000), ev('whaleFall', 0.5, 7000));
    H.pending.sort((a, b) => a.fireTick - b.fireTick);
    let fails = 0;
    for (let k = 0; k < 10_000; k++) {
      H.step();
      if ((w.g.tick - 1) % 3 === 0 && !ecosystem.audit(w).ok) fails++;
    }
    expect(fails).toBe(0);
    const deaths = H.events.filter((e) => e.k === 'death').length;
    expect(deaths).toBeGreaterThan(20);
    expect(H.births).toBeGreaterThan(0);
    expect(w.g.mTotalQ).toBeGreaterThan(w.g.mTargetQ); // the flood and the meteor added mass
  }, 900_000);
  it('same seed, same events: identical state hash', () => {
    const run = (): bigint => { const H = makeHarness({ habitat: 'basin', seedLo: 77 } as never); populate(H, 120); H.step(900); return hash(H); };
    expect(run()).toBe(run());
  }, 300_000);
});

describe('metabolism hooks (CONTRACT 9.4, 9.5)', () => {
  it('Kleiber basal at 15 C and the Arrhenius factor', () => {
    expect(basalPowerW(1, 15, 0, 3)).toBeCloseTo(0.3, 12);
    expect(basalPowerW(16, 15, 0, 3)).toBeCloseTo(0.3 * 8, 10);
    expect(basalPowerW(1, 25, 0, 3) / basalPowerW(1, 15, 0, 3)).toBeGreaterThan(2.3);
    expect(basalPowerW(1, 15, 1, 8)).toBeCloseTo(0.3 * 1.15 * 1.2, 10);
  });
  it('repair cost buys lifespan and Holling type II saturates filter intake', () => {
    expect(repairPowerW(1, 4)).toBeCloseTo(0.15, 12);
    const B = 1e-3;
    const jMax = (8 * B) / (0.6 * 4000);
    expect(hollingFilter(1e3, B)).toBeLessThan(jMax);
    expect(hollingFilter(1e3, B)).toBeGreaterThan(0.99 * jMax);
    expect(hollingFilter(1e-9, B)).toBeCloseTo(1e-9, 12);
  });
  it('assimilation penalises generalists (theta = 1.3)', () => {
    const spec = assimilation(0, 1, 1), gen = 0.5 * assimilation(0, 1, 0.5) + 0.5 * assimilation(1, 1, 0.5);
    expect(spec).toBeCloseTo(0.75, 12);
    expect(gen).toBeLessThan(0.5 * (assimilation(0, 1, 1) + assimilation(1, 1, 1)));
  });
  it('the cap fee is additive: it costs a microbe hundreds of its own bodies and a fish almost nothing', () => {
    const fee = agentCapFeeKg(0.9 * 4096, 4096);
    expect(fee / mRef(0.002 * 0.2)).toBeGreaterThan(100);
    expect(fee / mRef(0.126 * 0.2)).toBeLessThan(0.2);
    expect(agentCapFeeKg(1000, 4096)).toBe(0);
    expect(agentCapFeeKg(10_000, 4096)).toBe(M_REF_1CM);
  });
  it('a creature with no food starves, and an unstarved one ages out near its lifespan', () => {
    const H = makeHarness({ habitat: 'open' } as never);
    const w = H.world;
    w.fields.qP.fill(0); // no plankton anywhere: move it all into dissolved N to keep the books
    const s = H.spawn({ x: 10, y: 2, lengthM: 0.003, maturity: 0.9, filter: 0, scrape: 0 });
    for (let k = 0; k < 6000 && w.cr.c.life[s] === LIFE.ALIVE; k++) H.step();
    expect(w.cr.c.life[s]).toBe(LIFE.CARCASS);
    expect(H.events.find((e) => e.k === 'death')!).toMatchObject({ cause: 'starvation' });
  }, 300_000);
});

describe('producers', () => {
  it('the Lenia ring kernel sums to 1 and G maps to [-1, 1] with its peak at m_B', () => {
    const k = ringKernel(4);
    expect(k.w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(leniaG(0.3)).toBeCloseTo(1, 12);
    expect(leniaG(0)).toBeLessThan(-0.99);
  });
  it('plankton blooms in light and nutrient; mats stay patchy, on substrate, and conserve mass', () => {
    const H = makeHarness({ habitat: 'basin' } as never);
    const w = H.world;
    const f = w.fields;
    const sum = (a: Float64Array): number => a.reduce((x, y) => x + y, 0);
    w.g.tick = Math.round(0.3 * DAY_S / DT);
    const p0 = sum(f.qP);
    H.step(1500);
    expect(sum(f.qP)).toBeGreaterThan(p0);
    expect(ecosystem.audit(w).ok).toBe(true);
    const s = ecoState(w);
    let onSub = 0, off = 0;
    const subSet = new Set(Array.from(s.substrate));
    for (let j = 0; j < f.qBphoto.length; j++) if (f.qBphoto[j]! > 0) { if (subSet.has(j)) onSub++; else off++; }
    expect(off).toBe(0);
    expect(onSub).toBeGreaterThan(50);
    // patchiness: coefficient of variation over the substrate
    const vals = Array.from(s.substrate).map((j) => f.qBphoto[j]!);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    expect(sd / mean).toBeGreaterThan(0.5);
  }, 300_000);
});

describe('nutrient cycling', () => {
  it('a nutrient flood raises M_total by dM and the excess halves in about 40 days', () => {
    const w = world('basin');
    const s = ecoState(w);
    const ctx = ctxOf(w);
    const target = w.g.mTargetQ - s.rActiveTargetQ;
    const before = w.g.mTotalQ;
    ecosystem.applyGodEvent(w, planCast({ t: 'cast', id: 'f', epoch: 0, power: 'nutrientFlood', target: { kind: 'global' }, intensity: 0.4, seed: 1 }, 0, 1), ctx);
    const dM = w.g.mTotalQ - before;
    expect(dM).toBe(Math.floor((0.05 + 0.45 * 0.4) * w.g.mTargetQ));
    const ex0 = w.g.mTotalQ - w.g.qReservoir - target;
    for (let k = 0; k < 80; k++) stepCycling(w, s, ctx, 600); // 80 x 600 s = 40 days
    const ex1 = w.g.mTotalQ - w.g.qReservoir - target;
    expect(ex1 / ex0).toBeGreaterThan(0.4);
    expect(ex1 / ex0).toBeLessThan(0.6);
    expect(ecosystem.audit(w).ok).toBe(true);
  });
});

describe('pathogens with immune keys (04 §4.6)', () => {
  it('binding, recognition and infection probability match hand values', () => {
    expect(popcount32(0xffffffff)).toBe(32);
    expect(popcount32(0x0f0f0001)).toBe(9);
    expect(keySim(0, 0)).toBe(1);
    expect(bindProb(0x12345678, 0x12345678)).toBeCloseTo(1 / (1 + Math.exp(-5)), 9);
    expect(bindProb(0, 0xffffffff)).toBeLessThan(1e-6);
    expect(recogProb(0xff, 0, 0xff)).toBeCloseTo(1 / (1 + Math.exp(-6)), 9);
    expect(infectProb(1, 1, 1, 0, 0)).toBeCloseTo(1 - Math.exp(-1), 12);
    expect(infectProb(1, 1, 1, 1, 1)).toBe(0);
  });
  it('a plague infects only the target species when signatures are far apart, and strains are collected when gone', () => {
    const H = makeHarness({ habitat: 'open' } as never);
    const w = H.world;
    for (let i = 0; i < 60; i++) H.spawn({ x: 10 + (i % 6) * 0.05, y: 2 + Math.floor(i / 6) * 0.05, lengthM: 0.01, species: i < 30 ? 1 : 2, maturity: 0.9 });
    const c = w.cr.c;
    for (let s = 0; s < w.cr.highWater; s++) c.surfaceSig[s] = c.species[s] === 1 ? 0x00000000 : 0xffffffff;
    ecosystem.applyGodEvent(w, planCast({ t: 'cast', id: 'p', epoch: 0, power: 'plague', target: { kind: 'species', species: [1] }, intensity: 0.5, seed: 3 }, 0, 1), H.ctx());
    H.step(600);
    let inf1 = 0, inf2 = 0;
    for (let s = 0; s < w.cr.highWater; s++) {
      if (c.infStrain[s * 2] === 0xffffffff && c.infStrain[s * 2 + 1] === 0xffffffff) continue;
      if (c.species[s] === 1) inf1++; else inf2++;
    }
    expect(inf1).toBeGreaterThan(5);
    expect(inf2).toBe(0);
    const st = ecoState(w).strains;
    const k = newStrain(ecoState(w), 0, { antigen: 1, adhesin: 2, beta: 1, virulence: 1, growth: 1, envHalfLife: 10 });
    H.step(3);
    expect(st.live[k]).toBe(0);
  });
});

describe('god powers and nature mode (CONTRACT 13, DESIGN R7)', () => {
  it('lead times: 3 s for major powers, 1 s for minor, scaled by the achieved speed', () => {
    expect(leadTicks('meteor', 0.1, 1)).toBe(90);
    expect(leadTicks('bloom', 0.9, 1)).toBe(30);
    expect(leadTicks('coldSnap', 0.6, 4)).toBe(360);
    expect(leadTicks('coldSnap', 0.4, 4)).toBe(120);
    for (const p of POWER_IDS) expect(leadTicks(p, 1, 1)).toBe(isMajorPower(p, 1) ? 90 : 30);
  });
  it('a cold snap reaches its surface offset within the attack time and releases', () => {
    const w = world('basin');
    const s = ecoState(w);
    const ctx = ctxOf(w);
    ecosystem.stepSlow(w, ctx);
    const base = s.env.tSurf;
    const ev = planCast({ t: 'cast', id: 'c', epoch: 0, power: 'coldSnap', target: { kind: 'global' }, intensity: 0.5, seed: 1 }, 0, 1);
    w.g.tick = ev.fireTick;
    ecosystem.applyGodEvent(w, ev, ctx);
    w.g.tick = ev.fireTick + Math.round(ev.envelope.attack / DT);
    ecosystem.stepSlow(w, { ...ctx, tick: w.g.tick });
    expect(s.mods.tempOffset).toBeCloseTo(-5, 6);
    expect(s.env.tSurf).toBeLessThan(base);
    w.g.tick = ev.fireTick + Math.round((ev.envelope.attack + ev.envelope.sustain + ev.envelope.release + 1) / DT);
    ecosystem.stepSlow(w, { ...ctx, tick: w.g.tick });
    expect(w.g.modifiers.length).toBe(0);
    expect(s.mods.tempOffset).toBe(0);
  });
  it('a meteor carves a crater, kills inside r_k, raises turbidity and adds mass', () => {
    const H = makeHarness({ habitat: 'basin' } as never);
    const w = H.world;
    populate(H, 80);
    const [sw] = w.fields.sdfGrid;
    const x = 16, y = w.preset.heightM * 0.82;
    const inside: number[] = [];
    for (let i = 0; i < 5; i++) inside.push(H.spawn({ x: x + i * 0.05, y: y - 0.2, lengthM: 0.01, maturity: 0.9 }));
    const glassBefore = Array.from(w.fields.material).filter((m) => m === MATERIAL.CRATER_GLASS).length;
    const m0 = w.g.mTotalQ;
    ecosystem.applyGodEvent(w, planCast({ t: 'cast', id: 'm', epoch: 0, power: 'meteor', target: { kind: 'point', pos: [x, y] }, intensity: 0.5, seed: 9 }, 0, 1), H.ctx());
    H.step(3);
    for (const s of inside) expect(w.cr.c.life[s]).toBe(LIFE.CARCASS);
    expect(Array.from(w.fields.material).filter((m) => m === MATERIAL.CRATER_GLASS).length).toBeGreaterThan(glassBefore);
    expect(w.fields.turb[10]!).toBeGreaterThan(1);
    expect(w.g.mTotalQ).toBeGreaterThan(m0);
    expect(ecosystem.audit(w).ok).toBe(true);
    void sw;
  });
  it('cull removes f x n individuals (rounded); ice age lowers and restores the sea level', () => {
    const H = makeHarness({ habitat: 'basin' } as never);
    const w = H.world;
    populate(H, 100);
    const live0 = w.g.liveCount;
    ecosystem.applyGodEvent(w, planCast({ t: 'cast', id: 'k', epoch: 0, power: 'cull', target: { kind: 'global' }, intensity: 0.5, seed: 2 }, 0, 1), H.ctx());
    H.step(3);
    expect(live0 - w.g.liveCount).toBeGreaterThanOrEqual(Math.round(0.55 * live0) - 1);
    const ice = planCast({ t: 'cast', id: 'i', epoch: 0, power: 'iceAge', target: { kind: 'global' }, intensity: 1, seed: 2 }, w.g.tick, 1);
    ice.fireTick = w.g.tick;
    ecosystem.applyGodEvent(w, ice, H.ctx());
    w.g.tick += Math.round(ice.envelope.attack / DT);
    ecosystem.stepSlow(w, H.ctx());
    expect(w.g.ySurface).toBeGreaterThan(1);
    expect(Array.from(w.fields.material).some((m) => m === MATERIAL.ICE)).toBe(true);
    w.g.tick += Math.round((ice.envelope.sustain + ice.envelope.release + 10) / DT);
    ecosystem.stepSlow(w, H.ctx());
    expect(w.g.ySurface).toBe(0);
    expect(Array.from(w.fields.material).some((m) => m === MATERIAL.ICE)).toBe(false);
    expect(ecosystem.audit(w).ok).toBe(true);
  });
  it('every power applies without breaking the ledger', () => {
    const H = makeHarness({ habitat: 'basin' } as never);
    populate(H, 60);
    const w = H.world;
    for (const p of POWER_IDS) {
      const ev = planCast({ t: 'cast', id: p, epoch: 0, power: p, target: { kind: 'circle', pos: [16, 9], radius: 4 }, intensity: 0.6, seed: 5 }, w.g.tick, 1);
      ev.fireTick = w.g.tick;
      ecosystem.applyGodEvent(w, ev, H.ctx());
      H.step(30);
      expect(ecosystem.audit(w).ok, p).toBe(true);
    }
    expect(CORE_POWERS.every((p) => envelopeFor(p, 0.5).attack >= 0)).toBe(true);
  }, 300_000);
  it('nature mode issues only mild powers at magnitude <= 0.4, at about 0.1 per sim day', () => {
    const w = world('open');
    const rng = new RngStreams(w.g.seedLo, w.g.seedHi);
    let n = 0;
    const days = 2000;
    for (let tick = 0; tick < days * DAY_S / DT; tick += 300) {
      const ev = natureEvent(w, { tick, config: w.config, rng, events: { emit() {} } });
      if (!ev) continue;
      n++;
      expect(NATURE_POWERS).toContain(ev.power);
      expect(ev.intensity).toBeLessThanOrEqual(0.4);
      expect(ev.author).toBe('nature');
      expect(isMajorPower(ev.power, ev.intensity)).toBe(false);
    }
    expect(n / days).toBeGreaterThan(0.07);
    expect(n / days).toBeLessThan(0.13);
  });
  it('a leviathan endowment adds K_ENDOW n m to N and M_target, and refuses beyond the world limit', () => {
    const w = world('basin');
    const t0 = w.g.mTargetQ, m0 = w.g.mTotalQ;
    const r = leviathanEndowment(w, 2, 31, [30, 10]);
    expect(r.ok).toBe(true);
    expect(w.g.mTotalQ - m0).toBe(Math.floor((8 * 2 * 31) / Q_MASS));
    expect(w.g.mTargetQ - t0).toBe(w.g.mTotalQ - m0);
    expect(leviathanEndowment(w, 100, 31, [30, 10]).ok).toBe(false);
    expect(ecosystem.audit(w).ok).toBe(true);
  });
  it('envelopes ramp, hold, release and expire', () => {
    const ev = planCast({ t: 'cast', id: 'h', epoch: 0, power: 'heatwave', target: { kind: 'global' }, intensity: 0.2, seed: 1 }, 0, 1);
    const at = (s: number): number => envelopeValue(ev, ev.fireTick + s / DT);
    expect(at(ev.envelope.attack / 2)).toBeCloseTo(0.5, 6);
    expect(at(ev.envelope.attack + 1)).toBe(1);
    expect(at(ev.envelope.attack + ev.envelope.sustain + ev.envelope.release / 2)).toBeCloseTo(0.5, 3);
    expect(at(ev.envelope.attack + ev.envelope.sustain + ev.envelope.release + 1)).toBe(-1);
  });
});

describe('interest metrics (04 §4.9)', () => {
  it('Hill numbers and evenness on known distributions', () => {
    const even = hill([10, 10, 10, 10]);
    expect(even.d0).toBe(4); expect(even.d1).toBeCloseTo(4, 10); expect(even.d2).toBeCloseTo(4, 10); expect(even.evenness).toBeCloseTo(1, 10);
    const skew = hill([97, 1, 1, 1]);
    expect(skew.d1).toBeLessThan(1.3); expect(skew.d2).toBeLessThan(1.1);
  });
  it('trophic levels on a chain (1, 2, 3, 4) and a diamond web', () => {
    expect(trophicLevels([[], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]].map((r) => (r.length ? r : [0, 0, 0, 0])))).toEqual([1, 2, 3, 4]);
    const tl = trophicLevels([[0, 0, 0, 0], [1, 0, 0, 0], [1, 0, 0, 0], [0, 1, 1, 0]]);
    expect(tl[3]).toBeCloseTo(3, 12);
    const mixed = trophicLevels([[0, 0, 0], [1, 0, 0], [1, 1, 0]]);
    expect(mixed[2]).toBeCloseTo(2.5, 12);
  });
  it('roles from diet vectors', () => {
    expect(roleOf([1, 0, 0, 0, 0, 0, 0], 0, true)).toBe('filter');
    expect(roleOf([0, 1, 0, 0, 0, 0, 0], 0, false)).toBe('grazer');
    expect(roleOf([0, 0, 0, 0, 0, 1, 0], 0, false)).toBe('predator');
    expect(roleOf([0, 0, 0, 0.5, 0.5, 0, 0], 0, false)).toBe('scavenger');
    expect(roleOf([0, 0, 0, 0, 0, 0, 1], 0, false)).toBe('parasite');
    expect(roleOf([0, 0, 0, 0, 0, 0, 0], 0.9, false)).toBe('producer');
  });
  it('a populated world reports diversity, spectrum, speciation and immigrant share', () => {
    const H = makeHarness({ habitat: 'basin' } as never);
    populate(H, 80);
    for (let i = 0; i < 10; i++) H.spawn({ x: 5 + i, y: 1, lengthM: 0.01, species: 99, immigrantTick: 0, maturity: 0.9 });
    H.step(300);
    const m = computeMetrics(H.world);
    expect(m.richness).toBe(5);
    expect(m.hillAbundance.d0).toBe(5);
    expect(m.speciationPerDay).toBeGreaterThan(0);
    expect(m.immigrantBiomassFraction).toBeGreaterThan(0);
    expect(m.immigrantBiomassFraction).toBeLessThan(1);
    expect(m.sizeSpectrum.maxMassKg).toBeGreaterThan(0);
    expect(m.rolesOccupied).toBeGreaterThan(0);
  });
});

describe('safety valves (04 §4.7)', () => {
  it('total consumer extinction asks for a reseed after half a sim day; low diversity for 10 days asks for immigrants', async () => {
    const { checkValves, newValves } = await import('../src/ecosystem/valves.js');
    const w = world('open');
    const s = ecoState(w);
    const v = newValves();
    v.pImmPerDay = 0;
    const rng = new RngStreams(1, 1);
    const at = (tick: number): StepContext => ({ tick, config: w.config, rng, events: { emit() {} } });
    const day = DAY_S / DT;
    expect(checkValves(w, s, v, at(0))).toBe(null);
    expect(checkValves(w, s, v, at(0.25 * day))).toBe(null);
    expect(checkValves(w, s, v, at(0.5 * day))).toBe('extinction');
    expect(s.pending.spawns.at(-1)!.kind).toBe('reseed');
    // one species only: diversity collapse after 10 days
    w.cr.highWater = 12;
    for (let i = 0; i < 12; i++) { w.cr.c.life[i] = LIFE.ALIVE; w.cr.c.species[i] = 3; }
    const v2 = newValves(); v2.pImmPerDay = 0;
    expect(checkValves(w, s, v2, at(day))).toBe(null);
    expect(checkValves(w, s, v2, at(11 * day))).toBe('diversity');
    // background immigration happens at about 0.05 per day
    const v3 = newValves();
    for (let i = 0; i < 12; i++) w.cr.c.species[i] = i < 6 ? 1 : 2;
    for (let i = 0; i < 12; i++) w.cr.c.life[i] = LIFE.ALIVE;
    w.cr.highWater = 24;
    for (let i = 12; i < 24; i++) { w.cr.c.life[i] = LIFE.ALIVE; w.cr.c.species[i] = i < 18 ? 1 : 2; }
    let n = 0;
    for (let t = 0; t < 400 * day; t += 30) if (checkValves(w, s, v3, at(t)) === 'immigration') n++;
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThan(32);
  });
});
