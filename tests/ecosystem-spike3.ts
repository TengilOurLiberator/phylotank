/**
 * Spike 3: evolvability toy (REVIEW §9, CONTRACT 17). Not a vitest file: bundle with esbuild
 * and run with node. Crude bodies (trait vectors with a filter-and-rasp mouth), the real
 * ecosystem module (metabolism, ledger, plankton field, cap fee), budding with point mutation
 * of the trait block in q space, ADULT_LENGTH clamped to the ceiling.
 *
 *   node spike.mjs evolve <mTargetMult> <ticks> <additive|multiplicative> [seed]
 *   node spike.mjs ledger
 */
import { DAY_S, DT, E_B, LIFE, Q_MASS, RNG_STREAM, T, TRAITS, encodeQ, M_REF_1M, LN2 } from '../src/core/index.js';
import { computeMetrics, ecoState, ecosystem, basalPowerW, repairPowerW } from '../src/ecosystem/index.js';
import { makeHarness, traitsQ } from './ecosystem-harness.js';

const mode = process.argv[2] ?? 'evolve';

function evolve(): void {
  const mult = Number(process.argv[3] ?? 1);
  const ticks = Number(process.argv[4] ?? 36000);
  const tax = (process.argv[5] ?? 'additive') as 'additive' | 'multiplicative';
  const seed = Number(process.argv[6] ?? 1);
  const H = makeHarness({ habitat: 'basin', mTargetKg: 100 * mult, seedLo: seed, agentCap: 4096 } as never);
  H.powerFactor = 0.3;
  const s = ecoState(H.world);
  s.capTaxMode = tax;
  const lCeil = H.world.lCeilingM;
  const evolving = ['ADULT_LENGTH', 'SENESCENCE', 'LIFESPAN_MULT', 'SESSILE', 'CLUTCH_SIZE', 'BIRTH_FRACTION', 'GROWTH_RATE',
    'REPRO_RESERVE', 'FAT_CAPACITY', 'BROOD_INTERVAL', 'DIET_PLANT', 'DIET_DETRITUS', 'IMMUNE_INVEST', 'MATURITY_FRACTION'];
  const gen = new Map<number, number>();
  const genAt = (slot: number): number => gen.get(H.world.cr.c.idLo[slot]!) ?? 0;
  const genTimes: { L: number; dt: number }[] = [];
  H.mutate = (pq, childId) => {
    const q = pq.slice();
    const d = H.rng.draw(RNG_STREAM.MUTATION, H.world.g.tick, childId);
    for (const name of evolving) {
      if (d.u01() >= 0.15) continue;
      const i = T[name]!;
      q[i] = Math.max(0, Math.min(65535, Math.round(q[i]! + d.normal() * 0.04 * 65535)));
    }
    const qMax = encodeQ(lCeil, TRAITS[T.ADULT_LENGTH!]!);
    if (q[T.ADULT_LENGTH!]! > qMax) q[T.ADULT_LENGTH!] = qMax;
    return q;
  };
  // founders: 400 across sizes 1 mm .. 5 cm, plant specialists
  const d = H.rng.draw(RNG_STREAM.WORLDGEN, 0, 77);
  for (let i = 0; i < 400; i++) {
    const L = 0.001 * Math.exp(d.u01() * Math.log(50));
    H.spawn({ x: 1.5 + d.u01() * 29, y: 0.4 + d.u01() * 3.5, lengthM: L, species: 1 + Math.floor(Math.log2(L / 0.001)),
      traits: { ADULT_LENGTH: L, DIET_PLANT: 0.95, DIET_DETRITUS: 0.05 }, maturity: 0.7, reserveFrac: 0.25 });
  }
  // track generations: wrap the commit through the births counter by scanning new slots
  const c = H.world.cr.c;
  const known = new Set<number>();
  for (let sl = 0; sl < H.world.cr.highWater; sl++) if (c.life[sl] === LIFE.ALIVE) known.add(c.idLo[sl]!);
  const lastBirth = new Map<number, number>(); // parent id lo -> tick of last birth
  const t0 = performance.now();
  const rows: string[] = [];
  const sample = (): void => {
    const m = computeMetrics(H.world);
    const tr = { SENESCENCE: 0, LIFESPAN_MULT: 0, SESSILE: 0, CLUTCH_SIZE: 0, ADULT_LENGTH: 0 } as Record<string, number>;
    let n = 0, gmax = 0;
    for (let sl = 0; sl < H.world.cr.highWater; sl++) {
      if (c.life[sl] !== LIFE.ALIVE) continue;
      const q = H.traits.get(sl)!;
      n++;
      for (const k of Object.keys(tr)) {
        const sp = TRAITS[T[k]!]!;
        const x = q[T[k]!]! / 65535;
        const v = sp.scale === 'log' ? sp.min * Math.exp(x * Math.log(sp.max / sp.min)) : sp.min + x * (sp.max - sp.min);
        tr[k] = tr[k]! + (k === 'ADULT_LENGTH' ? Math.log10(v) : v);
      }
      gmax = Math.max(gmax, genAt(sl));
    }
    const fmt = (k: string): string => (n > 0 ? (tr[k]! / n).toFixed(3) : '-');
    const spec = m.sizeSpectrum;
    const occupied = spec.counts.map((ct, k) => (ct > 0 ? `${spec.log2MassBins[k]}:${ct}` : '')).filter(Boolean).join(' ');
    rows.push(`| ${(H.world.g.tick * DT / DAY_S).toFixed(2)} | ${m.population} | ${H.births} | ${gmax} | ${spec.maxMassKg.toExponential(2)} | ${fmt('ADULT_LENGTH')} | ${fmt('SENESCENCE')} | ${fmt('LIFESPAN_MULT')} | ${fmt('SESSILE')} | ${fmt('CLUTCH_SIZE')} | ${(m.pools.producersKg).toFixed(1)} | ${m.pools.consumersKg.toFixed(3)} | ${occupied} |`);
  };
  sample();
  let auditFails = 0;
  for (let k = 0; k < ticks; k++) {
    const before = H.world.cr.highWater;
    H.step();
    void before;
    if (H.world.g.tick % 3 === 1) {
      for (let sl = 0; sl < H.world.cr.highWater; sl++) {
        if (c.life[sl] !== LIFE.ALIVE) continue;
        const id = c.idLo[sl]!;
        if (known.has(id)) continue;
        known.add(id);
        // parent = nearest older living creature of the same species within 0.3 m (harness births spawn near the parent)
        let best = -1, bd = 1e9;
        for (let p = 0; p < H.world.cr.highWater; p++) {
          if (p === sl || c.life[p] !== LIFE.ALIVE || c.species[p] !== c.species[sl] || c.birthTick[p]! >= c.birthTick[sl]!) continue;
          const dd = (c.posX[p]! - c.posX[sl]!) ** 2 + (c.posY[p]! - c.posY[sl]!) ** 2;
          if (dd < bd && c.qRepro[p]! >= 0) { bd = dd; best = p; }
        }
        if (best >= 0) {
          const pid = c.idLo[best]!;
          gen.set(id, (gen.get(pid) ?? 0) + 1);
          const since = lastBirth.get(pid) ?? c.birthTick[best]!;
          if (!lastBirth.has(pid)) genTimes.push({ L: c.adultLength[best]!, dt: (H.world.g.tick - c.birthTick[best]!) * DT });
          lastBirth.set(pid, H.world.g.tick);
          void since;
        }
      }
      if (!ecosystem.audit(H.world).ok) auditFails++;
    }
    if (k > 0 && k % Math.floor(ticks / 8) === 0) sample();
  }
  sample();
  const wall = (performance.now() - t0) / 1000;
  const simS = ticks * DT;
  const bins = [[0.0005, 0.002], [0.002, 0.008], [0.008, 0.03], [0.03, 0.13]] as const;
  console.log(`## M_target x${mult} (${100 * mult} kg), ${tax} cap tax, seed ${seed}`);
  console.log(`wall ${wall.toFixed(1)} s for ${simS.toFixed(0)} sim s (${(simS / wall).toFixed(2)}x real time), audit failures ${auditFails}, births ${H.births}`);
  console.log('| size class (adult L) | first-clutch age, sim s (median) | n | generations per sim hour | generations per wall hour at this speed | at 1x |');
  for (const [lo, hi] of bins) {
    const xs = genTimes.filter((g) => g.L >= lo && g.L < hi).map((g) => g.dt).sort((a, b) => a - b);
    if (xs.length === 0) { console.log(`| ${lo * 1000}-${hi * 1000} mm | none | 0 | - | - | - |`); continue; }
    const med = xs[Math.floor(xs.length / 2)]!;
    console.log(`| ${lo * 1000}-${hi * 1000} mm | ${med.toFixed(0)} | ${xs.length} | ${(3600 / med).toFixed(2)} | ${((3600 / med) * (simS / wall)).toFixed(2)} | ${(3600 / med).toFixed(2)} |`);
  }
  console.log('| day | pop | births | max gen | max mass kg | mean log10 L | SENESCENCE | LIFESPAN_MULT | SESSILE | CLUTCH | producers kg | consumers kg | size spectrum (log2 kg bin: count) |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(r);
  const deaths: Record<string, number> = {};
  for (const e of H.events) if (e.k === 'death') deaths[e.cause] = (deaths[e.cause] ?? 0) + 1;
  console.log('deaths by cause', JSON.stringify(deaths), 'cap-tax active fraction', computeMetrics(H.world).capTaxFraction.toFixed(3));
}

/** Microbe and leviathan through one sim day of metabolism: integer ledger vs f64 and f32 references. */
function ledger(): void {
  const H = makeHarness({ habitat: 'open', mTargetKg: 400 } as never);
  H.powerFactor = 0;
  const c = H.world.cr.c;
  const micro = H.spawn({ x: 10, y: 3, lengthM: 0.001, maturity: 1, reserveFrac: 0.3, filter: 0, scrape: 0, traits: { REPRO_RESERVE: 0.9 } });
  // a leviathan: adult length 1 m, set past the ceiling as a flagged release would
  const lev = H.spawn({ x: 20, y: 3, lengthM: 0.2, maturity: 1, reserveFrac: 0.3, filter: 0, scrape: 0, traits: { REPRO_RESERVE: 0.9 } });
  c.adultLength[lev] = 1.0;
  const levMass = M_REF_1M * 0.5 * 0.5 * 0.5;
  c.qTissue[lev] = Math.floor(levMass / Q_MASS); c.qReserve[lev] = Math.floor(0.3 * levMass / Q_MASS);
  H.world.g.mTotalQ += Math.floor(levMass / Q_MASS) + Math.floor(0.3 * levMass / Q_MASS) - 0; // treat as injected
  // remove what spawn had endowed for the leviathan's 0.2 m body from the books by recomputing the total
  let tot = 0; const a = ecosystem.audit(H.world); tot = a.totalQ; H.world.g.mTotalQ = tot;
  const out: string[] = [];
  for (const slot of [micro, lev]) {
    const q0 = c.qReserve[slot]! + c.qTissue[slot]! + c.qRepro[slot]!;
    let ref64 = 0; let ref32 = Math.fround(c.qReserve[slot]! * Q_MASS * E_B); const r32start = ref32;
    const steps = DAY_S / 0.1;
    for (let k = 0; k < steps; k++) {
      const m = (c.qTissue[slot]! + c.qReserve[slot]! + c.qRepro[slot]!) * Q_MASS;
      const B = basalPowerW(m, c.tempC[slot]! || 14, 0.2, 6);
      const P = B + repairPowerW(B, 4);
      ref64 += (P * 0.1) / (Q_MASS * E_B);
      ref32 = Math.fround(ref32 - Math.fround(P * 0.1));
      H.step(3);
    }
    const used = q0 - (c.qReserve[slot]! + c.qTissue[slot]! + c.qRepro[slot]!);
    const r32used = (r32start - ref32) / (Q_MASS * E_B);
    out.push(`| ${slot === micro ? 'microbe 1 mm' : 'leviathan 1 m'} | ${(q0 * Q_MASS).toExponential(3)} | ${used} | ${ref64.toFixed(1)} | ${((used - ref64) / ref64).toExponential(2)} | ${((r32used - ref64) / ref64).toExponential(2)} |`);
  }
  console.log('| body | mass kg | integer ledger burnt (quanta) | f64 reference (quanta) | relative error, integer ledger | relative error, f32 energy stock |');
  console.log('|---|---|---|---|---|---|');
  for (const r of out) console.log(r);
  console.log('audit ok', ecosystem.audit(H.world).ok, 'ln2', LN2.toFixed(3));
}

if (mode === 'ledger') ledger(); else evolve();
