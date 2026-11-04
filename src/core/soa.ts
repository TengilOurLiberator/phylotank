/**
 * Structure-of-arrays allocation (CONTRACT 5). A pool is a set of named TypedArray columns,
 * all with the same slot capacity, carved from one ArrayBuffer. Column specs are data, so the
 * same list drives allocation, snapshots (.ptk column sections), hashing and a future GPU
 * buffer packing.
 */

export type ColType = 'f64' | 'f32' | 'u32' | 'i32' | 'u16' | 'i16' | 'u8' | 'i8';

export interface ColumnSpec {
  readonly name: string;
  readonly type: ColType;
  /** Values per slot, stored contiguously: array[slot * lanes + lane]. Default 1. */
  readonly lanes?: number;
  /** Initial value for every element (default 0). */
  readonly init?: number;
  readonly doc?: string;
}

export type ArrayFor<T extends ColType> =
  T extends 'f64' ? Float64Array :
  T extends 'f32' ? Float32Array :
  T extends 'u32' ? Uint32Array :
  T extends 'i32' ? Int32Array :
  T extends 'u16' ? Uint16Array :
  T extends 'i16' ? Int16Array :
  T extends 'u8' ? Uint8Array :
  Int8Array;

export type AnyTypedArray =
  Float64Array | Float32Array | Uint32Array | Int32Array | Uint16Array | Int16Array | Uint8Array | Int8Array;

export type Columns<S extends readonly ColumnSpec[]> = {
  [C in S[number] as C['name']]: ArrayFor<C['type']>;
};

export interface Pool<S extends readonly ColumnSpec[]> {
  readonly spec: S;
  readonly capacity: number;
  /** One past the highest slot ever used. Loops run 0..highWater. */
  highWater: number;
  readonly c: Columns<S>;
  readonly buffer: ArrayBuffer;
}

export const TYPE_BYTES: Readonly<Record<ColType, number>> = {
  f64: 8, f32: 4, u32: 4, i32: 4, u16: 2, i16: 2, u8: 1, i8: 1,
};

/** Type codes used in .ptk column sections (CONTRACT 14.1). */
export const TYPE_CODE: Readonly<Record<ColType, number>> = {
  f64: 0, f32: 1, u32: 2, i32: 3, u16: 4, i16: 5, u8: 6, i8: 7,
};
export const CODE_TYPE: readonly ColType[] = ['f64', 'f32', 'u32', 'i32', 'u16', 'i16', 'u8', 'i8'];

export function makeArray(type: ColType, buffer: ArrayBufferLike, offset: number, length: number): AnyTypedArray {
  switch (type) {
    case 'f64': return new Float64Array(buffer, offset, length);
    case 'f32': return new Float32Array(buffer, offset, length);
    case 'u32': return new Uint32Array(buffer, offset, length);
    case 'i32': return new Int32Array(buffer, offset, length);
    case 'u16': return new Uint16Array(buffer, offset, length);
    case 'i16': return new Int16Array(buffer, offset, length);
    case 'u8': return new Uint8Array(buffer, offset, length);
    case 'i8': return new Int8Array(buffer, offset, length);
  }
}

function align8(n: number): number { return (n + 7) & ~7; }

/** Bytes needed for a pool of this spec and capacity. */
export function poolBytes(spec: readonly ColumnSpec[], capacity: number): number {
  let total = 0;
  for (const col of spec) total = align8(total + TYPE_BYTES[col.type] * (col.lanes ?? 1) * capacity);
  return total;
}

/** Allocate a pool. Columns are 8-byte aligned in declaration order. */
export function allocPool<const S extends readonly ColumnSpec[]>(spec: S, capacity: number): Pool<S> {
  const names = new Set<string>();
  for (const col of spec) {
    if (names.has(col.name)) throw new Error(`duplicate column ${col.name}`);
    names.add(col.name);
  }
  const buffer = new ArrayBuffer(poolBytes(spec, capacity));
  const c: Record<string, AnyTypedArray> = {};
  let off = 0;
  for (const col of spec) {
    const len = (col.lanes ?? 1) * capacity;
    const arr = makeArray(col.type, buffer, off, len);
    if (col.init !== undefined && col.init !== 0) arr.fill(col.init);
    c[col.name] = arr;
    off = align8(off + TYPE_BYTES[col.type] * len);
  }
  return { spec, capacity, highWater: 0, c: c as Columns<S>, buffer };
}

/** Byte view of the live part [0, highWater) of one column, for hashing and snapshots. */
export function liveBytes(pool: Pool<readonly ColumnSpec[]>, name: string): Uint8Array {
  const col = pool.spec.find((s) => s.name === name);
  if (!col) throw new Error(`no column ${name}`);
  const arr = (pool.c as Record<string, AnyTypedArray>)[name]!;
  const n = TYPE_BYTES[col.type] * (col.lanes ?? 1) * pool.highWater;
  return new Uint8Array(arr.buffer, arr.byteOffset, n);
}

/** Reset one slot of every column to its initial value. */
export function clearSlot(pool: Pool<readonly ColumnSpec[]>, slot: number): void {
  for (const col of pool.spec) {
    const lanes = col.lanes ?? 1;
    const arr = (pool.c as Record<string, AnyTypedArray>)[col.name]!;
    arr.fill(col.init ?? 0, slot * lanes, (slot + 1) * lanes);
  }
}
