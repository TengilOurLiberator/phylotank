import { describe, expect, it } from 'vitest';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  allocPool, applyColumns, BRAIN_TRAITS, cborDecode, cborEncode, CODEC, CREATURE_COLUMNS, decodeColumns, decodeDust,
  decodeGenome, decodePtkg, decodeViewport, defaultRecord, emptyGenome, encodeColumns, encodeDust, encodeGenome,
  encodePtkg, encodeViewport, FormatError, fourcc, fromPtkString, genomeFingerprint, genomeKey, KIND, MODULE_RECORD,
  decodeCborFrame, encodeCborFrame, FRAME, readPtk, toPtkString, TRAITS, decodeQ, T, writePtk, encodeQ,
  type ModuleGene, type Genome,
} from '../../src/core/index.js';

function sampleGenome(): Genome {
  const g = emptyGenome();
  const head = defaultRecord<ModuleGene>(MODULE_RECORD);
  head.innov = 4096; head.kind = KIND.SEGMENT; head.subtype = 1; head.flags = 3; head.length = 30000;
  const fin = defaultRecord<ModuleGene>(MODULE_RECORD);
  fin.innov = 4097; fin.kind = KIND.FIN; fin.length = 20000;
  g.modules = [fin, head]; // unsorted on purpose
  g.rootModuleInnov = 4096;
  g.links = [{ innov: 5000, fromInnov: 4096, toInnov: 4097, attachPos: 200, attachAngle: -40, repeat: 2, symmetry: 1, childScale: 120, repeatScale: 128, flags: 1, phaseStep: 30 }];
  g.cppnNodes = [{ innov: 0x1234567890abcdefn, fn: 2, flags: 1, bias: -300 }];
  g.directSynapses = [{ src: 7, dst: 9, w: 1024, flags: 1, plasticity: -3 }];
  g.immuneKey = 0xdeadbeef; g.surfaceSig = 0x01020304;
  return g;
}

describe('genome format v1', () => {
  it('round-trips and is canonical', () => {
    const g = sampleGenome();
    const b = encodeGenome(g);
    const g2 = decodeGenome(b);
    expect(g2.modules.map((m) => m.innov)).toEqual([4096, 4097]);
    expect(g2.cppnNodes[0]!.innov).toBe(0x1234567890abcdefn);
    expect(g2.immuneKey).toBe(0xdeadbeef);
    expect(encodeGenome(g2)).toEqual(b);
    expect(genomeKey(g2)).toBe(genomeKey(g));
  });
  it('keeps unknown sections and record tails (forward compatibility)', () => {
    const g = sampleGenome();
    g.unknown.push({ tag: fourcc('ZZZZ'), recordSize: 3, sectionFlags: 0, count: 2, bytes: new Uint8Array([1, 2, 3, 4, 5, 6]) });
    g.modules[0]!.ext = new Uint8Array([9, 9, 9, 9]);
    const g2 = decodeGenome(encodeGenome(g));
    expect(g2.unknown).toHaveLength(1);
    expect(Array.from(g2.unknown[0]!.bytes)).toEqual([1, 2, 3, 4, 5, 6]);
    const withExt = g2.modules.find((m) => m.ext && m.ext.length === 4);
    expect(withExt).toBeDefined();
  });
  it('pads short trait blocks with defaults', () => {
    const g = sampleGenome();
    g.traits = g.traits.slice(0, 10);
    g.traits[0] = 123;
    const g2 = decodeGenome(encodeGenome(g));
    expect(g2.traits.length).toBe(96);
    expect(g2.traits[0]).toBe(123);
    expect(g2.traits[T.TEMP_OPTIMUM!]).toBe(encodeQ(14, TRAITS[T.TEMP_OPTIMUM!]!));
  });
  it('rejects corruption', () => {
    const b = encodeGenome(sampleGenome());
    b[40] = b[40]! ^ 0xff;
    expect(() => decodeGenome(b)).toThrow(FormatError);
  });
  it('decodes the trait defaults to the contract values', () => {
    expect(decodeQ(emptyGenome().traits[T.ADULT_LENGTH!]!, TRAITS[0]!)).toBeCloseTo(0.02, 4);
    expect(BRAIN_TRAITS[0]!.name).toBe('ENCODING');
  });
  it('has a fingerprint', async () => {
    expect(await genomeFingerprint(sampleGenome())).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  });
});

describe('cbor', () => {
  it('round-trips the supported subset', () => {
    const v = { a: 1, b: -7, c: 1.5, d: 'hé', e: [true, false, null], f: new Uint8Array([1, 2]), g: 2 ** 40, h: { x: [] } };
    expect(cborDecode(cborEncode(v))).toEqual(v);
  });
  it('rejects tags and trailing bytes', () => {
    expect(() => cborDecode(new Uint8Array([0xc0, 0x00]))).toThrow(FormatError);
    expect(() => cborDecode(new Uint8Array([0x01, 0x02]))).toThrow(FormatError);
  });
});

describe('protocol', () => {
  it('dust frames round-trip', () => {
    const n = 5;
    const f = { tick: 99, rect: [0, 0, 32, 18] as [number, number, number, number], n, x: new Uint16Array([1, 2, 3, 4, 65535]), y: new Uint16Array(n), colour: new Uint8Array([0, 1, 2, 255, 4]), glow: new Uint8Array(n) };
    const d = decodeDust(encodeDust(f));
    expect(d.tick).toBe(99);
    expect(Array.from(d.x)).toEqual([1, 2, 3, 4, 65535]);
    expect(Array.from(d.colour)).toEqual([0, 1, 2, 255, 4]);
  });
  it('viewport and CBOR frames round-trip', () => {
    const v = decodeViewport(encodeViewport(3, { rect: [1, 2, 3, 4], pxPerM: 60, paused: true, resync: false, leadS: 1 }));
    expect(v.paused).toBe(true);
    expect(v.rect).toEqual([1, 2, 3, 4]);
    const { header, payload } = decodeCborFrame(encodeCborFrame(FRAME.COMMAND, 5, { t: 'snapshot', id: 'x', epoch: 0, label: 'hi' }));
    expect(header.type).toBe(FRAME.COMMAND);
    expect(payload).toEqual({ t: 'snapshot', id: 'x', epoch: 0, label: 'hi' });
  });
});

describe('.ptk container and .ptkg', () => {
  const zlib = { encode: (b: Uint8Array) => new Uint8Array(deflateRawSync(b)), decode: (b: Uint8Array) => new Uint8Array(inflateRawSync(b)) };
  it('round-trips sections and column data', () => {
    const pool = allocPool(CREATURE_COLUMNS, 8);
    pool.highWater = 3;
    pool.c.posX[2] = 12.5; pool.c.qGut[2 * 3 + 1] = 77;
    const cols = encodeColumns(pool);
    const file = writePtk({ container: 1, schema: 1, flags: 1, tick: 12345, simHash: 42n, epoch: 2 }, [
      { fourcc: 'META', data: cborEncode({ name: 'test' }), required: true },
      { fourcc: 'CREA', data: cols, required: true, codec: CODEC.DEFLATE_RAW },
    ], { [CODEC.DEFLATE_RAW]: zlib });
    const back = readPtk(file, { codecs: { [CODEC.DEFLATE_RAW]: zlib } });
    expect(back.header.tick).toBe(12345);
    expect(back.header.epoch).toBe(2);
    const pool2 = allocPool(CREATURE_COLUMNS, 8);
    applyColumns(pool2, decodeColumns(back.sections.get('CREA')!));
    expect(pool2.highWater).toBe(3);
    expect(pool2.c.posX[2]).toBe(12.5);
    expect(pool2.c.qGut[7]).toBe(77);
  });
  it('refuses unknown required sections and corrupted bytes', () => {
    const file = writePtk({ container: 1, schema: 1, flags: 0, tick: 0, simHash: 0n, epoch: 0 }, [{ fourcc: 'XNEW', data: new Uint8Array([1]), required: true }]);
    expect(() => readPtk(file, { knownSections: new Set(['META']) })).toThrow(/newer Phylotank/);
    file[3] = file[3]! ^ 1;
    expect(() => readPtk(file)).toThrow(FormatError);
  });
  it('.ptkg and PTK1 strings round-trip', () => {
    const z = { deflate: (b: Uint8Array) => new Uint8Array(deflateRawSync(b)), inflate: (b: Uint8Array) => new Uint8Array(inflateRawSync(b)) };
    const genome = encodeGenome(sampleGenome());
    const meta = { name: { genus: 'Pratilux', epithet: 'tondens' }, created: '2026-11-05', origin: 'designer' as const, parents: [], tags: [], licence: 'CC0-1.0' as const };
    const bytes = encodePtkg({ kind: 1, genomeVersion: 1, payload: { meta, genome } }, z);
    const s = toPtkString(bytes);
    expect(s.startsWith('PTK1.')).toBe(true);
    const back = decodePtkg(fromPtkString(s), z);
    expect(back.payload.meta.name.genus).toBe('Pratilux');
    expect(decodeGenome(back.payload.genome!).rootModuleInnov).toBe(4096);
  });
});
