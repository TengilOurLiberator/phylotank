/**
 * The contract test (review R1): constants in src/core agree with docs/CONTRACT.md, and every
 * trait or brain trait referenced by name anywhere in src exists in the genome schema.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as C from '../src/core/index.js';

const root = join(__dirname, '..');
const doc = readFileSync(join(root, 'docs/CONTRACT.md'), 'utf8');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

describe('CONTRACT.md and src/core agree', () => {
  it('units and clocks', () => {
    expect(doc).toContain('`Q_MASS = 1e-12 kg`');
    expect(C.Q_MASS).toBe(1e-12);
    expect(C.MAX_WORLD_MASS_KG).toBeCloseTo(9007, 0);
    expect(doc).toMatch(/`TICK_HZ` † \| 30 \|/);
    expect(C.TICK_HZ).toBe(30);
    for (const [name, v] of [['ECO_EVERY', 3], ['SLOW_EVERY', 15], ['HASH_EVERY', 256], ['GOVERNOR_EVERY', 300], ['DAY_S', 1200], ['YEAR_DAYS', 20]] as const) {
      expect(doc).toMatch(new RegExp('`' + name + '` † \\| ' + v + ' \\|'));
      expect((C as unknown as Record<string, number>)[name]).toBe(v);
    }
    expect(C.E_B).toBe(4000);
    expect(doc).toContain('`E_B = 4000 J/kg` †');
  });
  it('tank presets', () => {
    for (const p of Object.values(C.PRESETS)) {
      const name = p.name[0]!.toUpperCase() + p.name.slice(1);
      const row = doc.split('\n').find((l) => l.startsWith(`| ${name} |`))!;
      expect(row, name).toBeDefined();
      const cells = row.split('|').map((s) => s.trim());
      expect(cells[2]).toBe(`${p.widthM} x ${p.heightM}`);
      expect(cells[3]).toBe(`${p.coarse[0]} x ${p.coarse[1]}`);
      expect(cells[4]).toBe(`${p.fine[0]} x ${p.fine[1]}`);
      expect(cells[5]).toBe(`${p.sdf[0]} x ${p.sdf[1]}`);
      expect(Number(cells[6]!.replace(/,/g, ''))).toBe(p.agentCap);
      expect(Number(cells[7]!.replace(/,/g, ''))).toBe(p.cpuAgentCap);
      expect(Number(cells[8]!.replace(/,/g, ''))).toBe(p.mTargetKg);
      expect(cells[9]).toBe(`${p.lCeilingM} m`);
      // ceiling rule: 0.2 m * (M / 400)^(1/3), to the millimetre
      expect(p.lCeilingM).toBeCloseTo(Math.round(200 * Math.cbrt(p.mTargetKg / 400)) / 1000, 6);
    }
  });
  it('size range, leviathans, ledger constants', () => {
    expect([C.L_MIN, C.L_MAX, C.K_ENDOW, C.SEG_PER_AGENT, C.GENOME_MAX_BYTES, C.MAX_PARTS]).toEqual([0.0005, 1, 8, 12, 16384, 64]);
    expect(doc).toContain('`K_ENDOW = 8`');
    expect(doc).toContain('`C_G = 1.4`');
    expect(doc).toContain('`C_REP = 0.05`');
    expect([C.C_G, C.C_REP, C.B0_KLEIBER, C.E_A_EV, C.KLEIBER_EXP]).toEqual([1.4, 0.05, 0.3, 0.65, 0.75]);
    expect([C.NU_WATER, C.RHO_WATER, C.GRAVITY]).toEqual([2e-5, 1025, 9.81]);
  });
  it('brain classes and global I/O channel order', () => {
    for (const [i, k] of C.BRAIN_CLASSES.entries()) {
      expect(doc).toContain(`| C${i} | ${k.n} | ${k.i} | ${k.k} |`);
    }
    C.INPUT_GLOBAL.forEach((name, i) => expect(doc).toContain(`| ${i} | ${name} |`));
    C.OUTPUT_GLOBAL.forEach((name, i) => expect(doc).toContain(`| ${i} | ${name} |`));
  });
  it('protocol frame codes', () => {
    expect(C.PROTOCOL_VERSION).toBe(0x0100);
    for (const [name, code] of Object.entries(C.FRAME)) {
      expect(doc).toContain(`| 0x${code.toString(16).padStart(2, '0')} | ${name} |`);
    }
  });
  it('power ids', () => {
    const line = doc.split('\n').find((l) => l.startsWith('`PowerId`'))!;
    for (const p of C.POWER_IDS) expect(line).toContain(p);
    expect(C.CORE_POWERS).toHaveLength(12);
  });
  it('trait table rows match the schema', () => {
    for (const s of C.TRAITS) {
      if (!s) continue;
      const row = doc.split('\n').find((l) => l.startsWith(`| ${s.idx} | ${s.name} `));
      if (row) {
        const cells = row.split('|').map((x) => x.trim());
        expect(Number(cells[3]), s.name).toBe(s.min);
        expect(Number(cells[4]), s.name).toBe(s.max);
      } else {
        // grouped rows such as "| 28 to 31 | BODY_HUE, ..."
        expect(doc, s.name).toContain(s.name);
      }
    }
    for (const s of C.BRAIN_TRAITS) if (s) expect(doc.includes(s.name) || /RULE|DRIVE|REFLEX/.test(s.name), s.name).toBe(true);
  });
  it('record sizes and section caps', () => {
    for (const r of [C.MODULE_RECORD, C.LINK_RECORD, C.REG_RECORD, C.CPPN_NODE_RECORD, C.CPPN_CONN_RECORD, C.HIDDEN_NEURON_RECORD, C.DIRECT_SYNAPSE_RECORD]) {
      const row = doc.split('\n').find((l) => l.startsWith(`| \`${r.tag}\` |`))!;
      expect(row, r.tag).toBeDefined();
      const cells = row.split('|').map((x) => x.trim());
      expect(Number(cells[3])).toBe(r.size);
      expect(Number(cells[4])).toBe(r.max);
      const last = r.fields[r.fields.length - 1]!;
      expect(last.off + ({ u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, u64: 8 })[last.type]).toBeLessThanOrEqual(r.size);
    }
  });
});

describe('every gene referenced by name exists (review R1 contract test)', () => {
  it('T.* and BT.* references resolve', () => {
    const missing: string[] = [];
    for (const f of files(join(root, 'src'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/\bT\.([A-Z][A-Z0-9_]+)/g)) if (C.T[m[1]!] === undefined) missing.push(`${f}: T.${m[1]}`);
      for (const m of src.matchAll(/\bBT\.([A-Z][A-Z0-9_]+)/g)) if (C.BT[m[1]!] === undefined) missing.push(`${f}: BT.${m[1]}`);
    }
    expect(missing).toEqual([]);
  });
});
