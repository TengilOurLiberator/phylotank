/**
 * Local fallback BrainModule (phase 1): an innate wander-and-graze reflex with no neuron
 * pools, so the pipeline runs while src/brain builds the CTRNN. Replaced through
 * `createSim({ brain })`.
 *
 * think writes the global outputs (CONTRACT 8.2): CPG_AMP from ACTIVITY and hunger, CPG_TURN
 * a wander that changes every 16 ticks (stream BRAIN_NOISE keyed by the entity id), steered
 * towards PREF_DEPTH; EMIT_INTENSITY a slow pulse at PULSE_FREQ. The cost is a fixed
 * `brainW` per creature (8.5 with the C0 minimum of 16 neurons and 128 synapses).
 */
import {
  BT, clamp, decodeQ, BRAIN_TRAITS, DT, LIFE, RNG_STREAM, sin, TAU, type BrainLayout, type BrainModule,
  type Genome, type Phenotype, type StepContext, type World,
} from '../../core/index.js';
import { brainCostW } from '../../brain/index.js';

const WANDER_EVERY = 16;

/** Per-slot cached behaviour traits (decoded once at allocate). */
interface Traits { activity: Float32Array; prefDepth: Float32Array; explore: Float32Array }
const cache = new WeakMap<World, Traits>();
function traitsOf(world: World): Traits {
  let t = cache.get(world);
  if (!t) {
    const n = world.cr.capacity;
    t = { activity: new Float32Array(n), prefDepth: new Float32Array(n), explore: new Float32Array(n) };
    cache.set(world, t);
  }
  return t;
}

function bt(g: Genome, idx: number): number { return decodeQ(g.brainTraits[idx]!, BRAIN_TRAITS[idx]!); }

export const fallbackBrain: BrainModule = {
  layout(ph: Phenotype, g: Genome): BrainLayout {
    void ph; void g;
    return { inputs: [], outputs: [], nNeurons: 16, neuronKind: new Uint8Array(16), neuronKey: new Uint32Array(16), sizeClass: 0 };
  },
  allocate(world: World, slot: number, ph: Phenotype, g: Genome, ctx: StepContext): boolean {
    void ph; void ctx;
    const t = traitsOf(world);
    t.activity[slot] = 0.3 + 0.7 * bt(g, BT.ACTIVITY!);
    t.prefDepth[slot] = bt(g, BT.PREF_DEPTH!);
    t.explore[slot] = bt(g, BT.EXPLORATION!);
    world.cr.c.brainW[slot] = brainCostW(16, 128, 0);
    world.cr.c.brainClass[slot] = 255; // no pool in the fallback
    return true;
  },
  free(world: World, slot: number) {
    world.cr.c.brainW[slot] = 0;
    world.cr.c.brainClass[slot] = 255;
  },
  sense() { /* the reflex reads the creature columns directly */ },
  think(world: World, ctx: StepContext) {
    const c = world.cr.c;
    const t = traitsOf(world);
    const H = world.preset.heightM;
    const stream = ctx.rng.stream(RNG_STREAM.BRAIN_NOISE);
    const block = new Uint32Array(4);
    for (let s = 0; s < world.cr.highWater; s++) {
      if (c.life[s] !== LIFE.ALIVE || c.segCount[s] === 0) continue;
      const o = s * 8;
      if ((ctx.tick + s) % WANDER_EVERY === 0) {
        stream.block(ctx.tick, c.idHi[s]! * 4294967296 + c.idLo[s]!, 0, block);
        const wander = (block[0]! / 4294967296) * 2 - 1;
        // steer towards the preferred depth: heading sine is the vertical component
        const depth01 = (c.posY[s]! - world.g.ySurface) / H;
        const wantDown = clamp((t.prefDepth[s]! - depth01) * 4, -1, 1);
        const sh = sin(c.heading[s]!);
        c.out[o + 2] = clamp(wander * (0.3 + 3 * t.explore[s]!) + 0.5 * (wantDown - sh), -1, 1);
        const hunger = 1 - clamp(c.qReserve[s]! / (0.3 * c.qTissue[s]! + 1), 0, 1);
        c.out[o + 1] = clamp(t.activity[s]! * (0.5 + 0.5 * hunger), 0, 1);
      }
      const phase = ((ctx.tick * DT * 0.3 + s * 0.618) % 1) * TAU;
      c.out[o + 5] = 0.5 + 0.5 * sin(phase);
    }
  },
};
