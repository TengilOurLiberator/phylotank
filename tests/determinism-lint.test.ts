/** CONTRACT 4.2 rules 2 and 3: banned identifiers in deterministic sim code. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const SIM_DIRS = ['src/core', 'src/genome', 'src/physics', 'src/brain', 'src/ecosystem', 'src/sim'];
/** Files that pace or transport the sim but never compute it. */
const EXEMPT = new Set(['src/sim/pacer.ts', 'src/sim/worker.ts', 'src/sim/client.ts']);
const BANNED: [RegExp, string][] = [
  [/\bMath\.random\b/, 'Math.random'],
  [/\bDate\.now\b|\bnew Date\b/, 'Date'],
  [/\bperformance\.now\b/, 'performance.now'],
  [/\bset(Timeout|Interval|Immediate)\b/, 'timers'],
  [/\bcrypto\.(getRandomValues|randomUUID)\b/, 'crypto randomness'],
  [/\bMath\.(sin|cos|tan|exp|log|pow|atan|atan2|tanh|sinh|cosh|asin|acos|hypot|cbrt|expm1|log1p|log2|log10)\b/, 'platform transcendental (use core/dmath)'],
  [/\.sort\(\s*\)/, 'sort without a comparator'],
];

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('determinism lint', () => {
  it('sim code uses no wall clock, platform randomness or platform transcendentals', () => {
    const hits: string[] = [];
    for (const d of SIM_DIRS) {
      for (const f of files(join(root, d))) {
        const rel = relative(root, f).replace(/\\/g, '/');
        if (EXEMPT.has(rel) || rel.endsWith('.test.ts')) continue;
        const lines = stripComments(readFileSync(f, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          for (const [re, what] of BANNED) if (re.test(line)) hits.push(`${rel}:${i + 1} ${what}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
