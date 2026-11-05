// Ad-hoc timing harness (not a vitest file): bundle with esbuild, then run with node.
import { sim, contextFor } from '../src/sim/index.js';
import { ecosystem, ecoState } from '../src/ecosystem/index.js';
import { prepare } from '../src/ecosystem/transport.js';
import { kzRows } from '../src/ecosystem/env.js';
import { P } from '../src/ecosystem/params.js';
const habitat = process.argv[2] ?? 'basin';
const w = sim.create({ preset: 'small', seedLo: 1, seedHi: 2, backend: 'cpu', habitat } as never);
const s = ecoState(w);
const T = { eco: 0, ecoField: 0, slow: 0 };
const N = 600;
for (let i = 0; i < N; i++) {
  const ctx = contextFor(w);
  const tick = w.g.tick;
  if (tick % 3 === 0) { const t0 = performance.now(); ecosystem.stepEcology(w, ctx); const dt = performance.now() - t0; if (tick % 15 === 0 || tick % 15 === 6 || tick % 15 === 9) T.ecoField += dt; else T.eco += dt; }
  if (tick % 15 === 0) { const t0 = performance.now(); ecosystem.stepSlow(w, ctx); T.slow += performance.now() - t0; }
  w.g.tick++;
}
const [fw, fh] = w.fields.fine;
const gf = { w: fw, h: fh, cs: 1 / 16, wet: s.wetF, uFace: s.uFaceF, vFace: s.vFaceF };
const pp = prepare(gf, { dt: 0.5, kh: P.kh, kz: kzRows(w, s, fh, 1 / 16, 4), ws: P.wP });
console.log(habitat, 'per field pass ms', (T.ecoField / (N / 5)).toFixed(1), 'per plain eco tick ms', (T.eco / (N / 3 - N / 5)).toFixed(2),
  'per slow ms', (T.slow / (N / 15)).toFixed(1), 'avg per tick ms', ((T.eco + T.ecoField + T.slow) / N).toFixed(2), 'fine substeps', pp.sub);
{
  let mu = 0, mi = 0;
  for (let jy = 0; jy < fh; jy++) for (let jx = 0; jx <= fw; jx++) { const v = Math.abs(s.uFaceF[jy * (fw + 1) + jx]!); if (v > mu) { mu = v; mi = jy * (fw + 1) + jx; } }
  let mv = 0, vi = 0;
  for (let k = 0; k < s.vFaceF.length; k++) { const v = Math.abs(s.vFaceF[k]!); if (v > mv) { mv = v; vi = k; } }
  console.log('max fine u flux', mu, 'at', mi % (fw + 1), Math.floor(mi / (fw + 1)), 'speed m/s', mu * 16, 'max v flux', mv, 'at', vi % fw, Math.floor(vi / fw), mv * 16);
  const [cw, ch] = w.fields.coarse;
  let mc = 0; for (let k = 0; k < cw * ch; k++) mc = Math.max(mc, Math.hypot(w.fields.flowU[k]!, w.fields.flowV[k]!));
  console.log('max coarse cell speed', mc, 'hFloor', Array.from(s.hFloor).filter((_, i) => i % 16 === 0).map((v) => v.toFixed(1)).join(" "));
}
