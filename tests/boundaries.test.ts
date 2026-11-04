/** CONTRACT 16: a module may import only from the modules in its "may import" column. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const ALLOWED: Record<string, string[]> = {
  core: [],
  genome: ['core'],
  physics: ['core', 'genome'],
  brain: ['core', 'genome'],
  ecosystem: ['core', 'genome'],
  sim: ['core', 'genome', 'physics', 'brain', 'ecosystem'],
  render: ['core', 'genome'],
  director: ['core'],
  audio: ['core'],
  ui: ['core', 'genome', 'render', 'director', 'audio', 'sim/client'],
  host: ['core', 'genome', 'sim'],
  web: ['ui', 'core'],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}
function moduleOf(abs: string): string | null {
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('web/')) return 'web';
  const m = /^src\/([^/]+)\//.exec(rel);
  return m ? m[1]! : null;
}

describe('module boundaries', () => {
  it('imports respect CONTRACT 16', () => {
    const bad: string[] = [];
    for (const f of [...files(join(root, 'src')), ...files(join(root, 'web'))]) {
      const from = moduleOf(f);
      if (!from) continue;
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/(?:import|export)[^'"]*?from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]!;
        if (!spec.startsWith('.')) {
          if (spec.startsWith('node:') && !['host'].includes(from) && !f.endsWith('.test.ts')) bad.push(`${relative(root, f)} imports ${spec}`);
          continue;
        }
        const target = resolve(dirname(f), spec);
        const to = moduleOf(target);
        if (!to || to === from) continue;
        const relTarget = relative(join(root, 'src'), target).replace(/\\/g, '/').replace(/\.js$/, '');
        const ok = ALLOWED[from]!.some((a) => a === to || relTarget === a);
        if (!ok) bad.push(`${relative(root, f)} (${from}) imports ${spec} (${to})`);
      }
    }
    expect(bad).toEqual([]);
  });
});
