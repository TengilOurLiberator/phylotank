/**
 * The share page's built-in example creature, an original design made for this page:
 * Vitrilampas demonstrata, the "example glassdart". It is built from the Blank template's
 * head with plain ModuleGene and LinkGene records (CONTRACT 6.4, 6.5), so it stays valid
 * whatever the genome module's templates turn out to be. CC0, like every Phylotank design.
 */
import {
  defaultRecord, encodeGenome, encodePtkg, encodeQ, KIND, LINK_FLAG, LINK_RECORD, MODULE_FLAG, MODULE_RECORD,
  PTKG_KIND, SEGMENT_SUBTYPE, SYMMETRY, T, toPtkString, TRAITS, GENOME_FORMAT_VERSION,
  type Genome, type LinkGene, type ModuleGene,
} from '../../src/core/index.js';
import { blankGenome } from '../../src/genome/index.js';
import { designMeta } from './ptk.js';

const setTrait = (g: Genome, name: string, v: number): void => {
  const i = T[name]!;
  g.traits[i] = encodeQ(v, TRAITS[i]!);
};
const angle = (deg: number): number => Math.round(deg / (180 / 128));

function mod(innov: number, kind: number, subtype: number, o: Partial<ModuleGene>): ModuleGene {
  const m = defaultRecord<ModuleGene>(MODULE_RECORD);
  Object.assign(m, { innov, kind, subtype, flags: MODULE_FLAG.ENABLED, length: 32768, width: 32768, span: 128, taper: 160 }, o);
  return m;
}
function link(innov: number, fromInnov: number, toInnov: number, o: Partial<LinkGene>): LinkGene {
  const l = defaultRecord<LinkGene>(LINK_RECORD);
  Object.assign(l, { innov, fromInnov, toInnov, flags: LINK_FLAG.ENABLED, repeat: 1, childScale: 128, repeatScale: 128 }, o);
  return l;
}

export function exampleGenome(): Genome {
  const g = blankGenome();
  setTrait(g, 'ADULT_LENGTH', 0.06);
  setTrait(g, 'BODY_HUE', 0.53);
  setTrait(g, 'BODY_SAT', 0.55);
  setTrait(g, 'BODY_LUM', 0.45);
  setTrait(g, 'TRANSLUCENCY', 0.55);
  setTrait(g, 'GLOW_HUE', 0.47);
  setTrait(g, 'GLOW_BASE', 0.45);
  setTrait(g, 'PULSE_FREQ', 0.25);
  setTrait(g, 'DIET_PLANT', 0.2);
  const head = g.modules[0]!;
  Object.assign(head, { length: 22000, width: 50000, taper: 235, glow: 90 });
  g.modules.push(
    mod(4096, KIND.SEGMENT, SEGMENT_SUBTYPE.TRUNK, { length: 46000, width: 48000, taper: 200, hueOffset: 6, glow: 70, cpgAmp: 160 }),
    mod(4097, KIND.FIN, 2, { length: 52000, width: 60000, glow: 40, hueOffset: -10 }),
    mod(4098, KIND.FIN, 0, { length: 46000, width: 30000, glow: 30, flags: MODULE_FLAG.ENABLED | MODULE_FLAG.PAIRED }),
    mod(4099, KIND.EYE, 1, { length: 30000, p1: 160, p2: 120 }),
    mod(4100, KIND.PHOTOPHORE, 0, { length: 14000, glow: 255 }),
    mod(4101, KIND.LIMB, 2, { length: 52000, width: 6000, taper: 60, glow: 120 }),
    mod(4102, KIND.PHOTOPHORE, 2, { length: 24000, glow: 255 }),
    mod(4103, KIND.MOUTH, 1, { length: 20000, p1: 140 }),
    mod(4104, KIND.FIN, 1, { length: 44000, width: 20000, glow: 30, hueOffset: 12 }),
  );
  g.links.push(
    // head to a chain of four trunk segments, each a little smaller
    link(5000, 1, 4096, { attachPos: 255, attachAngle: 0, repeat: 4, repeatScale: 70, phaseStep: 40 }),
    // a forked tail fluke on the last trunk segment only
    link(5001, 4096, 4097, { attachPos: 250, attachAngle: 0, flags: LINK_FLAG.ENABLED | LINK_FLAG.TERMINAL_ONLY }),
    // a mirrored pair of paddle fins behind the head
    link(5002, 1, 4098, { attachPos: 210, attachAngle: angle(40), symmetry: SYMMETRY.MIRROR, childScale: 110 }),
    // a lens eye near the snout
    link(5003, 1, 4099, { attachPos: 70, attachAngle: angle(-35) }),
    // a row of belly lights, one per trunk segment
    link(5004, 4096, 4100, { attachPos: 128, attachAngle: angle(80) }),
    // a whip lure over the snout, tipped with a lure light
    link(5005, 1, 4101, { attachPos: 30, attachAngle: angle(-125) }),
    link(5006, 4101, 4102, { attachPos: 255, attachAngle: 0, flags: LINK_FLAG.ENABLED | LINK_FLAG.TERMINAL_ONLY }),
    // jaws at the snout
    link(5007, 1, 4103, { attachPos: 0, attachAngle: angle(15) }),
    // a fringe dorsal fin behind the head, sweeping back
    link(5008, 1, 4104, { attachPos: 230, attachAngle: angle(-30), childScale: 100 }),
  );
  return g;
}

/** The example as a `.ptkg` container (uncompressed: the deflate is optional, CONTRACT 14.2). */
export function exampleContainer(): Uint8Array {
  return encodePtkg({
    kind: PTKG_KIND.DESIGN,
    genomeVersion: GENOME_FORMAT_VERSION,
    payload: {
      meta: designMeta({
        name: { genus: 'Vitrilampas', epithet: 'demonstrata', common: 'Example glassdart' },
        notes: 'An example design for the share page: a small glassy predator with a lure over its snout and a row of belly lights.',
        author: 'Phylotank',
        tags: ['example', 'predator', 'lure'],
      }),
      genome: encodeGenome(exampleGenome()),
    },
  });
}

export function exampleString(): string { return toPtkString(exampleContainer()); }
