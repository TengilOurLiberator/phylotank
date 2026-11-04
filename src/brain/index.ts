/**
 * src/brain: the body-anchored substrate, I/O channel layout, brain development (direct and
 * CPPN encodings), class pools, perception (sense), the CTRNN and oscillator tick (think),
 * and inspector data. CONTRACT 5.3, 6.7, 8. See README.md.
 *
 * Phase 0: typed stubs. sense and think are no-ops while no creature has a brain.
 */
import {
  BRAIN_CLASSES, BRAIN_COST_NEURON_W, BRAIN_COST_PLASTIC_W, BRAIN_COST_SYNAPSE_W, NONE_U32, NotImplementedError,
  type BrainLayout, type BrainModule, type Genome, type Phenotype, type StepContext, type World,
} from '../core/index.js';

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

function anyBrains(world: World): boolean {
  const slot = world.cr.c.brainSlot;
  for (let s = 0; s < world.cr.highWater; s++) if (slot[s] !== NONE_U32) return true;
  return false;
}

export const brain: BrainModule = {
  layout(ph: Phenotype, g: Genome): BrainLayout {
    void ph; void g;
    throw new NotImplementedError('brain.layout');
  },
  allocate(world: World, slot: number, ph: Phenotype, g: Genome, ctx: StepContext): boolean {
    void world; void slot; void ph; void g; void ctx;
    throw new NotImplementedError('brain.allocate');
  },
  free(world: World, slot: number) {
    world.cr.c.brainSlot[slot] = NONE_U32;
    world.cr.c.brainClass[slot] = 255;
  },
  sense(world, ctx) {
    void ctx;
    if (anyBrains(world)) throw new NotImplementedError('brain.sense');
  },
  think(world, ctx) {
    void ctx;
    if (anyBrains(world)) throw new NotImplementedError('brain.think');
  },
};
