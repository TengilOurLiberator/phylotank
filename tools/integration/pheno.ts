import { genome } from '../../src/genome/index.js';
import { lifeHistory } from '../../src/genome/index.js';
const ids = ['motefly', 'meadowlamp', 'hushmaw', 'sievebell', 'tetherling', 'ashpicker', 'deepcrown'] as const;
for (const id of ids) {
  const g = genome.template(id);
  const p = genome.develop(g, 1, { depth01: 0.3, tempC: 14 }, { maxParts: 64, lCeilingM: 0.2 });
  const kinds = Array.from(p.kind.subarray(0, p.nParts)).join(',');
  let lh: unknown = '';
  try { lh = (lifeHistory as (g: unknown, l: number) => unknown)(g, 0.2); } catch (e) { lh = String(e); }
  console.log(id, 'parts', p.nParts, 'kinds', kinds, 'L', p.lengthM?.toFixed?.(4), 'm', p.massKg.toExponential(2), JSON.stringify(lh).slice(0, 200));
}
