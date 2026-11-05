/**
 * Cross-engine determinism probe (README acceptance: the same genome gives a bit-identical
 * Phenotype in Node and Chromium). Bundled by tests/genome-chromium.cjs and run in both engines.
 */
import { RngStreams, xxh64, type Phenotype } from '../src/core/index.js';
import { InnovationRegistry, TEMPLATE_IDS, crossoverWith, develop, mutateWith, templateGenome, distance } from '../src/genome/index.js';
import { encodeGenome } from '../src/core/index.js';

function bytesOf(ph: Phenotype): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const k of Object.keys(ph).sort()) {
    const v = (ph as unknown as Record<string, unknown>)[k];
    if (ArrayBuffer.isView(v)) parts.push(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  parts.push(new Uint8Array(new Float64Array([ph.lengthM, ph.massKg, ph.gGut, ph.buildCostKg, ph.handlingSize, ph.mouth.gape]).buffer));
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function probe(): string {
  const rng = new RngStreams(0xabc, 0xdef);
  const reg = new InnovationRegistry();
  let acc = 0n;
  let g = templateGenome('meadowlamp');
  for (const id of TEMPLATE_IDS) for (const m of [0, 0.33, 1]) acc ^= xxh64(bytesOf(develop(templateGenome(id), m, { depth01: 0.4, tempC: 12 }, { maxParts: 64, lCeilingM: 0.2 })));
  for (let i = 0; i < 300; i++) {
    g = i % 7 === 3 ? crossoverWith(g, templateGenome(TEMPLATE_IDS[i % 8]!), { rng, tick: i, childId: i, lCeilingM: 0.2, mutagen: 1 })
      : mutateWith(g, { rng, tick: i, childId: i, lCeilingM: 0.2, mutagen: 6 }, reg);
    acc = (acc * 31n + xxh64(encodeGenome(g)) + xxh64(bytesOf(develop(g, (i % 11) / 10, { depth01: 0.5, tempC: 14 }, { maxParts: 64, lCeilingM: 0.2 })))) & 0xffffffffffffffffn;
    acc ^= BigInt(Math.round(distance(g, templateGenome('meadowlamp')) * 1e12));
  }
  return acc.toString(16);
}
