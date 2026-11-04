/**
 * The physics view of a developed body (02 §2.2.2), read from the canonical Phenotype through
 * `toSegmentSpecs` (DESIGN R10). Physics never reads raw genes.
 */
import { NotImplementedError, type Phenotype } from '../core/index.js';

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
}

export function toSegmentSpecs(ph: Phenotype): SegmentSpec[] {
  void ph;
  throw new NotImplementedError('physics.toSegmentSpecs');
}
