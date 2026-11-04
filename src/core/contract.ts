/**
 * Module interfaces (CONTRACT 10.2). Every module's index.ts exports an object implementing
 * one of these. The sim orchestrator depends only on these interfaces.
 */
import type { RngStreams } from './rng.js';
import type {
  BirthEnv, BrainLayout, CommandResult, DevelopOptions, EventSink, Genome, GodCommand, GodEventScheduled,
  LedgerAudit, Phenotype, SimEvent, ViewMode, ViewProfile, WorldConfig,
} from './types.js';
import type { World } from './world.js';

export class NotImplementedError extends Error {
  constructor(what: string) { super(`not implemented yet: ${what}`); this.name = 'NotImplementedError'; }
}

export interface StepContext {
  readonly tick: number;
  readonly config: Readonly<WorldConfig>;
  readonly rng: RngStreams;
  readonly events: EventSink;
}

export type TemplateId =
  | 'meadowlamp' | 'hushmaw' | 'sievebell' | 'tetherling' | 'ashpicker' | 'deepcrown' | 'motefly' | 'blank';

export interface MutationContext {
  readonly rng: RngStreams;
  readonly tick: number;
  /** New entity id of the child: the counter subject for MUTATION and CROSSOVER draws. */
  readonly childId: number;
  /** World size ceiling (CONTRACT 3.3); ignored for leviathan genomes. */
  readonly lCeilingM: number;
  /** Mutation-rate multiplier from god powers (mutagen). */
  readonly mutagen: number;
}

export interface GenomeModule {
  develop(g: Genome, maturity: number, env: BirthEnv, opts: DevelopOptions): Phenotype;
  mutate(g: Genome, ctx: MutationContext): Genome;
  crossover(bearer: Genome, donor: Genome, ctx: MutationContext): Genome;
  repair(g: Genome): Genome;
  distance(a: Genome, b: Genome): number;
  template(id: TemplateId): Genome;
}

export interface PhysicsModule {
  loadBody(world: World, slot: number, ph: Phenotype): void;
  restage(world: World, slot: number, ph: Phenotype): void;
  step(world: World, ctx: StepContext): void;
}

export interface BrainModule {
  layout(ph: Phenotype, g: Genome): BrainLayout;
  allocate(world: World, slot: number, ph: Phenotype, g: Genome, ctx: StepContext): boolean;
  free(world: World, slot: number): void;
  sense(world: World, ctx: StepContext): void;
  think(world: World, ctx: StepContext): void;
}

export interface EcosystemModule {
  initWorld(world: World, ctx: StepContext): void;
  /** Water velocity at (x, y) in m/s, written to out[0], out[1]. */
  flowAt(world: World, x: number, y: number, out: Float64Array): void;
  stepEcology(world: World, ctx: StepContext): void;
  stepSlow(world: World, ctx: StepContext): void;
  applyGodEvent(world: World, ev: GodEventScheduled, ctx: StepContext): void;
  audit(world: World): LedgerAudit;
}

export interface SimCore {
  create(config: WorldConfig): World;
  step(world: World): void;
  hash(world: World): bigint;
}

// ---------------- View-side interfaces ----------------
export interface Camera {
  /** Centre in world metres. */
  cx: number;
  cy: number;
  /** log2 pixels per metre. */
  zeta: number;
}

export interface DirectorModule {
  /** Pure function of (event log, census, seed, wall dt): the next camera target. */
  update(events: readonly SimEvent[], dtWall: number, current: Camera): Camera;
  caption(): string | null;
}

export interface AudioModule {
  start(): Promise<void>;
  stop(): void;
  setMood(m: { activity: number; richness: number; stress: number; darkness: number; season: number }): void;
}

export interface RendererModule {
  readonly ok: boolean;
  resize(widthPx: number, heightPx: number, dpr: number): void;
  /** Feed one decoded or raw protocol frame. */
  ingest(frame: Uint8Array): void;
  render(nowMs: number, camera: Camera): void;
  readonly profile: ViewProfile;
}

/** A transport-agnostic link from a view to a sim (worker or host socket). */
export interface SimLink {
  onFrame(cb: (frame: Uint8Array) => void): void;
  send(frame: Uint8Array): void;
  close(): void;
  readonly kind: 'worker' | 'socket';
}

export interface HostModule {
  start(opts: { port: number; staticDir: string; config: WorldConfig }): Promise<{ port: number; stop(): Promise<void> }>;
  command(cmd: GodCommand): CommandResult;
}

export type { ViewMode };
