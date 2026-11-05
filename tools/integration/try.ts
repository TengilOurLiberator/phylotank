import { LIFE, type WorldConfig } from '../../src/core/index.js';
import { createSim, drainEvents } from '../../src/sim/index.js';
import { createGenomeModule } from '../../src/genome/index.js';
import { physics } from '../../src/physics/index.js';
import { brain } from '../../src/brain/index.js';
import { ecosystem } from '../../src/ecosystem/index.js';

const which = (process.argv[2] ?? 'gpb').split('');
const mods: Record<string, unknown> = {};
if (which.includes('g')) mods.genome = createGenomeModule();
if (which.includes('p')) mods.physics = physics;
if (which.includes('b')) mods.brain = brain;
const tmpl = process.argv[3] ?? 'motefly';
const n = Number(process.argv[4] ?? 200);
const ticks = Number(process.argv[5] ?? 900);
const core = createSim(mods);
const t0 = performance.now();
const w = core.create({ preset: 'small', seedLo: 7, seedHi: 1, backend: 'cpu', founders: [{ template: tmpl as never, count: n }] } as WorldConfig);
console.log('create ms', (performance.now() - t0).toFixed(0), 'live', w.g.liveCount, 'segs', w.seg.highWater);
let births = 0, deaths = 0;
const t1 = performance.now();
for (let i = 0; i < ticks; i++) {
  core.step(w);
  for (const e of drainEvents(w)) { if (e.k === 'birth') births++; if (e.k === 'death') deaths++; }
  if (i % 300 === 299) {
    const c = w.cr.c; let sp = 0, nan = 0, k = 0;
    for (let s = 0; s < w.cr.highWater; s++) if (c.life[s] === LIFE.ALIVE) { const v = Math.hypot(c.velX[s]!, c.velY[s]!); if (!Number.isFinite(v) || !Number.isFinite(c.posX[s]!)) nan++; else { sp += v / Math.max(1e-6, c.length[s]!); k++; } }
    const a = ecosystem.audit(w);
    console.log(`t=${i + 1} live=${w.g.liveCount} carc=${w.g.carcassCount} births=${births} deaths=${deaths} meanBL/s=${(sp / Math.max(1, k)).toFixed(3)} nan=${nan} audit=${a.ok} ms/tick=${((performance.now() - t1) / (i + 1)).toFixed(2)}`);
  }
}
