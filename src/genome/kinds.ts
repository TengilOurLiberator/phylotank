/**
 * Building module and link genes from decoded values (templates, the add-module operator, the
 * designer later). Values outside a field's range are clamped by the encoder.
 */
import {
  KIND, LINK_FLAG, LINK_RECORD, MODULE_FLAG, MODULE_RECORD, defaultRecord, type LinkGene, type ModuleGene, type RegGene,
} from '../core/index.js';
import { LINK_RANGE, MOD_RANGE, enc16, enc8 } from './genes.js';

export interface ModSpec {
  len?: number; aspect?: number; span?: number; taper?: number; stiff?: number; lipid?: number; muscle?: number;
  gut?: number; armour?: number; hue?: number; glow?: number; p?: number[]; phase?: number; amp?: number;
  rangeDeg?: number; restDeg?: number; alpha?: number; photo?: number; paired?: boolean; claw?: boolean;
  root?: boolean; recursion?: number; enabled?: boolean;
}
const u8c = (x: number): number => Math.max(0, Math.min(255, Math.round(x)));
const i8c = (x: number): number => Math.max(-128, Math.min(127, Math.round(x)));

/** A module gene from decoded values. `p` gives p1..p5 as raw 0..255 bytes. */
export function makeModule(innov: number, kind: number, subtype: number, s: ModSpec = {}): ModuleGene {
  const m = defaultRecord<ModuleGene>(MODULE_RECORD);
  m.innov = innov; m.kind = kind; m.subtype = subtype;
  m.flags = (s.enabled === false ? 0 : MODULE_FLAG.ENABLED) | (s.root ? MODULE_FLAG.ROOT : 0)
    | (s.paired ? MODULE_FLAG.PAIRED : 0) | (s.claw ? MODULE_FLAG.CLAW : 0);
  m.recursionLimit = Math.max(0, Math.min(7, s.recursion ?? 0));
  m.length = enc16(s.len ?? 1, MOD_RANGE.length);
  m.width = enc16(s.aspect ?? 0.3, MOD_RANGE.width);
  m.span = enc8(s.span ?? 1, MOD_RANGE.span);
  m.taper = u8c((s.taper ?? 0.8) * 255);
  m.stiffness = enc8(s.stiff ?? 1, MOD_RANGE.stiffness);
  m.lipidFraction = u8c(((s.lipid ?? 0.1) / 0.6) * 255);
  m.muscleFraction = u8c(((s.muscle ?? 0.3) / 0.8) * 255);
  m.gutFraction = u8c(((s.gut ?? 0) / 0.7) * 255);
  m.armourCoverage = u8c((s.armour ?? 0) * 255);
  m.hueOffset = i8c((s.hue ?? 0) * 256);
  m.glow = u8c((s.glow ?? 0) * 255);
  const p = s.p ?? [];
  m.p1 = u8c(p[0] ?? 0); m.p2 = u8c(p[1] ?? 0); m.p3 = u8c(p[2] ?? 0); m.p4 = u8c(p[3] ?? 0); m.p5 = u8c(p[4] ?? 0);
  m.cpgPhase = u8c(((s.phase ?? 0) / 360) * 255);
  m.cpgAmp = u8c((s.amp ?? 0) * 255);
  m.jointRange = u8c(((s.rangeDeg ?? 60) / 170) * 255);
  m.jointRest = i8c(((s.restDeg ?? 0) / 90) * 127);
  m.allometry = u8c(((s.alpha ?? 1) - 0.5) * 256);
  m.photoFraction = u8c((s.photo ?? 0) * 255);
  return m;
}

export interface LinkSpec {
  pos?: number; angleDeg?: number; repeat?: number; symmetry?: number; childScale?: number; repeatScale?: number;
  terminalOnly?: boolean; wave?: boolean; phaseStepDeg?: number; enabled?: boolean;
}
export function makeLink(innov: number, from: number, to: number, s: LinkSpec = {}): LinkGene {
  const l = defaultRecord<LinkGene>(LINK_RECORD);
  l.innov = innov; l.fromInnov = from; l.toInnov = to;
  l.attachPos = u8c((s.pos ?? 1) * 255);
  l.attachAngle = i8c(((s.angleDeg ?? 0) / 180) * 128);
  l.repeat = Math.max(1, Math.min(16, s.repeat ?? 1));
  l.symmetry = s.symmetry ?? 0;
  l.childScale = enc8(s.childScale ?? 1, LINK_RANGE.childScale);
  l.repeatScale = enc8(s.repeatScale ?? 1, LINK_RANGE.repeatScale);
  l.flags = (s.enabled === false ? 0 : LINK_FLAG.ENABLED) | (s.terminalOnly ? LINK_FLAG.TERMINAL_ONLY : 0) | (s.wave ? LINK_FLAG.PHASE_WAVE : 0);
  l.phaseStep = u8c(((s.phaseStepDeg ?? 0) / 360) * 255);
  return l;
}

export function makeReg(innov: number, target: number, axis: number, param: number, shape: number, centre: number,
  width: number, amount: number, targetKind = 255): RegGene {
  return {
    innov, targetInnov: target, targetKind, axis, param, shape, centre: u8c(centre * 255),
    width: u8c(((width - 0.01) / 0.99) * 255), amount: i8c(amount * 127), flags: 1,
  };
}

/** Schema-default parameters for a new module of a kind (the add-module operator, 01 §1.6.2). */
export function kindDefaults(kind: number, subtype: number): ModuleGene {
  switch (kind) {
    case KIND.SEGMENT: return makeModule(0, kind, subtype, { len: 1, aspect: 0.35, muscle: 0.3, gut: 0.2, rangeDeg: 40 });
    case KIND.FIN: return makeModule(0, kind, subtype, { len: 0.5, aspect: 0.08, span: 5, muscle: 0.2, rangeDeg: 90, amp: 0.5 });
    case KIND.LIMB: return makeModule(0, kind, subtype, { len: 0.6, aspect: 0.12, muscle: 0.3, rangeDeg: 90, amp: 0.3 });
    case KIND.MOUTH: return makeModule(0, kind, subtype, { len: 0.2, aspect: 0.6, muscle: 0.4, rangeDeg: 30, p: [128, 128, 64, 64] });
    case KIND.EYE: return makeModule(0, kind, subtype, { len: 0.15, aspect: 0.8, muscle: 0, rangeDeg: 0, p: [128, 128, 64, 0b01011011, 128] });
    case KIND.CHEMO: return makeModule(0, kind, subtype, { len: 0.2, aspect: 0.2, muscle: 0, rangeDeg: 20, p: [128, 0x0f, 0] });
    case KIND.SPIKE: return makeModule(0, kind, subtype, { len: 0.3, aspect: 0.15, muscle: 0, rangeDeg: 0, stiff: 5, p: [128] });
    case KIND.PHOTOPHORE: return makeModule(0, kind, subtype, { len: 0.12, aspect: 0.8, muscle: 0, rangeDeg: 0, glow: 0.6, p: [128, 128] });
    case KIND.CILIA: return makeModule(0, kind, subtype, { len: 0.3, aspect: 0.3, muscle: 0.1, rangeDeg: 0, p: [160, 128] });
    case KIND.JET: return makeModule(0, kind, subtype, { len: 0.4, aspect: 0.7, muscle: 0.5, rangeDeg: 20, p: [128] });
    case KIND.BLADDER: return makeModule(0, kind, subtype, { len: 0.3, aspect: 0.7, muscle: 0, rangeDeg: 0, lipid: 0, p: [128, 64] });
    default: return makeModule(0, kind, subtype, { len: 0.2, aspect: 0.6, muscle: 0, rangeDeg: 0, p: [128] });
  }
}
