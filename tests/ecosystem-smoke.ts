import { makeHarness } from './ecosystem-harness.js';
import { ecosystem, computeMetrics } from '../src/ecosystem/index.js';
import { RNG_STREAM, LIFE } from '../src/core/index.js';
const H = makeHarness({ habitat: process.argv[2] ?? 'basin' } as never);
const d = H.rng.draw(RNG_STREAM.WORLDGEN, 0, 99);
const sizes = [0.002, 0.005, 0.01, 0.03];
for (let i = 0; i < 600; i++) {
  const L = sizes[i % 4]!;
  H.spawn({ x: 2 + d.u01() * 28, y: 0.5 + d.u01() * 4, lengthM: L, species: 1 + (i % 4), traits: { ADULT_LENGTH: L } });
}
const t0 = performance.now();
let bad = 0;
for (let k = 0; k < 6000; k++) {
  H.step();
  if ((H.world.g.tick - 1) % 3 === 0) { const a = ecosystem.audit(H.world); if (!a.ok) { bad++; if (bad < 3) console.log('audit fail', H.world.g.tick, a.totalQ - a.expectedQ, a.pools); } }
  if (k % 1500 === 0) { const m = computeMetrics(H.world); console.log(k, 'pop', m.population, 'carc', m.carcasses, 'S', m.richness, 'pools', JSON.stringify(m.pools, (_, v) => typeof v === 'number' ? +v.toFixed(2) : v), 'births', H.births, 'maxMass', m.sizeSpectrum.maxMassKg.toExponential(2), 'o2min', m.o2Min.toFixed(2)); }
}
const deaths: Record<string, number> = {};
for (const e of H.events) if (e.k === 'death') deaths[e.cause] = (deaths[e.cause] ?? 0) + 1;
console.log('ms/tick', ((performance.now() - t0) / 6000).toFixed(2), 'bad audits', bad, 'deaths', JSON.stringify(deaths), 'births', H.births);
let c = 0; for (let s = 0; s < H.world.cr.highWater; s++) if (H.world.cr.c.life[s] === LIFE.ALIVE) c++;
console.log('alive', c, H.world.g.liveCount, 'carcass', H.world.g.carcassCount);
