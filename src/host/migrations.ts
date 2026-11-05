/**
 * Chained `.ptk` schema migrations (05 §5.4.5). Each step is a pure function that moves the
 * section map from schema N to N + 1; they run in order on load. Old files are never rewritten
 * in place; the next save is written at the current schema.
 */
import { FormatError, PTK_SCHEMA_VERSION } from '../core/index.js';

export type SectionMap = Map<string, Uint8Array>;
export interface Migration { from: number; description: string; apply(s: SectionMap): SectionMap }

/** Production chain. Schema 1 is the first, so it is empty in v0.x. */
const CHAIN: Migration[] = [];

export function registeredMigrations(): readonly Migration[] { return CHAIN; }

/**
 * Run the chain from `schema` up to `target`. `chain` is injectable for tests. A file newer than
 * this build is refused with a readable message, never a crash.
 */
export function migrateSections(schema: number, sections: SectionMap, target = PTK_SCHEMA_VERSION, chain: readonly Migration[] = CHAIN): SectionMap {
  if (!Number.isInteger(schema) || schema < 0) throw new FormatError(`bad schema version ${schema}`);
  if (schema > target) throw new FormatError(`This world needs a newer Phylotank (schema ${schema}, this build reads ${target})`);
  let s = new Map(sections);
  for (let v = schema; v < target; v++) {
    const step = chain.find((m) => m.from === v);
    if (!step) throw new FormatError(`no migration from schema ${v} to ${v + 1}`);
    s = step.apply(new Map(s));
  }
  return s;
}
