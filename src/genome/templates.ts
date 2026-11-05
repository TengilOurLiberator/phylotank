/**
 * The seven named templates plus Blank (DESIGN R23, 07 §2.2 table, William's Q9 names).
 *
 * Each template uses its own block of reserved innovation ids (1 to 4,095, CONTRACT 6.8), so
 * designs forked from the same template share homology and can interbreed, while different
 * templates are reproductively distinct. Each carries BrainTraits for its matching behaviour
 * template (grazer, ambusher, drifter, parasite, scavenger, giant, microbe); src/brain builds
 * the wiring from them (direct encoding, ENCODING 0, the v0.1 default).
 */
import {
  BT, T, GENOME_FLAG_DESIGNED, GENOME_FLAG_LEVIATHAN, KIND, MOUTH_SUBTYPE, REG_AXIS, REG_PARAM_GATE, SEGMENT_SUBTYPE,
  SYMMETRY, emptyGenome, hash32, type Genome, type TemplateId,
} from '../core/index.js';
import { blankGenome } from './blank.js';
import { TI, setBrainTrait, setTrait } from './genes.js';
import { makeLink, makeModule, makeReg, type LinkSpec, type ModSpec } from './kinds.js';
import { repairInPlace } from './repair.js';

export interface TemplateName { common: string; commonSv: string; genus: string; epithet: string; niche: string; behaviour: string }
export const TEMPLATE_NAMES: Readonly<Record<TemplateId, TemplateName>> = {
  meadowlamp: { common: 'Meadowlamp', commonSv: 'Ängslykta', genus: 'Pratilux', epithet: 'tondens', niche: 'grazer', behaviour: 'grazer' },
  hushmaw: { common: 'Hushmaw', commonSv: 'Tystgap', genus: 'Tacitostoma', epithet: 'insidians', niche: 'ambush predator', behaviour: 'ambusher' },
  sievebell: { common: 'Sievebell', commonSv: 'Silklocka', genus: 'Cribrocampana', epithet: 'lenta', niche: 'filter feeder', behaviour: 'drifter' },
  tetherling: { common: 'Tetherling', commonSv: 'Tjuderling', genus: 'Haerentula', epithet: 'furtiva', niche: 'parasite', behaviour: 'parasite' },
  ashpicker: { common: 'Ashpicker', commonSv: 'Askplockare', genus: 'Cineralegus', epithet: 'sedulus', niche: 'scavenger', behaviour: 'scavenger' },
  deepcrown: { common: 'Deepcrown', commonSv: 'Djupkrona', genus: 'Bathycorona', epithet: 'patiens', niche: 'leviathan seed', behaviour: 'giant' },
  motefly: { common: 'Motefly', commonSv: 'Stoftfluga', genus: 'Flagellux', epithet: 'minima', niche: 'whip microbe', behaviour: 'microbe' },
  blank: { common: 'Blank', commonSv: 'Tom', genus: 'Nudisoma', epithet: 'simplex', niche: 'none', behaviour: 'none' },
};

/** Base of each template's innovation block. */
export const TEMPLATE_INNOV_BASE: Readonly<Record<TemplateId, number>> = {
  blank: 0, meadowlamp: 100, hushmaw: 200, sievebell: 300, tetherling: 400, ashpicker: 500, deepcrown: 600, motefly: 700,
};

class Builder {
  readonly g: Genome = emptyGenome();
  constructor(readonly base: number) { this.g.flags = GENOME_FLAG_DESIGNED; }
  mod(id: number, kind: number, subtype: number, s: ModSpec = {}): number {
    const innov = this.base + id;
    this.g.modules.push(makeModule(innov, kind, subtype, s));
    if (s.root) this.g.rootModuleInnov = innov;
    return innov;
  }
  link(id: number, from: number, to: number, s: LinkSpec = {}): void { this.g.links.push(makeLink(this.base + 50 + id, from, to, s)); }
  reg(id: number, target: number, axis: number, param: number, shape: number, centre: number, width: number, amount: number): void {
    this.g.regs.push(makeReg(this.base + 80 + id, target, axis, param, shape, centre, width, amount));
  }
  t(idx: number, v: number): this { setTrait(this.g, idx, v); return this; }
  b(idx: number, v: number): this { setBrainTrait(this.g, idx, v); return this; }
  done(keys: number): Genome {
    this.g.immuneKey = hash32(this.base, keys, 1);
    this.g.surfaceSig = hash32(this.base, keys, 2);
    return repairInPlace(this.g);
  }
}

const EYE_RGB = 0b10_011_011; // bits 0-2 blue, 3-5 green, 6-7 red
const dietFor = (plant: number, detritus: number): [number, number] => {
  // e_plant = x1 (1 - x2), e_det = x2 (CONTRACT 9.3)
  const x2 = detritus;
  const x1 = x2 >= 1 ? 0 : Math.min(1, plant / (1 - x2));
  return [x1, x2];
};

function meadowlamp(): Genome {
  const B = new Builder(100);
  const head = B.mod(1, KIND.SEGMENT, SEGMENT_SUBTYPE.HEAD, { root: true, len: 1, aspect: 0.45, muscle: 0.25, gut: 0.15, p: [90, 60], glow: 0.15 });
  const trunk = B.mod(2, KIND.SEGMENT, SEGMENT_SUBTYPE.TRUNK, { len: 0.9, aspect: 0.45, muscle: 0.35, gut: 0.35, rangeDeg: 35, amp: 0.5, glow: 0.12, p: [80, 40] });
  const mouth = B.mod(3, KIND.MOUTH, MOUTH_SUBTYPE.RASP, { len: 0.25, aspect: 1.2, muscle: 0.3, rangeDeg: 20, p: [190, 0, 60, 0] });
  const eye = B.mod(4, KIND.EYE, 0, { len: 0.2, aspect: 0.9, muscle: 0, rangeDeg: 0, p: [150, 210, 80, EYE_RGB, 90] });
  const fin1 = B.mod(5, KIND.FIN, 0, { len: 0.6, aspect: 0.1, span: 4, muscle: 0.3, amp: 0.7, rangeDeg: 90, paired: true, phase: 0 });
  const fin2 = B.mod(6, KIND.FIN, 0, { len: 0.5, aspect: 0.1, span: 4, muscle: 0.3, amp: 0.7, rangeDeg: 90, paired: true, phase: 180 });
  const tail = B.mod(7, KIND.FIN, 1, { len: 0.8, aspect: 0.06, span: 3, muscle: 0.25, amp: 0.8, rangeDeg: 70, glow: 0.2 });
  B.link(1, head, trunk, { pos: 1, repeat: 4, repeatScale: 0.92, wave: true, phaseStepDeg: 50 });
  B.link(2, head, mouth, { pos: 0, angleDeg: 178 });
  B.link(3, head, eye, { pos: 0.3, angleDeg: 60, symmetry: SYMMETRY.MIRROR, childScale: 1 });
  B.link(4, head, fin1, { pos: 0.9, angleDeg: 40 });
  B.link(5, trunk, fin2, { pos: 0.5, angleDeg: 40 });
  B.link(6, trunk, tail, { pos: 1, terminalOnly: true });
  B.reg(1, fin2, REG_AXIS.AP, REG_PARAM_GATE, 3, 0.6, 0.15, 0.5); // the second fin pair only near AP 0.6
  const [x1, x2] = dietFor(0.85, 0.05);
  B.t(TI.ADULT_LENGTH, 0.01).t(TI.DIET_PLANT, x1).t(TI.DIET_DETRITUS, x2).t(TI.CLUTCH_SIZE, 6).t(TI.SEX_PROB, 0.3)
    .t(TI.MU_LOG, -2.52).t(TI.BODY_HUE, 0.33).t(TI.GLOW_HUE, 0.4).t(TI.GLOW_BASE, 0.25);
  B.b(BT.SOCIALITY!, 0.6).b(BT.AGGRESSION!, 0.05).b(BT.PREF_DEPTH!, 0.15).b(BT.ACTIVITY!, 0.5).b(BT.REFLEX_GRAZE!, 1.5);
  return B.done(1);
}

function hushmaw(): Genome {
  const B = new Builder(200);
  const head = B.mod(1, KIND.SEGMENT, SEGMENT_SUBTYPE.HEAD, { root: true, len: 1.2, aspect: 0.7, muscle: 0.4, gut: 0.2, p: [60, 80] });
  const trunk = B.mod(2, KIND.SEGMENT, SEGMENT_SUBTYPE.TRUNK, { len: 1, aspect: 0.65, muscle: 0.45, gut: 0.3, rangeDeg: 30, amp: 0.4 });
  const jaws = B.mod(3, KIND.MOUTH, MOUTH_SUBTYPE.JAWS, { len: 0.45, aspect: 1.4, muscle: 0.6, rangeDeg: 50, p: [255, 0, 120, 0] });
  const stalk = B.mod(4, KIND.LIMB, 0, { len: 0.9, aspect: 0.08, muscle: 0.2, rangeDeg: 60, amp: 0 });
  const lure = B.mod(5, KIND.PHOTOPHORE, 2, { len: 0.25, aspect: 0.9, muscle: 0, rangeDeg: 0, glow: 0.9, p: [200, 128], hue: 0.1 });
  const fin = B.mod(6, KIND.FIN, 0, { len: 0.25, aspect: 0.1, span: 3, muscle: 0.3, amp: 0.4, rangeDeg: 80, paired: true });
  const fluke = B.mod(7, KIND.FIN, 2, { len: 0.9, aspect: 0.08, span: 6, muscle: 0.5, amp: 0.9, rangeDeg: 80 });
  const eye = B.mod(8, KIND.EYE, 1, { len: 0.18, aspect: 1, muscle: 0, rangeDeg: 0, p: [170, 70, 140, EYE_RGB, 200] });
  B.link(1, head, trunk, { pos: 1, repeat: 2, repeatScale: 0.9, wave: true, phaseStepDeg: 70 });
  B.link(2, head, jaws, { pos: 0, angleDeg: 178 });
  B.link(3, head, stalk, { pos: 0.1, angleDeg: 150 });
  B.link(4, stalk, lure, { pos: 1 });
  B.link(5, head, fin, { pos: 0.8, angleDeg: 50 });
  B.link(6, trunk, fluke, { pos: 1, terminalOnly: true });
  B.link(7, head, eye, { pos: 0.25, angleDeg: 50, symmetry: SYMMETRY.MIRROR });
  const [x1, x2] = dietFor(0.1, 0);
  B.t(TI.ADULT_LENGTH, 0.05).t(TI.DIET_PLANT, x1).t(TI.DIET_DETRITUS, x2).t(TI.CLUTCH_SIZE, 3).t(TI.MUSCLE_STRENGTH, 2.6e5)
    .t(T.FAST_FIBRE!, 0.8).t(TI.BODY_HUE, 0.75).t(TI.GLOW_HUE, 0.55).t(TI.GLOW_BASE, 0.15);
  B.b(BT.AGGRESSION!, 0.7).b(BT.BOLDNESS!, 0.2).b(BT.ACTIVITY!, 0.1).b(BT.PATIENCE!, 0.9).b(BT.PREF_DEPTH!, 0.55)
    .b(BT.REFLEX_BITE_ON_TASTE!, 1.8).b(BT.REFLEX_GRAZE!, 0).b(BT.LIGHT_SHOW!, 0.6);
  return B.done(2);
}

function sievebell(): Genome {
  const B = new Builder(300);
  const bell = B.mod(1, KIND.SEGMENT, SEGMENT_SUBTYPE.BELL, { root: true, len: 1, aspect: 0.6, span: 1, muscle: 0.08, gut: 0.3, lipid: 0.3, glow: 0.2 });
  const comb = B.mod(2, KIND.MOUTH, MOUTH_SUBTYPE.FILTER, { len: 0.3, aspect: 0.4, muscle: 0.05, rangeDeg: 30, p: [150, 220, 0, 0] });
  const ring = B.mod(3, KIND.PHOTOPHORE, 0, { len: 0.12, aspect: 0.9, muscle: 0, rangeDeg: 0, glow: 0.7, p: [120, 100] });
  const jet = B.mod(4, KIND.JET, 0, { len: 0.5, aspect: 0.8, muscle: 0.3, rangeDeg: 20, p: [180] });
  const pit = B.mod(5, KIND.CHEMO, 0, { len: 0.05, aspect: 0.5, muscle: 0, rangeDeg: 0, p: [60, 0b00000011, 0] });
  B.link(1, bell, comb, { pos: 0.9, angleDeg: 0, repeat: 6, symmetry: SYMMETRY.RADIAL });
  B.link(2, bell, ring, { pos: 0.5, angleDeg: 30, repeat: 6, symmetry: SYMMETRY.RADIAL });
  B.link(3, bell, jet, { pos: 1 });
  B.link(4, bell, pit, { pos: 0.2 });
  const [x1, x2] = dietFor(0.7, 0.3);
  B.t(TI.ADULT_LENGTH, 0.03).t(TI.DIET_PLANT, x1).t(TI.DIET_DETRITUS, x2).t(TI.CLUTCH_SIZE, 8).t(TI.BODY_HUE, 0.55)
    .t(T.TRANSLUCENCY!, 0.85).t(TI.GLOW_HUE, 0.5).t(TI.GLOW_BASE, 0.35).t(T.CILIA_SPEED!, 0.6);
  B.b(BT.SOCIALITY!, 0).b(BT.PREF_DEPTH!, 0.2).b(BT.ACTIVITY!, 0.2).b(BT.GAIN_CHEMO!, 1.6).b(BT.REFLEX_SWIM!, 0.6);
  return B.done(3);
}

function tetherling(): Genome {
  const B = new Builder(400);
  const head = B.mod(1, KIND.SEGMENT, SEGMENT_SUBTYPE.HEAD, { root: true, len: 1, aspect: 0.4, muscle: 0.2, gut: 0.2 });
  const trunk = B.mod(2, KIND.SEGMENT, SEGMENT_SUBTYPE.TRUNK, { len: 0.8, aspect: 0.4, muscle: 0.3, gut: 0.3, rangeDeg: 40, amp: 0.5 });
  const prob = B.mod(3, KIND.MOUTH, MOUTH_SUBTYPE.PROBOSCIS, { len: 0.5, aspect: 0.25, muscle: 0.3, rangeDeg: 40, p: [100, 0, 40, 220] });
  const hook = B.mod(4, KIND.SPIKE, 1, { len: 0.3, aspect: 0.15, muscle: 0, rangeDeg: 0, stiff: 6, p: [160] });
  const antenna = B.mod(5, KIND.CHEMO, 1, { len: 0.6, aspect: 0.08, muscle: 0.1, rangeDeg: 40, p: [200, 0xff, 0] });
  const cilia = B.mod(6, KIND.CILIA, 0, { len: 0.5, aspect: 0.3, muscle: 0.1, rangeDeg: 0, p: [220, 200] });
  B.link(1, head, trunk, { pos: 1, wave: true, phaseStepDeg: 90 });
  B.link(2, head, prob, { pos: 0, angleDeg: 178 });
  B.link(3, trunk, hook, { pos: 0.5, angleDeg: 60, symmetry: SYMMETRY.MIRROR });
  B.link(4, head, antenna, { pos: 0.1, angleDeg: 140, symmetry: SYMMETRY.MIRROR });
  B.link(5, trunk, cilia, { pos: 0.8, angleDeg: 10 });
  const [x1, x2] = dietFor(0, 0);
  B.t(TI.ADULT_LENGTH, 0.002).t(TI.DIET_PLANT, x1).t(TI.DIET_DETRITUS, x2).t(TI.CLUTCH_SIZE, 32).t(TI.SEX_PROB, 0.1)
    .t(TI.MU_LOG, -2.22).t(TI.BODY_HUE, 0.95).t(TI.GLOW_BASE, 0).t(TI.BIRTH_FRACTION, 0.1);
  B.b(BT.BOLDNESS!, 0.9).b(BT.AGGRESSION!, 0.5).b(BT.GAIN_CHEMO!, 2.5).b(BT.ACTIVITY!, 0.6).b(BT.LIGHT_SHOW!, 0);
  return B.done(4);
}

function ashpicker(): Genome {
  const B = new Builder(500);
  const head = B.mod(1, KIND.SEGMENT, SEGMENT_SUBTYPE.HEAD, { root: true, len: 1, aspect: 0.4, muscle: 0.25, gut: 0.2, p: [220, 120] });
  const trunk = B.mod(2, KIND.SEGMENT, SEGMENT_SUBTYPE.TRUNK, { len: 0.9, aspect: 0.38, muscle: 0.3, gut: 0.5, rangeDeg: 40, amp: 0.6, glow: 0.1, p: [230, 80] });
  const scoop = B.mod(3, KIND.MOUTH, MOUTH_SUBTYPE.SUCTION, { len: 0.3, aspect: 1, muscle: 0.4, rangeDeg: 30, p: [170, 0, 60, 40] });
  const tail = B.mod(4, KIND.LIMB, 1, { len: 0.8, aspect: 0.1, muscle: 0.3, rangeDeg: 60, amp: 0.7, recursion: 3, alpha: 1.1 });
  const eye = B.mod(5, KIND.EYE, 0, { len: 0.06, aspect: 1, muscle: 0, rangeDeg: 0, p: [60, 220, 30, 0b00000111, 30] });
  B.link(1, head, trunk, { pos: 1, repeat: 6, repeatScale: 0.95, wave: true, phaseStepDeg: 45 });
  B.link(2, head, scoop, { pos: 0, angleDeg: 178 });
  B.link(3, trunk, tail, { pos: 1, terminalOnly: true });
  B.link(4, tail, tail, { pos: 1, childScale: 0.85, wave: true, phaseStepDeg: 45 });
  B.link(5, head, eye, { pos: 0.3, angleDeg: 60, symmetry: SYMMETRY.MIRROR });
  const [x1, x2] = dietFor(0.05, 0.85);
  B.t(TI.ADULT_LENGTH, 0.02).t(TI.DIET_PLANT, x1).t(TI.DIET_DETRITUS, x2).t(TI.TEMP_OPTIMUM, 4).t(TI.G_GUT, 1.6)
    .t(TI.BODY_HUE, 0.08).t(T.BODY_SAT!, 0.15).t(TI.GLOW_HUE, 0.08).t(TI.GLOW_BASE, 0.15).t(TI.CLUTCH_SIZE, 4);
  B.b(BT.PREF_DEPTH!, 0.85).b(BT.EXPLORATION!, 0.18).b(BT.ACTIVITY!, 0.4).b(BT.GAIN_LATERAL!, 2).b(BT.GAIN_CHEMO!, 2);
  return B.done(5);
}

function deepcrown(): Genome {
  const B = new Builder(600);
  const head = B.mod(1, KIND.SEGMENT, SEGMENT_SUBTYPE.HEAD, { root: true, len: 1, aspect: 0.5, muscle: 0.35, gut: 0.2, p: [120, 80], alpha: 0.85 });
  const jaws = B.mod(2, KIND.MOUTH, MOUTH_SUBTYPE.JAWS, { len: 0.35, aspect: 1.2, muscle: 0.5, rangeDeg: 40, p: [200, 0, 100, 0], alpha: 1.2 });
  const comb = B.mod(3, KIND.MOUTH, MOUTH_SUBTYPE.FILTER, { len: 0.3, aspect: 0.8, muscle: 0.05, rangeDeg: 20, p: [200, 200, 0, 0] });
  const trunk = B.mod(4, KIND.SEGMENT, SEGMENT_SUBTYPE.TRUNK, { len: 0.9, aspect: 0.5, muscle: 0.4, gut: 0.35, lipid: 0.25, rangeDeg: 25, amp: 0.4, taper: 0.9, p: [100, 40] });
  const pect = B.mod(5, KIND.FIN, 0, { len: 1.6, aspect: 0.08, span: 6, muscle: 0.35, amp: 0.6, rangeDeg: 80, paired: true, alpha: 1.2 });
  const fluke = B.mod(6, KIND.FIN, 2, { len: 1.2, aspect: 0.08, span: 7, muscle: 0.5, amp: 0.8, rangeDeg: 70, alpha: 1.15 });
  const spike = B.mod(7, KIND.SPIKE, 0, { len: 0.4, aspect: 0.12, muscle: 0, rangeDeg: 0, stiff: 6, p: [180], glow: 0.3, alpha: 1.2 });
  const eye = B.mod(8, KIND.EYE, 1, { len: 0.12, aspect: 1, muscle: 0, rangeDeg: 0, p: [150, 90, 120, 0b00000111, 220], alpha: 0.7 });
  B.link(1, head, trunk, { pos: 1, repeat: 8, repeatScale: 0.9, wave: true, phaseStepDeg: 35 });
  B.link(2, head, jaws, { pos: 0, angleDeg: 178 });
  B.link(3, head, comb, { pos: 0.15, angleDeg: -150 });
  B.link(4, head, pect, { pos: 0.9, angleDeg: 45 });
  B.link(5, trunk, fluke, { pos: 1, terminalOnly: true });
  B.link(6, head, spike, { pos: 0.4, angleDeg: 100, repeat: 3, symmetry: SYMMETRY.MIRROR });
  B.link(7, head, eye, { pos: 0.2, angleDeg: 40, symmetry: SYMMETRY.MIRROR });
  const [x1, x2] = dietFor(0.5, 0);
  B.t(TI.ADULT_LENGTH, 0.25).t(TI.GROWTH_RATE, 0.2).t(TI.LIFESPAN_MULT, 20).t(TI.CLUTCH_SIZE, 1).t(TI.BIRTH_FRACTION, 0.12)
    .t(TI.DIET_PLANT, x1).t(TI.DIET_DETRITUS, x2).t(TI.BODY_HUE, 0.62).t(TI.GLOW_HUE, 0.62).t(TI.GLOW_BASE, 0.4)
    .t(TI.PULSE_FREQ, 0.1).t(TI.TEMP_OPTIMUM, 6).t(T.FAT_CAPACITY!, 0.3);
  B.b(BT.BOLDNESS!, 0.8).b(BT.AGGRESSION!, 0.3).b(BT.PREF_DEPTH!, 0.75).b(BT.ACTIVITY!, 0.3).b(BT.PATIENCE!, 0.8)
    .b(BT.HEAD_HIDDEN!, 16).b(BT.LIGHT_SHOW!, 0.5);
  const g = B.done(6);
  g.flags |= GENOME_FLAG_LEVIATHAN;
  return g;
}

function motefly(): Genome {
  const B = new Builder(700);
  const cell = B.mod(1, KIND.SEGMENT, SEGMENT_SUBTYPE.HEAD, { root: true, len: 1, aspect: 0.7, muscle: 0.05, gut: 0.3, lipid: 0.15, p: [0, 120], glow: 0.3 });
  const whip = B.mod(2, KIND.LIMB, 2, { len: 0.45, aspect: 0.05, muscle: 0.6, rangeDeg: 70, amp: 1, recursion: 5 });
  const spot = B.mod(3, KIND.EYE, 0, { len: 0.05, aspect: 1, muscle: 0, rangeDeg: 0, p: [40, 255, 0, 0b00011011, 0] });
  const mouth = B.mod(4, KIND.MOUTH, MOUTH_SUBTYPE.FILTER, { len: 0.2, aspect: 0.8, muscle: 0.05, rangeDeg: 10, p: [200, 160, 0, 0] });
  B.link(1, cell, whip, { pos: 1 });
  B.link(2, whip, whip, { pos: 1, childScale: 1, wave: true, phaseStepDeg: 60 });
  B.link(3, cell, spot, { pos: 0.2, angleDeg: 60 });
  B.link(4, cell, mouth, { pos: 0, angleDeg: 178 });
  const [x1, x2] = dietFor(0.9, 0.05);
  B.t(TI.ADULT_LENGTH, 0.0008).t(TI.DIET_PLANT, x1).t(TI.DIET_DETRITUS, x2).t(TI.CLUTCH_SIZE, 2).t(TI.SEX_PROB, 0)
    .t(TI.BIRTH_FRACTION, 0.5).t(TI.LIFESPAN_MULT, 3).t(TI.BODY_HUE, 0.15).t(TI.GLOW_HUE, 0.3).t(TI.GLOW_BASE, 0.35);
  B.b(BT.HEAD_HIDDEN!, 2).b(BT.HIDDEN_PER_SEGMENT!, 0).b(BT.OSC_PER_SEGMENT!, -0.5).b(BT.F_LOW!, 2).b(BT.F_HIGH!, 6)
    .b(BT.REFLEX_INNATE_GAIT!, 1.5);
  return B.done(7);
}

const BUILDERS: Readonly<Record<TemplateId, () => Genome>> = {
  meadowlamp, hushmaw, sievebell, tetherling, ashpicker, deepcrown, motefly, blank: blankGenome,
};

/** A fresh copy of a template genome. */
export function templateGenome(id: TemplateId): Genome {
  const b = BUILDERS[id];
  if (!b) throw new Error(`unknown template ${String(id)}`);
  return b();
}

