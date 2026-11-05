/**
 * Local adapter for payloads the contract names but does not shape yet (STATS, INSPECT detail,
 * the snapshot list, GENOME and INSPECT binary codecs). Filed as docs/contract-requests/ui.md;
 * when core gains these, this file shrinks to re-exports.
 */
import { ByteReader, ByteWriter, FRAME, HEADER_BYTES, readHeader, writeHeader } from '../../core/index.js';

export type SnapshotKind = 'manual' | 'auto' | 'beforePower' | 'beforeRewind';
export interface SnapshotInfo { id: string; name: string; tick: number; epoch: number; kind: SnapshotKind; life: number; species: number; parentId?: string }
export interface SpeciesInfo {
  id: number; name: string; common?: string; count: number; biomassKg: number; colour: [number, number, number];
  parent: number; bornTick: number; extinctTick?: number; origin: 'template' | 'designed' | 'natural' | 'imported' | 'captured';
  leviathan?: boolean; glyph: number; prefDepth: number;
}
export interface SpeedInfo { requested: number | 'max'; achieved: number; until?: { tick?: number; wallIso?: string }; unattended?: boolean; leaseLeftS?: number }
export interface KinNode { id: number; gen: number; alive: boolean; species: number }
export interface BrainGraph { inputs: string[]; outputs: string[]; hidden: number; edges: [number, number, number][] }
export interface InspectDetail {
  id: number; species: number; energy: number; health: number; ageS: number; lengthM: number; adult: boolean; generation: number;
  offspring: number; action: string; parents: number[]; ancestors: KinNode[]; collapsed: number; children: KinNode[];
  genomeLo: number; genomeHi: number; pos: [number, number]; brain: BrainGraph;
}
export interface StatsPayload {
  tick: number; epoch: number; speed: SpeedInfo; population: number; species: SpeciesInfo[];
  snapshots: SnapshotInfo[];
  /** Full history on (re)connect, then one sample per STATS: [tick, [speciesId, count]...]. */
  history?: [number, number[]][];
  sample?: [number, number[]];
  /** 32-bin histograms per trait name per species id, every 5 s. */
  genes?: Record<string, Record<string, number[]>>;
  selected?: InspectDetail;
  env?: { tempC: number; light: number; vents: [number, number][] };
  /** Current world settings and balancing knobs (07 §3.9), as the host applied them. */
  settings?: Record<string, number | string | boolean>;
  /** Energy flows over the last 10 sim-minutes for the food web (07 §3.6). */
  web?: FoodWeb;
}

/** Abiotic food-web nodes (Ecopath convention: trophic level 1). */
export const ABIOTIC = { plankton: -1, plants: -2, detritus: -3 } as const;
/** Flow kinds: 0 eating (grazing, predation, filtering), 1 parasitism, 2 scavenging. */
export type FlowKind = 0 | 1 | 2;
/** `flows`: [from (eaten), to (eater), kg per sim-day, kind]; negative ids are ABIOTIC nodes. */
export interface FoodWeb { windowS: number; flows: [number, number, number, FlowKind][] }

// ---------- INSPECT (0x22): u32 idLo, idHi, u16 nNeu, i8 x nNeu, u8 nScope, f32 x nScope ----------
export interface InspectFrame { tick: number; id: number; act: Int8Array; scope: Float32Array }
export function encodeInspect(tick: number, id: number, act: Int8Array, scope: Float32Array = new Float32Array(0)): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 12 + act.length + scope.length * 4);
  writeHeader(w, FRAME.INSPECT, tick);
  w.u64n(id).u16(act.length);
  for (const a of act) w.i8(a);
  w.u8(scope.length);
  for (const s of scope) w.f32(s);
  return w.finish();
}
export function decodeInspect(bytes: Uint8Array): InspectFrame {
  const h = readHeader(bytes);
  const r = new ByteReader(bytes, HEADER_BYTES);
  const id = r.u64n();
  const n = r.u16();
  const act = new Int8Array(n);
  for (let i = 0; i < n; i++) act[i] = r.i8();
  let scope = new Float32Array(0);
  try { const k = r.u8(); scope = new Float32Array(k); for (let i = 0; i < k; i++) scope[i] = r.f32(); } catch { /* older writer */ }
  return { tick: h.tick, id, act, scope };
}

// ---------- GENOME_REQ (0x40) and GENOME (0x41) ----------
export function encodeGenomeReq(tick: number, keys: [number, number][]): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 2 + keys.length * 8);
  writeHeader(w, FRAME.GENOME_REQ, tick);
  w.u16(keys.length);
  for (const [lo, hi] of keys) w.u32(lo).u32(hi);
  return w.finish();
}
export function decodeGenomeReq(bytes: Uint8Array): [number, number][] {
  const r = new ByteReader(bytes, HEADER_BYTES);
  const n = r.u16();
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) out.push([r.u32(), r.u32()]);
  return out;
}
export function encodeGenomeFrame(tick: number, lo: number, hi: number, g: Uint8Array): Uint8Array {
  const w = new ByteWriter(HEADER_BYTES + 12 + g.length);
  writeHeader(w, FRAME.GENOME, tick);
  w.u32(lo).u32(hi).u32(g.length).bytes(g);
  return w.finish();
}
export function decodeGenomeFrame(bytes: Uint8Array): { lo: number; hi: number; genome: Uint8Array } {
  const r = new ByteReader(bytes, HEADER_BYTES);
  const lo = r.u32(), hi = r.u32(), n = r.u32();
  return { lo, hi, genome: r.bytes(n).slice() };
}
