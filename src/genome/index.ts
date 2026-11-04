/**
 * src/genome: development (genome to Phenotype), mutation, crossover, repair, distance,
 * templates, species assignment, the innovation registry and the genome store.
 * CONTRACT 3.3, 6, 7. See README.md.
 *
 * The binary format itself lives in src/core/genome-format.ts (it is contract). Phase 0
 * provides the Blank template and typed stubs for everything else.
 */
import {
  defaultRecord, emptyGenome, GENOME_FLAG_LEVIATHAN, KIND, MODULE_FLAG, MODULE_RECORD, NotImplementedError,
  SEGMENT_SUBTYPE, T, TRAITS, decodeQ, encodeQ,
  type BirthEnv, type DevelopOptions, type Genome, type GenomeModule, type ModuleGene, type MutationContext,
  type Phenotype, type TemplateId,
} from '../core/index.js';

/** First innovation id outside the reserved template range (CONTRACT 6.8). */
export const FIRST_FREE_INNOV = 4096;
export const TEMPLATE_IDS: readonly TemplateId[] = [
  'meadowlamp', 'hushmaw', 'sievebell', 'tetherling', 'ashpicker', 'deepcrown', 'motefly', 'blank',
];

/** Blank: a single head segment with default traits. */
export function blankGenome(): Genome {
  const g = emptyGenome();
  const head = defaultRecord<ModuleGene>(MODULE_RECORD);
  head.innov = 1;
  head.kind = KIND.SEGMENT;
  head.subtype = SEGMENT_SUBTYPE.HEAD;
  head.flags = MODULE_FLAG.ENABLED | MODULE_FLAG.ROOT;
  head.length = 32768;
  head.width = 40000;
  head.span = 128;
  head.muscleFraction = 64;
  head.gutFraction = 64;
  g.modules = [head];
  g.rootModuleInnov = head.innov;
  return g;
}

/** Expressed adult length after the world ceiling (CONTRACT 3.3). */
export function expressedAdultLength(g: Genome, lCeilingM: number): number {
  const L = decodeQ(g.traits[T.ADULT_LENGTH!]!, TRAITS[T.ADULT_LENGTH!]!);
  return (g.flags & GENOME_FLAG_LEVIATHAN) !== 0 ? L : Math.min(L, lCeilingM);
}

/** Clamp the stored ADULT_LENGTH q to the ceiling unless the genome is a leviathan (CONTRACT 3.3). */
export function clampToCeiling(g: Genome, lCeilingM: number): void {
  if ((g.flags & GENOME_FLAG_LEVIATHAN) !== 0) return;
  const spec = TRAITS[T.ADULT_LENGTH!]!;
  const qMax = encodeQ(lCeilingM, spec);
  if (g.traits[T.ADULT_LENGTH!]! > qMax) g.traits[T.ADULT_LENGTH!] = qMax;
}

export const genome: GenomeModule = {
  develop(g: Genome, maturity: number, env: BirthEnv, opts: DevelopOptions): Phenotype {
    void g; void maturity; void env; void opts;
    throw new NotImplementedError('genome.develop');
  },
  mutate(g: Genome, ctx: MutationContext): Genome {
    void g; void ctx;
    throw new NotImplementedError('genome.mutate');
  },
  crossover(bearer: Genome, donor: Genome, ctx: MutationContext): Genome {
    void bearer; void donor; void ctx;
    throw new NotImplementedError('genome.crossover');
  },
  repair(g: Genome): Genome {
    void g;
    throw new NotImplementedError('genome.repair');
  },
  distance(a: Genome, b: Genome): number {
    void a; void b;
    throw new NotImplementedError('genome.distance');
  },
  template(id: TemplateId): Genome {
    if (id === 'blank') return blankGenome();
    throw new NotImplementedError(`genome.template(${id})`);
  },
};
