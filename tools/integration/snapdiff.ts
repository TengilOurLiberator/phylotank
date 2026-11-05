import { hashWorld, type World, type WorldConfig } from '../../src/core/index.js';
import { sim } from '../../src/sim/index.js';
import { decodeWorld, encodeWorld } from '../../src/host/snapshot.js';
const CFG = JSON.parse(process.argv[2] ?? '{"preset":"small","seedLo":7,"seedHi":9,"backend":"cpu","skeletonMotes":300}') as WorldConfig;
const pre = Number(process.argv[3] ?? 50);
const a = sim.create(CFG);
for (let i = 0; i < pre; i++) sim.step(a);
const { world: b } = decodeWorld(encodeWorld(a, { kind: 'auto', journalSeq: 1, pending: [] }));
console.log('after load equal', hashWorld(a) === hashWorld(b));
function diff(x: World, y: World): string[] {
  const out: string[] = [];
  for (const [pn, pa, pb] of [['cr', x.cr, y.cr], ['seg', x.seg, y.seg]] as const) {
    for (const k of Object.keys(pa.c)) {
      const A = (pa.c as Record<string, ArrayLike<number>>)[k]!, B = (pb.c as Record<string, ArrayLike<number>>)[k]!;
      for (let i = 0; i < A.length; i++) if (!(A[i] === B[i] || (A[i] !== A[i] && B[i] !== B[i]))) { out.push(`${pn}.${k}[${i}] ${A[i]} vs ${B[i]}`); break; }
    }
  }
  for (const k of Object.keys(x.fields)) {
    const A = (x.fields as unknown as Record<string, ArrayLike<number>>)[k]!, B = (y.fields as unknown as Record<string, ArrayLike<number>>)[k]!;
    if (!A || typeof A !== 'object' || !('length' in A)) continue;
    for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) { out.push(`fields.${k}[${i}] ${A[i]} vs ${B[i]}`); break; }
  }
  return out;
}
for (let t = 0; t < 400; t++) {
  sim.step(a); sim.step(b);
  const d = diff(a, b);
  if (d.length) { console.log('first diff at step', t + 1, 'tick', a.g.tick, d.slice(0, 8)); process.exit(0); }
}
console.log('no diff over 400 ticks');
