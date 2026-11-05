/**
 * src/genome: development (genome to Phenotype), mutation, crossover, repair, distance,
 * templates, species assignment, the innovation registry and the genome store.
 * CONTRACT 3.3, 6, 7. See README.md and docs/modules/genome.md.
 *
 * The binary format itself lives in src/core/genome-format.ts (it is contract).
 */
import type {
  BirthEnv, DevelopOptions, Genome, GenomeModule, MutationContext, Phenotype, TemplateId,
} from '../core/index.js';
import { crossoverWith } from './crossover.js';
import { develop } from './develop.js';
import { distance } from './distance.js';
import { mutateWith } from './mutate.js';
import { InnovationRegistry } from './registry.js';
import { repair } from './repair.js';
import { templateGenome } from './templates.js';

export * from './constants.js';
export { blankGenome } from './blank.js';
export { clampToCeiling, expressedAdultLength, isLeviathan } from './ceiling.js';
export {
  develop, unfold, finish, Restager, adultLength, lengthAtMaturity, regShape, decodeKindParams,
  ABSORB_FRACTION, MAX_RAW_PARTS, type Unfolded,
} from './develop.js';
export { mutateWith, duplicateModule, paralogCount, countGenes, poisson, pickOperator, applyOperator, type MutateStats, type OpName } from './mutate.js';
export { crossoverWith } from './crossover.js';
export { repair, repairInPlace } from './repair.js';
export { distance, distanceParts, bodyPlanDescriptor, descriptorDistance, DIST_TRAITS, DIST_BRAIN_TRAITS } from './distance.js';
export { InnovationRegistry, eventKey, EVENT, type RegistryState } from './registry.js';
export { templateGenome, TEMPLATE_NAMES, TEMPLATE_INNOV_BASE, type TemplateName } from './templates.js';
export { makeModule, makeLink, makeReg, kindDefaults, type ModSpec, type LinkSpec } from './kinds.js';
export { cloneGenome, expressedSets, trait, setTrait, brainTrait, setBrainTrait } from './genes.js';
export { lifeHistory, type LifeHistory } from './life.js';
export { SpeciesRegistry, type SpeciesRecord, type SpeciesEvent, type AssignInput, type SpeciesOptions } from './species.js';
export { binomialFor, commonNameFor, isPronounceable, type Binomial } from './names.js';
export { GenomeStore } from './store.js';

export const TEMPLATE_IDS: readonly TemplateId[] = [
  'meadowlamp', 'hushmaw', 'sievebell', 'tetherling', 'ashpicker', 'deepcrown', 'motefly', 'blank',
];

/**
 * A GenomeModule bound to one world's innovation registry. The sim creates one per world and
 * saves `registry.save()` with snapshots (contract request 2: put the registry in MutationContext).
 */
export function createGenomeModule(registry = new InnovationRegistry()): GenomeModule & { readonly registry: InnovationRegistry } {
  return {
    registry,
    develop(g: Genome, maturity: number, env: BirthEnv, opts: DevelopOptions): Phenotype {
      return develop(g, maturity, env, opts);
    },
    mutate(g: Genome, ctx: MutationContext): Genome {
      const reg = (ctx as MutationContext & { registry?: InnovationRegistry }).registry ?? registry;
      return mutateWith(g, ctx, reg);
    },
    crossover(bearer: Genome, donor: Genome, ctx: MutationContext): Genome { return crossoverWith(bearer, donor, ctx); },
    repair(g: Genome): Genome { return repair(g); },
    distance(a: Genome, b: Genome): number { return distance(a, b); },
    template(id: TemplateId): Genome { return templateGenome(id); },
  };
}

/** The default module instance (one registry per process; worlds should use createGenomeModule). */
export const genome = createGenomeModule();
export { enzymes, lookOf, packedColour, type Look } from './look.js';
export { Phylogeny, type PhyloNode } from './phylogeny.js';
export { diffEncode, diffDecode } from './diff.js';

/**
 * A birth's genome operators in the contract order (CONTRACT 9.6): crossover with the donor when
 * there is one (structure and the leviathan flag from the bearer), then mutation. Both draw from
 * streams keyed by the child's entity id, so the batch order of births does not matter.
 */
export function breed(mod: GenomeModule, bearer: Genome, donor: Genome | null, ctx: MutationContext): Genome {
  return mod.mutate(donor ? mod.crossover(bearer, donor, ctx) : bearer, ctx);
}
