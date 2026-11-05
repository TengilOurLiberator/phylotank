import { decodeQ, T, TRAITS } from '../../src/core/index.js';
import { genome } from '../../src/genome/index.js';
const id = (process.argv[2] ?? 'motefly') as never;
const g = genome.template(id);
const ph = genome.develop(g, 1, { depth01: 0.3, tempC: 14 }, { maxParts: 64, lCeilingM: 0.2 });
const tr = (n: string) => decodeQ(g.traits[T[n]!]!, TRAITS[T[n]!]!);
console.log(id, 'mouth', JSON.stringify(ph.mouth), 'gGut', ph.gGut, 'gutVol', ph.gutVolume, 'mass', ph.massKg, 'L', ph.lengthM);
for (const n of ['DIET_PLANT', 'DIET_DETRITUS', 'ADULT_LENGTH', 'GROWTH_RATE', 'BIRTH_FRACTION', 'MATURITY_FRACTION', 'REPRO_RESERVE', 'FAT_CAPACITY', 'CLUTCH_SIZE', 'LIFESPAN_MULT', 'SESSILE', 'SEX_PROB']) console.log(' ', n, tr(n).toFixed(3));
