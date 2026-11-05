import { LIFE, type WorldConfig } from '../../src/core/index.js';
import { createSim, realModules } from '../../src/sim/index.js';
import { ecosystem } from '../../src/ecosystem/index.js';
const tmpl = process.argv[2] ?? 'motefly';
const core = createSim(realModules());
const w = core.create({ preset: 'small', seedLo: 3, seedHi: 1, backend: 'cpu', founders: [{ template: tmpl as never, count: 20 }] } as WorldConfig);
const flow = new Float64Array(2); const c = w.cr.c;
let sum = 0, n = 0, pw = 0, cmdAbs = 0, cmdN = 0;
for (let i = 0; i < 300; i++) {
  core.step(w);
  if (i < 60) continue;
  for (let s = 0; s < w.cr.highWater; s++) if (c.life[s] === LIFE.ALIVE) {
    ecosystem.flowAt(w, c.posX[s]!, c.posY[s]!, flow);
    sum += Math.hypot(c.velX[s]! - flow[0]!, c.velY[s]! - flow[1]!) / c.length[s]!; n++; pw += c.powerW[s]!;
    for (let k = c.segStart[s]! + 1; k < c.segStart[s]! + c.segCount[s]!; k++) { cmdAbs += Math.abs(w.seg.c.cmd[k]!); cmdN++; }
  }
}
console.log(tmpl, 'speed through water BL/s', (sum / n).toFixed(3), 'mean powerW', (pw / n).toExponential(2), 'mean |cmd|', (cmdAbs / cmdN).toFixed(3));
