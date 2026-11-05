/**
 * The physics view of a developed body (02 §2.2.2), read from the canonical Phenotype through
 * `toSegmentSpecs` (DESIGN R10). Physics never reads raw genes.
 *
 * Conventions (docs/modules/physics.md): a segment's axis unit `t = (cos angle, sin angle)` runs
 * from its base (the end attached to the parent) to its tip. `attachU` is the attachment point
 * on the parent from -0.5 (parent base) to +0.5 (parent tip). The root's axis is the heading.
 */
import { KIND, type Phenotype } from '../core/index.js';
import { DAMPING_DEFAULT, YOUNGS_DEFAULT } from './constants.js';

export interface SegmentSpec {
  parent: number;
  attachU: number;
  restAngle: number;
  length: number;
  radius: number;
  span: number;
  kind: number;
  organs: number;
  muscleFrac: number;
  lipidFrac: number;
  armour: number;
  youngsE: number;
  limitLo: number;
  limitHi: number;
  damping: number;
  /** True for thin plates (fins): plate mass, drag and added mass. */
  plate: boolean;
}

const MIN_DIM = 1e-5;

export function toSegmentSpecs(ph: Phenotype): SegmentSpec[] {
  const out: SegmentSpec[] = [];
  for (let i = 0; i < ph.nParts; i++) {
    const kind = ph.kind[i]!;
    const radius = Math.max(MIN_DIM * 0.5, ph.radius[i]!);
    const length = Math.max(MIN_DIM, ph.length[i]!);
    const span = ph.span[i]! > 0 ? ph.span[i]! : 2 * radius;
    let lo = ph.limitLo[i]!;
    let hi = ph.limitHi[i]!;
    if (!(lo <= hi)) { const t = lo; lo = hi; hi = t; }
    const armour = Math.min(0.5, Math.max(0, ph.armour[i]!));
    // armour narrows the joint range about the rest angle (02 §2.2.4)
    const rest = ph.restAngle[i]!;
    lo = rest + (lo - rest) * (1 - armour);
    hi = rest + (hi - rest) * (1 - armour);
    out.push({
      parent: ph.parent[i]!,
      attachU: Math.min(0.5, Math.max(-0.5, ph.attachU[i]!)),
      restAngle: rest,
      length, radius, span, kind,
      organs: ph.organs[i]!,
      muscleFrac: Math.min(0.8, Math.max(0, ph.muscleFrac[i]!)),
      lipidFrac: Math.min(0.6, Math.max(0, ph.lipidFrac[i]!)),
      armour,
      youngsE: ph.youngsE[i]! > 0 ? ph.youngsE[i]! : YOUNGS_DEFAULT,
      limitLo: lo, limitHi: hi,
      damping: ph.damping[i]! > 0 ? Math.min(0.5, Math.max(0.05, ph.damping[i]!)) : DAMPING_DEFAULT,
      plate: kind === KIND.FIN,
    });
  }
  return out;
}
