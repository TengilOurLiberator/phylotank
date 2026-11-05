/** Event detectors, phase 1 second pass (see docs/modules/events.md). */
export { EventSuite, type DetectorCost, type SuiteOptions } from './suite.js';
export { Scanner, forNear } from './scan.js';
export { CarcassDetector } from './carcass.js';
export { MigrationDetector } from './migration.js';
export { BloomDetector } from './bloom.js';
export { RecordDetector } from './records.js';
export { NoveltyDetector, describe as describeBodyPlan, planText } from './novelty.js';
export { OutbreakDetector } from './outbreak.js';
export { RoleDetector, roleOf, roleShares, type Role } from './roles.js';
export { LineageDetector } from './lineage.js';
export type { Derived, DerivedKind, Detector, NewKinds, Scan, ScoreFields } from './types.js';
