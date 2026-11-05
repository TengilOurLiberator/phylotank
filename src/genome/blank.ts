/** The Blank template (CONTRACT 10.2 `template('blank')`): a single head segment with default traits. */
import {
  KIND, MODULE_FLAG, MODULE_RECORD, SEGMENT_SUBTYPE, defaultRecord, emptyGenome, type Genome, type ModuleGene,
} from '../core/index.js';

export function blankHead(): ModuleGene {
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
  return head;
}

export function blankGenome(): Genome {
  const g = emptyGenome();
  g.modules = [blankHead()];
  g.rootModuleInnov = 1;
  return g;
}
