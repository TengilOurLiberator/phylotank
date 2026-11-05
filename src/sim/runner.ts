/**
 * Headless runner (the Node runner and tests): run a world for N ticks with optional exact
 * ledger audits and hash checkpoints, and summarise. Pure sim code: no clock, no I/O, so it
 * runs the same in Node, a worker or a test. The host CLI (`--headless`) and benchmarks wrap
 * it and add the timing.
 */
import { ECO_EVERY, LIFE, toHex64, type SimCore, type SimEvent, type World, type WorldConfig } from '../core/index.js';
import { drainEvents, sim as defaultSim, stateDigest, stateOf } from './index.js';

export interface RunOptions {
  ticks: number;
  /** Audit the ledger every this many ecology ticks (1 = every ecology tick; 0 = only at the end). */
  auditEvery?: number;
  /** Called for every batch of events drained after a tick. */
  onEvents?: (events: SimEvent[], world: World) => void;
  /** Called every `sampleEvery` ticks. */
  onSample?: (world: World) => void;
  sampleEvery?: number;
  core?: SimCore;
}

export interface RunSummary {
  ticks: number;
  hash: string;
  digest: string;
  audits: number;
  auditFailures: { tick: number; totalQ: number; expectedQ: number }[];
  births: number;
  buds: number;
  sexBirths: number;
  deaths: Record<string, number>;
  speciations: number;
  extinctions: number;
  live: number;
  carcasses: number;
  peakLive: number;
  maxGeneration: number;
  speciesAlive: number;
  deferredBirths: number;
  highWater: number;
  nextEntityId: number;
}

export function runHeadless(configOrWorld: WorldConfig | World, opts: RunOptions): { world: World; summary: RunSummary } {
  const core = opts.core ?? defaultSim;
  const world = 'g' in configOrWorld ? configOrWorld : core.create(configOrWorld);
  const ecosystem = stateOf(world).modules.ecosystem;
  const auditEvery = opts.auditEvery ?? 1;
  const gen = new Map<number, number>();
  const s: RunSummary = {
    ticks: 0, hash: '', digest: '', audits: 0, auditFailures: [], births: 0, buds: 0, sexBirths: 0, deaths: {},
    speciations: 0, extinctions: 0, live: 0, carcasses: 0, peakLive: world.g.liveCount, maxGeneration: 0,
    speciesAlive: 0, deferredBirths: 0, highWater: 0, nextEntityId: 0,
  };
  const audit = (): void => {
    const a = ecosystem.audit(world);
    s.audits++;
    if (!a.ok) s.auditFailures.push({ tick: world.g.tick, totalQ: a.totalQ, expectedQ: a.expectedQ });
  };
  let eco = 0;
  for (let i = 0; i < opts.ticks; i++) {
    const t = world.g.tick;
    core.step(world);
    const ev = drainEvents(world);
    for (const e of ev) {
      if (e.k === 'birth') {
        s.births++;
        if (e.mode === 'bud') s.buds++; else s.sexBirths++;
        const g = 1 + Math.max(...e.parents.map((p) => gen.get(p) ?? 0));
        gen.set(e.id, g);
        if (g > s.maxGeneration) s.maxGeneration = g;
      } else if (e.k === 'death') {
        s.deaths[e.cause] = (s.deaths[e.cause] ?? 0) + 1;
        gen.delete(e.id);
      } else if (e.k === 'speciation') s.speciations++;
      else if (e.k === 'extinction') s.extinctions++;
    }
    if (ev.length > 0) opts.onEvents?.(ev, world);
    if (world.g.liveCount > s.peakLive) s.peakLive = world.g.liveCount;
    if (t % ECO_EVERY === 0) {
      eco++;
      if (auditEvery > 0 && eco % auditEvery === 0) audit();
    }
    if (opts.onSample && opts.sampleEvery && world.g.tick % opts.sampleEvery === 0) opts.onSample(world);
  }
  audit();
  const c = world.cr.c;
  let carcasses = 0;
  for (let k = 0; k < world.cr.highWater; k++) if (c.life[k] === LIFE.CARCASS) carcasses++;
  const st = stateOf(world);
  Object.assign(s, {
    ticks: opts.ticks, hash: toHex64(core.hash(world)), digest: toHex64(stateDigest(world)), live: world.g.liveCount,
    carcasses, speciesAlive: st.species.living().length, deferredBirths: st.deferredBirths, highWater: world.cr.highWater,
    nextEntityId: world.g.nextEntityId,
  });
  return { world, summary: s };
}
