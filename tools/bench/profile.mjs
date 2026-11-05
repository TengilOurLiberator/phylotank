#!/usr/bin/env node
// Summarise a .cpuprofile: top functions by self time and by total (inclusive) time.
//   node tools/bench/profile.mjs <file.cpuprofile> [top=30] [filter-substring]
import { readFileSync } from 'node:fs';

const [file, topArg, filter] = process.argv.slice(2);
const top = Number(topArg ?? 30);
const prof = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const dt = new Map();
for (let i = 0; i < prof.samples.length; i++) dt.set(prof.samples[i], (dt.get(prof.samples[i]) ?? 0) + (prof.timeDeltas[i] ?? 0));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const label = (n) => {
  const cf = n.callFrame;
  const url = cf.url.replace(/^.*\/(src|tools|node_modules)\//, '$1/');
  return `${cf.functionName || '(anon)'} ${url}:${cf.lineNumber + 1}`;
};
const self = new Map(), total = new Map();
let all = 0;
for (const n of prof.nodes) {
  const t = dt.get(n.id) ?? 0;
  all += t;
  const k = label(n);
  self.set(k, (self.get(k) ?? 0) + t);
  // inclusive: add to each distinct ancestor label once
  const seen = new Set();
  for (let id = n.id; id !== undefined; id = parent.get(id)) {
    const kk = label(byId.get(id));
    if (seen.has(kk)) continue;
    seen.add(kk);
    total.set(kk, (total.get(kk) ?? 0) + t);
  }
}
const show = (m, title) => {
  console.log(`\n${title} (of ${(all / 1e3).toFixed(0)} ms sampled)`);
  [...m.entries()].filter(([k]) => !filter || k.includes(filter)).sort((a, b) => b[1] - a[1]).slice(0, top)
    .forEach(([k, t]) => console.log(`${(t / 1e3).toFixed(0).padStart(8)} ms ${(100 * t / all).toFixed(1).padStart(5)}%  ${k}`));
};
show(self, 'self time');
show(total, 'total time');

// hot lines of the functions whose label contains the filter (needs a filter)
if (filter) {
  const lines = new Map();
  for (const n of prof.nodes) {
    if (!label(n).includes(filter)) continue;
    for (const pt of n.positionTicks ?? []) {
      const k = `${n.callFrame.url.replace(/^.*\//, '')}:${pt.line}`;
      lines.set(k, (lines.get(k) ?? 0) + pt.ticks);
    }
  }
  const tot = [...lines.values()].reduce((a, b) => a + b, 0);
  console.log(`\nhot lines in "${filter}" (${tot} ticks)`);
  [...lines.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).forEach(([k, t]) => console.log(`${String(t).padStart(7)} ${(100 * t / tot).toFixed(1).padStart(5)}%  ${k}`));
}
