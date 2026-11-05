/** 06 §6.1.3 to §6.1.5: templates from the grown skeleton, macro capsules, chunks and pose. */
import { describe, expect, it } from 'vitest';
import { KIND, ORGAN, type Phenotype } from '../src/core/index.js';
import { ARCHETYPES, archetypeTemplate } from '../src/render/archetypes.js';
import { CAP_FLOATS, mirrorFactor, PoseScratch, poseNodes, writeCapsules } from '../src/render/pose.js';
import { buildChunks, CAP, MAX_CORE, MAX_MACRO, templateFromPhenotype } from '../src/render/template.js';

describe('render templates', () => {
  for (const a of ARCHETYPES) {
    it(`${a}: a valid template`, () => {
      const t = archetypeTemplate(a);
      expect(t.capsules.length).toBeGreaterThan(0);
      expect(t.capsules.length).toBeLessThanOrEqual(64);
      expect(t.nodes.length).toBeLessThanOrEqual(128);
      expect(t.macro.length).toBeLessThanOrEqual(MAX_MACRO);
      expect(t.core.length).toBeLessThanOrEqual(MAX_CORE);
      expect(t.core.length).toBeGreaterThan(0);
      expect(Number.isFinite(t.extent) && t.extent > 0.2 && t.extent < 2).toBe(true);
      // every capsule is owned by exactly one chunk
      const owned = new Array(t.capsules.length).fill(0);
      for (const c of t.chunks) for (let i = c.start; i < c.end; i++) owned[i]++;
      expect(owned.every((n) => n === 1)).toBe(true);
      for (const o of t.organs) expect(o.node).toBeLessThan(t.nodes.length);
      for (const c of t.look.albedo) { expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThanOrEqual(1); }
    });
  }
  it('chunks of 8 with neighbour lists for big bodies', () => {
    const t = archetypeTemplate('deepcrown');
    const many = [...t.capsules, ...t.capsules].slice(0, 48);
    const ch = buildChunks(many, t.nodes, 0.03, t.rMax);
    expect(ch.length).toBe(6);
    expect(ch.every((c) => c.end - c.start <= 8)).toBe(true);
    expect(ch.some((c) => c.nb.length > 0)).toBe(true);
  });
  it('pose is deterministic, mirrors when facing left, and keeps dorsal up', () => {
    const t = archetypeTemplate('meadowlamp');
    const s1 = new PoseScratch(), s2 = new PoseScratch();
    poseNodes(t, { lenM: 0.1, heading: 0, phase: 1.3, bend: 0.2 }, s1);
    poseNodes(t, { lenM: 0.1, heading: 0, phase: 1.3, bend: 0.2 }, s2);
    expect(Array.from(s1.x.subarray(0, t.nodes.length))).toEqual(Array.from(s2.x.subarray(0, t.nodes.length)));
    // the head (root, node 0) leads in the direction of travel
    poseNodes(t, { lenM: 0.1, heading: 0, phase: 0, bend: 0 }, s1);
    expect(s1.x[0]).toBeGreaterThan(0);
    poseNodes(t, { lenM: 0.1, heading: Math.PI, phase: 0, bend: 0 }, s2);
    expect(s2.x[0]).toBeLessThan(0);
    // the near eye sits above the head (y down) both ways
    const eye = t.nodes.findIndex((n) => n.kind === CAP.EYE);
    expect(s1.y[eye]!).toBeLessThan(s1.y[0]! + 1e-9);
    expect(s2.y[eye]!).toBeLessThan(s2.y[0]! + 1e-9);
    expect(mirrorFactor(Math.PI / 2, false)).toBeCloseTo(0, 6);
    expect(mirrorFactor(Math.PI / 2, true)).toBe(1);
    const out = new Float32Array(t.capsules.length * CAP_FLOATS);
    writeCapsules(t.capsules, t, s1, 0.1, out, 0);
    for (let i = 0; i < t.capsules.length; i++) {
      const kind = Math.floor(out[i * CAP_FLOATS + 6]! / 2);
      expect(kind).toBe(t.capsules[i]!.kind);
    }
  });
  it('a developed Phenotype converts to a template', () => {
    const n = 4;
    const f = (v: number[]): Float32Array => Float32Array.from(v);
    const ph = {
      nParts: n, parent: Int16Array.from([-1, 0, 1, 0]), kind: Uint8Array.from([KIND.SEGMENT, KIND.SEGMENT, KIND.FIN, KIND.EYE]),
      subtype: new Uint8Array(n), moduleInnov: new Uint32Array(n), pathHash: new Uint32Array(n), dv: new Int8Array(n),
      organs: Uint16Array.from([ORGAN.GUT | ORGAN.PHOTOPHORE, 0, 0, 0]), attachU: f([0, -0.5, -0.5, 0.4]), restAngle: f([0, Math.PI, 0.3, -1]),
      limitLo: new Float32Array(n), limitHi: new Float32Array(n), length: f([0.02, 0.02, 0.012, 0.003]), radius: f([0.006, 0.005, 0.002, 0.002]),
      span: f([0, 0, 0.01, 0]), taper: f([0.1, 0.4, 0.5, 0]), muscleFrac: new Float32Array(n), lipidFrac: new Float32Array(n), armour: new Float32Array(n),
      youngsE: new Float32Array(n), damping: new Float32Array(n), u: new Float32Array(n), v: new Float32Array(n), d: new Float32Array(n),
      cpgPhase: f([0, 1, 2, 0]), cpgAmp: f([0.1, 0.3, 0.5, 0]), glow: f([0.5, 0, 0, 0]), hue: f([0.5, 0.5, 0.5, 0.5]), params: new Float32Array(n * 5),
      lengthM: 0.04, adultLengthM: 0.04, maturity: 1, massKg: 1e-4, gutVolume: 0, gGut: 0.5,
      mouth: { filter: 0, scrape: 0, bite: 0, suction: 0, latch: 0, gape: 0, biteForce: 0, mesh: 0 }, handlingSize: 0.01, buildCostKg: 1e-4, organList: [],
    } satisfies Phenotype;
    const t = templateFromPhenotype('ph', ph, { pigHue: 0.5, pigSat: 0.5, pigLight: 0.5, opacity: 0.5, lumHue: 0.5, lumGain: 0.3, stripeFreq: 0.3, stripeAmp: 0.2, spotDensity: 0, trailGain: 0.5, pulsePeriodS: 3, pulseDuty: 0.5, softness: 1 });
    expect(t.capsules.some((c) => c.kind === CAP.FIN)).toBe(true);
    expect(t.capsules.some((c) => c.kind === CAP.EYE)).toBe(true);
    expect(t.capsules.some((c) => c.kind === CAP.GUT)).toBe(true);
    expect(t.organs.length).toBe(1);
  });
});
