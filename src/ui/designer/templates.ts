/**
 * The seven starter templates (07 §1.6 and William's Q9: Meadowlamp, Hushmaw, Sievebell,
 * Tetherling, Ashpicker, Deepcrown, Motefly) plus Blank. `genome.template(id)` is preferred;
 * while src/genome only ships Blank, the designer builds these local genomes from the schema so
 * it works standalone. They are original designs; the genome engineer owns the tuned versions.
 */
import {
  BRAIN_TRAITS, BT, defaultRecord, emptyGenome, encodeQ, KIND, LINK_FLAG, LINK_RECORD, MODULE_FLAG, MODULE_RECORD,
  MOUTH_SUBTYPE, SEGMENT_SUBTYPE, SYMMETRY, T, TRAITS,
  type Genome, type LinkGene, type ModuleGene, type TemplateId,
} from '../../core/index.js';
import { genome as genomeModule } from '../../genome/index.js';

export interface TemplateInfo {
  id: TemplateId;
  name: string;           // English template name (Q9: kept)
  nameSv: string;
  genus: string;
  epithet: string;
  niche: string;
}

export const TEMPLATES: readonly TemplateInfo[] = [
  { id: 'meadowlamp', name: 'Meadowlamp', nameSv: 'Ängslykta', genus: 'Pratilux', epithet: 'tondens', niche: 'grazer' },
  { id: 'hushmaw', name: 'Hushmaw', nameSv: 'Tystkäft', genus: 'Tacitostoma', epithet: 'insidians', niche: 'ambush predator' },
  { id: 'sievebell', name: 'Sievebell', nameSv: 'Silklocka', genus: 'Cribrocampana', epithet: 'lenta', niche: 'filter feeder' },
  { id: 'tetherling', name: 'Tetherling', nameSv: 'Fästling', genus: 'Haerentula', epithet: 'furtiva', niche: 'parasite' },
  { id: 'ashpicker', name: 'Ashpicker', nameSv: 'Askplockare', genus: 'Cineralegus', epithet: 'sedulus', niche: 'scavenger' },
  { id: 'deepcrown', name: 'Deepcrown', nameSv: 'Djupkrona', genus: 'Bathycorona', epithet: 'patiens', niche: 'leviathan seed' },
  { id: 'motefly', name: 'Motefly', nameSv: 'Stoftfluga', genus: 'Motilux', epithet: 'errans', niche: 'drifting mote' },
  { id: 'blank', name: 'Blank', nameSv: 'Tom', genus: 'Novus', epithet: 'primus', niche: 'blank' },
];

type ModOpts = Partial<Record<'length' | 'width' | 'span' | 'taper' | 'stiffness' | 'lipid' | 'muscle' | 'gut' | 'armour' | 'glow' | 'cpgAmp' | 'jointRange' | 'photo', number>> & {
  p1?: number; p2?: number; p3?: number; p4?: number; p5?: number; hue?: number; paired?: boolean; claw?: boolean; cpgPhase?: number; rec?: number;
};

const fq = (name: string, v: number): number => {
  const f = MODULE_RECORD.fields.find((x) => x.name === name)!;
  return f.range ? encodeQ(v, f.range, f.type === 'u16' ? 65535 : 255) : v;
};
const lq = (name: string, v: number): number => {
  const f = LINK_RECORD.fields.find((x) => x.name === name)!;
  return f.range ? encodeQ(v, f.range, 255) : v;
};

function mod(innov: number, kind: number, subtype: number, o: ModOpts = {}): ModuleGene {
  const m = defaultRecord<ModuleGene>(MODULE_RECORD);
  m.innov = innov; m.kind = kind; m.subtype = subtype;
  m.flags = MODULE_FLAG.ENABLED | (o.paired ? MODULE_FLAG.PAIRED : 0) | (o.claw ? MODULE_FLAG.CLAW : 0);
  m.recursionLimit = o.rec ?? 0;
  m.length = fq('length', o.length ?? 1);
  m.width = fq('width', o.width ?? 0.35);
  m.span = fq('span', o.span ?? 1);
  m.taper = fq('taper', o.taper ?? 0.8);
  m.stiffness = fq('stiffness', o.stiffness ?? 1);
  m.lipidFraction = fq('lipidFraction', o.lipid ?? 0.1);
  m.muscleFraction = fq('muscleFraction', o.muscle ?? (kind === KIND.SEGMENT || kind === KIND.FIN ? 0.3 : 0));
  m.gutFraction = fq('gutFraction', o.gut ?? (kind === KIND.SEGMENT ? 0.25 : 0));
  m.armourCoverage = fq('armourCoverage', o.armour ?? 0);
  m.glow = fq('glow', o.glow ?? 0.2);
  m.hueOffset = Math.round((o.hue ?? 0) * 255);
  m.p1 = o.p1 ?? 128; m.p2 = o.p2 ?? 128; m.p3 = o.p3 ?? 128; m.p4 = o.p4 ?? 128; m.p5 = o.p5 ?? 128;
  m.cpgPhase = o.cpgPhase ?? 0; m.cpgAmp = Math.round((o.cpgAmp ?? (kind === KIND.FIN || kind === KIND.SEGMENT ? 0.5 : 0)) * 255);
  m.jointRange = o.jointRange ?? 60; m.jointRest = 0; m.allometry = 128;
  m.photoFraction = Math.round((o.photo ?? 0) * 255);
  return m;
}

function link(innov: number, from: number, to: number, pos: number, angleDeg: number, o: { repeat?: number; sym?: number; scale?: number; rscale?: number; terminal?: boolean; phase?: number } = {}): LinkGene {
  const l = defaultRecord<LinkGene>(LINK_RECORD);
  l.innov = innov; l.fromInnov = from; l.toInnov = to;
  l.attachPos = Math.round(pos * 255);
  l.attachAngle = Math.max(-128, Math.min(127, Math.round(angleDeg / 1.41)));
  l.repeat = o.repeat ?? 1;
  l.symmetry = o.sym ?? SYMMETRY.NONE;
  l.childScale = lq('childScale', o.scale ?? 1);
  l.repeatScale = lq('repeatScale', o.rscale ?? 1);
  l.flags = LINK_FLAG.ENABLED | (o.terminal ? LINK_FLAG.TERMINAL_ONLY : 0) | (o.phase ? LINK_FLAG.PHASE_WAVE : 0);
  l.phaseStep = Math.round((o.phase ?? 0) * 255);
  return l;
}

function setT(g: Genome, name: string, v: number): void { g.traits[T[name]!] = encodeQ(v, TRAITS[T[name]!]!); }
function setB(g: Genome, name: string, v: number): void { g.brainTraits[BT[name]!] = encodeQ(v, BRAIN_TRAITS[BT[name]!]!); }

function base(traits: Record<string, number>, brain: Record<string, number>, modules: ModuleGene[], links: LinkGene[]): Genome {
  const g = emptyGenome();
  for (const [k, v] of Object.entries(traits)) setT(g, k, v);
  for (const [k, v] of Object.entries(brain)) setB(g, k, v);
  modules[0]!.flags |= MODULE_FLAG.ROOT;
  g.modules = modules;
  g.links = links;
  g.rootModuleInnov = modules[0]!.innov;
  g.flags |= 1; // DESIGNED
  return g;
}

const S = KIND.SEGMENT, F = KIND.FIN, LM = KIND.LIMB, M = KIND.MOUTH, E = KIND.EYE, C = KIND.CHEMO, SP = KIND.SPIKE, P = KIND.PHOTOPHORE;

function localTemplate(id: TemplateId): Genome {
  switch (id) {
    case 'meadowlamp': return base(
      { ADULT_LENGTH: 0.015, DIET_PLANT: 0.92, DIET_DETRITUS: 0.06, CLUTCH_SIZE: 6, SEX_PROB: 0.3, BODY_HUE: 0.32, GLOW_HUE: 0.36, GLOW_BASE: 0.35, PULSE_FREQ: 0.25, TEMP_OPTIMUM: 18 },
      { SOCIALITY: 0.6, AGGRESSION: -0.8, PREF_DEPTH: 0.15, LIGHT_SHOW: 0.4 },
      [mod(1, S, SEGMENT_SUBTYPE.HEAD, { width: 0.45, glow: 0.3 }), mod(2, S, SEGMENT_SUBTYPE.TRUNK, { length: 0.8, width: 0.45, glow: 0.2 }),
        mod(3, M, MOUTH_SUBTYPE.RASP, { length: 0.25, width: 0.9 }), mod(4, F, 0, { length: 0.5, width: 0.6, paired: true }),
        mod(5, E, 0, { length: 0.18, width: 1 }), mod(6, F, 2, { length: 0.6, width: 0.9, cpgAmp: 0.8 })],
      [link(1, 1, 2, 1, 0, { repeat: 4, rscale: 0.93, phase: 0.2 }), link(2, 1, 3, 0, 180), link(3, 1, 4, 0.6, 70, { sym: SYMMETRY.MIRROR }),
        link(4, 1, 5, 0.15, 35, { sym: SYMMETRY.MIRROR }), link(5, 2, 6, 1, 0, { terminal: true })]);
    case 'hushmaw': return base(
      { ADULT_LENGTH: 0.06, DIET_PLANT: 0.05, DIET_DETRITUS: 0.05, CLUTCH_SIZE: 3, SEX_PROB: 0.5, FAST_FIBRE: 0.8, BODY_HUE: 0.02, GLOW_HUE: 0.58, GLOW_BASE: 0.15, TEMP_OPTIMUM: 10 },
      { AGGRESSION: 0.7, BOLDNESS: -0.6, ACTIVITY: 0.2, PATIENCE: 0.9, PREF_DEPTH: 0.55, LIGHT_SHOW: 0.6 },
      [mod(1, S, SEGMENT_SUBTYPE.HEAD, { width: 0.8, muscle: 0.4 }), mod(2, S, SEGMENT_SUBTYPE.TRUNK, { length: 0.9, width: 0.7, muscle: 0.4 }),
        mod(3, M, MOUTH_SUBTYPE.JAWS, { length: 0.45, width: 1.2, p1: 230 }), mod(4, P, 2, { length: 0.5, width: 0.12, glow: 0.9, hue: 0.1 }),
        mod(5, F, 0, { length: 0.25, width: 0.6, paired: true }), mod(6, F, 2, { length: 0.8, width: 1.1, muscle: 0.5, cpgAmp: 0.9 }), mod(7, E, 1, { length: 0.12, width: 1 })],
      [link(1, 1, 2, 1, 0, { repeat: 2, rscale: 0.85 }), link(2, 1, 3, 0, 180), link(3, 1, 4, 0.1, -60), link(4, 1, 5, 0.7, 75, { sym: SYMMETRY.MIRROR }),
        link(5, 2, 6, 1, 0, { terminal: true }), link(6, 1, 7, 0.2, 40, { sym: SYMMETRY.MIRROR })]);
    case 'sievebell': return base(
      { ADULT_LENGTH: 0.04, DIET_PLANT: 0.7, DIET_DETRITUS: 0.3, CLUTCH_SIZE: 8, BODY_HUE: 0.62, GLOW_HUE: 0.7, GLOW_BASE: 0.45, PULSE_FREQ: 0.4, TRANSLUCENCY: 0.85 },
      { SOCIALITY: 0, PREF_DEPTH: 0.4, ACTIVITY: 0.15, LIGHT_SHOW: 0.5 },
      [mod(1, S, SEGMENT_SUBTYPE.BELL, { length: 1, width: 1.4, muscle: 0.08, glow: 0.4 }), mod(2, M, MOUTH_SUBTYPE.FILTER, { length: 0.5, width: 0.25, p2: 220 }),
        mod(3, P, 0, { length: 0.08, width: 1, glow: 1, hue: 0.05 }), mod(4, C, 1, { length: 0.3, width: 0.1 })],
      [link(1, 1, 2, 1, 0, { sym: SYMMETRY.RADIAL, repeat: 1 }), link(2, 1, 3, 0.5, 90, { sym: SYMMETRY.RADIAL }), link(3, 1, 4, 0, 160, { sym: SYMMETRY.MIRROR })]);
    case 'tetherling': return base(
      { ADULT_LENGTH: 0.003, DIET_PLANT: 0, DIET_DETRITUS: 0, CLUTCH_SIZE: 32, SEX_PROB: 0.1, MU_LOG: -2.22, GLOW_BASE: 0.03, BODY_HUE: 0.85 },
      { BOLDNESS: 0.9, AGGRESSION: 0.5, LIGHT_SHOW: 0, PREF_DEPTH: 0.5 },
      [mod(1, S, SEGMENT_SUBTYPE.HEAD, { width: 0.5, glow: 0.02 }), mod(2, S, SEGMENT_SUBTYPE.TRUNK, { length: 0.7, width: 0.45, glow: 0.02 }),
        mod(3, M, MOUTH_SUBTYPE.PROBOSCIS, { length: 0.6, width: 0.15, p4: 230 }), mod(4, SP, 1, { length: 0.3, width: 0.15 }), mod(5, C, 1, { length: 0.8, width: 0.05, p2: 255 })],
      [link(1, 1, 2, 1, 0), link(2, 1, 3, 0, 180), link(3, 2, 4, 0.5, 110, { sym: SYMMETRY.MIRROR }), link(4, 1, 5, 0, 150, { sym: SYMMETRY.MIRROR })]);
    case 'ashpicker': return base(
      { ADULT_LENGTH: 0.025, DIET_PLANT: 0.3, DIET_DETRITUS: 0.85, TEMP_OPTIMUM: 4, BODY_HUE: 0.08, GLOW_HUE: 0.08, GLOW_BASE: 0.12, CLUTCH_SIZE: 4 },
      { EXPLORATION: 0.2, PREF_DEPTH: 0.85, LIGHT_SHOW: 0.1, GAIN_LATERAL: 2.5 },
      [mod(1, S, SEGMENT_SUBTYPE.HEAD, { width: 0.4, p1: 240 }), mod(2, S, SEGMENT_SUBTYPE.TRUNK, { length: 0.7, width: 0.35, p1: 240, glow: 0.12 }),
        mod(3, M, MOUTH_SUBTYPE.SUCTION, { length: 0.3, width: 0.8 }), mod(4, LM, 2, { length: 2.2, width: 0.08, cpgAmp: 0.7 }), mod(5, F, 1, { length: 0.4, width: 0.3, paired: true })],
      [link(1, 1, 2, 1, 0, { repeat: 6, rscale: 0.95, phase: 0.15 }), link(2, 1, 3, 0, 180), link(3, 2, 4, 1, 0, { terminal: true }), link(4, 1, 5, 0.6, 80, { sym: SYMMETRY.MIRROR })]);
    case 'deepcrown': return base(
      { ADULT_LENGTH: 0.12, GROWTH_RATE: 0.3, LIFESPAN_MULT: 15, CLUTCH_SIZE: 1, BIRTH_FRACTION: 0.3, DIET_PLANT: 0.35, DIET_DETRITUS: 0.15, PULSE_FREQ: 0.1, BODY_HUE: 0.72, GLOW_HUE: 0.78, GLOW_BASE: 0.5, TEMP_OPTIMUM: 8 },
      { BOLDNESS: 0.8, AGGRESSION: 0.3, PREF_DEPTH: 0.7, LIGHT_SHOW: 0.5 },
      [mod(1, S, SEGMENT_SUBTYPE.HEAD, { width: 0.6, armour: 0.3 }), mod(2, S, SEGMENT_SUBTYPE.TRUNK, { length: 0.85, width: 0.55, taper: 0.7 }),
        mod(3, M, MOUTH_SUBTYPE.JAWS, { length: 0.3, width: 1 }), mod(4, M, MOUTH_SUBTYPE.FILTER, { length: 0.2, width: 0.3 }),
        mod(5, F, 0, { length: 0.9, width: 0.5, paired: true }), mod(6, F, 2, { length: 0.9, width: 1.2, cpgAmp: 0.9 }),
        mod(7, SP, 0, { length: 0.35, width: 0.12 }), mod(8, E, 1, { length: 0.1, width: 1 })],
      [link(1, 1, 2, 1, 0, { repeat: 8, rscale: 0.9, phase: 0.12 }), link(2, 1, 3, 0, 180), link(3, 1, 4, 0.05, 150, { sym: SYMMETRY.MIRROR }),
        link(4, 1, 5, 0.7, 70, { sym: SYMMETRY.MIRROR }), link(5, 2, 6, 1, 0, { terminal: true }), link(6, 1, 7, 0.4, -90, { sym: SYMMETRY.RADIAL }),
        link(7, 1, 8, 0.2, 45, { sym: SYMMETRY.MIRROR })]);
    case 'motefly': return base(
      { ADULT_LENGTH: 0.0012, DIET_PLANT: 1, DIET_DETRITUS: 0, CLUTCH_SIZE: 8, SEX_PROB: 0, GLOW_HUE: 0.14, BODY_HUE: 0.14, GLOW_BASE: 0.55, PULSE_FREQ: 0.8, LIFESPAN_MULT: 3 },
      { SOCIALITY: 0.3, PREF_DEPTH: 0.1, LIGHT_SHOW: 0.7 },
      [mod(1, S, SEGMENT_SUBTYPE.BELL, { length: 1, width: 0.9, photo: 0.8, glow: 0.6 }), mod(2, KIND.CILIA, 0, { length: 0.4, width: 0.3 }), mod(3, M, MOUTH_SUBTYPE.FILTER, { length: 0.2, width: 0.5 })],
      [link(1, 1, 2, 0.5, 90, { sym: SYMMETRY.MIRROR }), link(2, 1, 3, 0, 180)]);
    case 'blank': default: {
      try { return genomeModule.template('blank'); } catch { return base({}, {}, [mod(1, S, SEGMENT_SUBTYPE.HEAD)], []); }
    }
  }
}

/** A template genome: the genome module's version when it has one, else the local build. */
export function templateGenome(id: TemplateId): Genome {
  try { return genomeModule.template(id); } catch { return localTemplate(id); }
}
export function templateInfo(id: TemplateId): TemplateInfo { return TEMPLATES.find((x) => x.id === id) ?? TEMPLATES[TEMPLATES.length - 1]!; }
