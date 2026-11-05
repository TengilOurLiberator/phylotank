/**
 * src/brain: the body-anchored substrate, I/O channel layout, brain development (direct and
 * CPPN encodings), class pools, perception (sense), the CTRNN and oscillator tick (think),
 * and inspector data. CONTRACT 5.3, 6.7, 8. See README.md and docs/modules/brain.md.
 */
import {
  BRAIN_CLASSES, BRAIN_COST_NEURON_W, BRAIN_COST_PLASTIC_W, BRAIN_COST_SYNAPSE_W, NONE_U32, RNG_STREAM, RngStreams,
  type BrainLayout, type BrainModule, type Genome, type Phenotype, type StepContext, type World,
} from '../core/index.js';
import { developBrain, type BrainSpec } from './develop.js';
import { layout as layoutOf } from './layout.js';
import { brainState, freeBrain, freeSlot, makeStatic, writeBrain } from './pool.js';
import { sense } from './sense.js';
import { think } from './think.js';

export { developBrain, type BrainSpec } from './develop.js';
export { buildLayout, IN, OUT, DRIVE, MOD, STYPE, type FullLayout } from './layout.js';
export { compileCppn, evalCppn, hash64, cppnInputId, cppnOutputId, CPPN_IN, CPPN_OUT, CPPN_N_IN } from './cppn.js';
export { brainState } from './pool.js';
export { tickBrain, actBrain } from './think.js';
export { inspect, type InspectFrame } from './inspect.js';
export { behaviourTemplate, applyBehaviourTemplate } from './templates.js';
export { BehaviourTracker, type BehaviourLabel, type BehaviourSample } from './classify.js';

/** Smallest size class that fits N non-input neurons and I inputs, or -1 (CONTRACT 8.2). */
export function sizeClassFor(nNeurons: number, nInputs: number): number {
  for (let c = 0; c < BRAIN_CLASSES.length; c++) {
    const k = BRAIN_CLASSES[c]!;
    if (nNeurons <= k.n && nInputs <= k.i) return c;
  }
  return -1;
}

/** Brain running cost in W (CONTRACT 8.5). */
export function brainCostW(neurons: number, synapses: number, plastic: number): number {
  return BRAIN_COST_NEURON_W * neurons + BRAIN_COST_SYNAPSE_W * synapses + BRAIN_COST_PLASTIC_W * plastic;
}

function entityIdOf(world: World, slot: number): number {
  return world.cr.c.idLo[slot]! + world.cr.c.idHi[slot]! * 4294967296;
}

/**
 * The individuality draw: stream DEVELOPMENT, counter tick = the creature's birth tick, subject =
 * its entity id. Keyed by birth rather than the allocation tick so `rehydrate` reproduces it.
 */
function individualityDraw(world: World, slot: number) {
  return new RngStreams(world.g.seedLo, world.g.seedHi).draw(RNG_STREAM.DEVELOPMENT, world.cr.c.birthTick[slot]!, entityIdOf(world, slot));
}

/**
 * Put a developed brain into the smallest class pool with a free slot, starting at its own class
 * (a full class sends it to the next larger one, CONTRACT 5.3). Returns false if all are full.
 */
export function install(world: World, slot: number, ph: Phenotype, g: Genome, spec: BrainSpec): boolean {
  for (let c = spec.cls; c < world.brains.length; c++) {
    const s = freeSlot(world.brains[c]!);
    if (s < 0) continue;
    const st = makeStatic(world, slot, ph, g, spec);
    writeBrain(world, c, s, slot, spec, st);
    const cr = world.cr.c;
    cr.brainClass[slot] = c;
    cr.brainSlot[slot] = s;
    cr.brainW[slot] = brainCostW(spec.L.nNeurons, spec.nSyn, spec.nPlastic);
    return true;
  }
  return false;
}

/**
 * Rebuild the derived brain-side state of a creature whose pool slot was restored from a
 * snapshot (the pool columns are authoritative; only the static descriptors are recomputed).
 */
export function rehydrate(world: World, slot: number, ph: Phenotype, g: Genome): void {
  const c = world.cr.c.brainClass[slot]!;
  const s = world.cr.c.brainSlot[slot]!;
  if (c === 255 || s === NONE_U32) return;
  const spec = developBrain(ph, g, { draw: individualityDraw(world, slot) });
  brainState(world).statics[c]![s] = makeStatic(world, slot, ph, g, spec);
}

export const brain: BrainModule = {
  layout(ph: Phenotype, g: Genome): BrainLayout {
    return layoutOf(ph, g);
  },
  allocate(world: World, slot: number, ph: Phenotype, g: Genome, ctx: StepContext): boolean {
    if (world.cr.c.brainSlot[slot] !== NONE_U32) freeBrain(world, slot);
    void ctx;
    return install(world, slot, ph, g, developBrain(ph, g, { draw: individualityDraw(world, slot) }));
  },
  free(world: World, slot: number) {
    freeBrain(world, slot);
  },
  sense(world, ctx) {
    sense(world, ctx);
  },
  think(world, ctx) {
    think(world, ctx);
  },
};
