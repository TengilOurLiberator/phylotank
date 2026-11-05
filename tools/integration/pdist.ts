import { type WorldConfig } from '../../src/core/index.js';
import { createSim, realModules } from '../../src/sim/index.js';
const core = createSim(realModules());
const w = core.create({ preset: 'small', seedLo: 7, seedHi: 1, backend: 'cpu', founders: [{ template: 'motefly', count: 200 }] } as WorldConfig);
for (let i = 0; i < 600; i++) core.step(w);
const f = w.fields; const [fw, fh] = f.fine; const [cw, ch] = f.coarse;
const rows: number[] = [];
for (let y = 0; y < fh; y++) { let s = 0; for (let x = 0; x < fw; x++) s += f.qP[y * fw + x]!; rows.push(s); }
const band = (a: number[], n: number) => { const out: string[] = []; const k = a.length / n; for (let i = 0; i < n; i++) { let s = 0; for (let j = Math.floor(i * k); j < Math.floor((i + 1) * k); j++) s += a[j]!; out.push((s * 1e-12).toFixed(3)); } return out.join(' '); };
console.log('fine', fw, fh, 'coarse', cw, ch, 'P kg by depth band (top to bottom):', band(rows, 12));
const c = w.cr.c; const ys: number[] = new Array(12).fill(0);
for (let s = 0; s < w.cr.highWater; s++) if (c.life[s] === 1) ys[Math.min(11, Math.floor(c.posY[s]! / w.preset.heightM * 12))]++;
console.log('creatures by depth band:', ys.join(' '));
