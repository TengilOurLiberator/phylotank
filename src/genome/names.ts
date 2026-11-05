/**
 * Generated binomial names (07 §6.4, William's Q9: template names kept, generated binomials for
 * evolved species, Swedish common names on). Deterministic in (world seed, species id, features).
 *
 * Genus = diet root + body-plan or zone root (+ a suffix when needed for uniqueness);
 * epithet = adjective for the most distinctive feature relative to the parent species, agreeing
 * with the genus gender. Original combinations, checked for pronounceability (at most three
 * consonants in a row, 3 to 24 letters) and against a small built-in blocklist. The bundled
 * real-genus list of 07 §6.4 is not shipped in v0.x (see docs/modules/genome.md).
 */
import { hash32 } from '../core/index.js';

export interface NameFeatures {
  /** e_plant, e_meat, e_detritus. */
  diet: [number, number, number];
  filter: number; latch: number;
  /** log-size 0..1 over the schema range. */
  size: number;
  segments: number; fins: number; eyes: number; spikes: number; photophores: number;
  radial: boolean; sessile: boolean;
  /** 0 photic .. 1 midnight (preferred depth). */
  depth: number;
  glowHue: number;
}
export interface Binomial { genus: string; epithet: string; common: { en: string; sv: string } }

const DIET_ROOTS: Record<string, string[]> = {
  plant: ['Prati', 'Phyto', 'Herbi', 'Viri'], meat: ['Vora', 'Dentro', 'Rapto', 'Carno'],
  detritus: ['Cinera', 'Necro', 'Limo', 'Faeco'], filter: ['Cribro', 'Saccu', 'Colo', 'Tami'],
  parasite: ['Haeru', 'Tethi', 'Suga', 'Hirudi'],
};
const ZONE_ROOTS = [['lux', 'sol', 'phos'], ['umbra', 'crepu', 'vesper'], ['bathy', 'nocti', 'abys']];
const PLAN_ROOTS: Record<string, string[]> = {
  long: ['caulus', 'soma', 'taenia'], round: ['sphaera', 'bulla', 'globa'], radial: ['stella', 'campana', 'rota'],
  huge: ['titan', 'corona', 'maxima'],
};
const SUFFIXES = ['', 'a', 'ella', 'opsis', 'ides', 'on'];
const SYLLABLES = ['ra', 'li', 'no', 've', 'ta', 'mi', 'lo', 'ca', 'sa', 'pe', 'ri', 'du', 'mo', 'ne', 'ti', 'la',
  'ro', 'ga', 'be', 'vi', 'na', 'te', 'po', 'si', 'ma', 'le', 'ru', 'ze', 'fa', 'co', 'nu', 'pi'];
/** [feminine, masculine] adjective forms. */
const ADJ: Record<string, [string, string]> = {
  bigger: ['gigantea', 'giganteus'], smaller: ['minima', 'minimus'], blue: ['caerula', 'caerulus'],
  red: ['rubra', 'ruber'], green: ['viridis', 'viridis'], gold: ['aurea', 'aureus'], deeper: ['profunda', 'profundus'],
  shallower: ['superna', 'supernus'], spiny: ['spinata', 'spinatus'], dark: ['tenebrosa', 'tenebrosus'],
  bright: ['lucida', 'lucidus'], finned: ['pinnata', 'pinnatus'], long: ['longa', 'longus'], short: ['brevis', 'brevis'],
  sessile: ['sedentaria', 'sedentarius'], eyed: ['oculata', 'oculatus'], plain: ['simplex', 'simplex'],
  filter: ['cribrata', 'cribratus'], gnawing: ['rodens', 'rodens'],
};
const ADJ_ALT = ['nova', 'altera', 'tertia', 'secunda', 'recens', 'varia', 'mira', 'rara'];

/** Substrings never allowed in generated names (English and Swedish; kept short on purpose). */
const BLOCK = ['fuck', 'shit', 'cunt', 'nigg', 'fag', 'rape', 'piss', 'kuk', 'fitt', 'hora', 'jävl', 'javl', 'bajs', 'slyn',
  'pokem', 'pikach', 'digim', 'godzil', 'kaiju', 'mothra', 'bibit'];

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y']);
export function isPronounceable(s: string): boolean {
  if (s.length < 3 || s.length > 24 || !/^[A-Za-z-]+$/.test(s)) return false;
  let run = 0;
  for (const ch of s.toLowerCase()) {
    if (VOWELS.has(ch) || ch === '-') run = 0; else if (++run > 3) return false;
  }
  const lower = s.toLowerCase();
  return !BLOCK.some((b) => lower.includes(b));
}

function join(a: string, b: string): string {
  const aEnd = a[a.length - 1]!, bStart = b[0]!;
  if (VOWELS.has(aEnd) && VOWELS.has(bStart)) return a + b.slice(1);
  return a + b;
}
const feminine = (genus: string): boolean => /(a|is|x|opsis)$/.test(genus);

function dietKey(f: NameFeatures): string {
  if (f.latch > 0.6) return 'parasite';
  if (f.filter > 0.5 && f.diet[1] < 0.6) return 'filter';
  const [p, m, d] = f.diet;
  return p >= m && p >= d ? 'plant' : m >= d ? 'meat' : 'detritus';
}
function planKey(f: NameFeatures): string | null {
  if (f.size > 0.8) return 'huge';
  if (f.radial) return 'radial';
  if (f.segments >= 5) return 'long';
  if (f.segments <= 1) return 'round';
  return null;
}

/** A new genus name. `taken` lets the caller reroll when a genus is already used in the world. */
export function genusFor(seed: number, speciesId: number, f: NameFeatures, taken: (g: string) => boolean = () => false): string {
  const roots = DIET_ROOTS[dietKey(f)]!;
  const plan = planKey(f);
  const zone = ZONE_ROOTS[f.depth < 0.33 ? 0 : f.depth < 0.66 ? 1 : 2]!;
  const allSeconds = [...ZONE_ROOTS.flat(), ...Object.values(PLAN_ROOTS).flat()];
  for (let attempt = 0; attempt < 256; attempt++) {
    const h = hash32(seed, speciesId, attempt);
    const first = roots[h % roots.length]!;
    // tier 0: the preferred roots; tier 1: any second root; tier 2: an extra syllable between
    const seconds = attempt < 8 ? (plan && (h >>> 8) % 3 !== 0 ? PLAN_ROOTS[plan]! : zone) : allSeconds;
    const second = seconds[(h >>> 12) % seconds.length]!;
    const mid = attempt < 32 ? '' : SYLLABLES[(h >>> 20) % SYLLABLES.length]!;
    const suffix = attempt < 3 ? '' : SUFFIXES[(h >>> 16) % SUFFIXES.length]!;
    const g = join(join(join(first, mid), second), suffix);
    const name = g[0]!.toUpperCase() + g.slice(1).toLowerCase();
    if (isPronounceable(name) && !taken(name)) return name;
  }
  return `${roots[0]!}${SYLLABLES[speciesId % SYLLABLES.length]!}${SYLLABLES[(speciesId >>> 5) % SYLLABLES.length]!}a`;
}

function distinctive(f: NameFeatures, parent: NameFeatures | null): string {
  const cand: [string, number][] = [];
  const p = parent;
  if (p) {
    cand.push([f.size > p.size ? 'bigger' : 'smaller', Math.abs(f.size - p.size) * 8]);
    cand.push([f.depth > p.depth ? 'deeper' : 'shallower', Math.abs(f.depth - p.depth) * 3]);
    cand.push(['spiny', (f.spikes - p.spikes) * 0.8]);
    cand.push([f.eyes < p.eyes ? 'dark' : 'eyed', Math.abs(f.eyes - p.eyes) * 0.7]);
    cand.push(['bright', (f.photophores - p.photophores) * 0.6]);
    cand.push(['finned', (f.fins - p.fins) * 0.6]);
    cand.push([f.segments > p.segments ? 'long' : 'short', Math.abs(f.segments - p.segments) * 0.5]);
    cand.push(['sessile', f.sessile && !p.sessile ? 2 : 0]);
  } else {
    cand.push(['bigger', (f.size - 0.6) * 4], ['smaller', (0.3 - f.size) * 4], ['deeper', (f.depth - 0.6) * 3],
      ['shallower', (0.25 - f.depth) * 3], ['spiny', f.spikes * 0.5], ['dark', f.eyes === 0 ? 1.2 : 0],
      ['bright', f.photophores * 0.4], ['finned', f.fins * 0.3], ['long', (f.segments - 5) * 0.3], ['sessile', f.sessile ? 2 : 0],
      ['filter', f.filter * 0.9]);
  }
  const hueAdj = f.glowHue < 0.08 || f.glowHue > 0.92 ? 'red' : f.glowHue < 0.2 ? 'gold' : f.glowHue < 0.45 ? 'green' : f.glowHue < 0.75 ? 'blue' : 'red';
  cand.push([hueAdj, p ? Math.min(Math.abs(f.glowHue - p.glowHue), 1 - Math.abs(f.glowHue - p.glowHue)) * 4 : 0.5]);
  let best = 'plain', bestV = 0.25;
  for (const [k, v] of cand) if (v > bestV) { best = k; bestV = v; }
  return best;
}

/** The epithet for a species in `genus`; `taken` rerolls through numbered alternatives. */
export function epithetFor(genus: string, f: NameFeatures, parent: NameFeatures | null, taken: (e: string) => boolean = () => false): string {
  const fem = feminine(genus);
  const key = distinctive(f, parent);
  const base = ADJ[key]![fem ? 0 : 1];
  if (!taken(base)) return base;
  for (const alt of ADJ_ALT) {
    const e = fem ? alt : alt.replace(/a$/, 'us');
    if (!taken(e)) return e;
  }
  return base;
}

const ROLE_EN: Record<string, string> = { plant: 'grazer', meat: 'hunter', detritus: 'scavenger', filter: 'filterer', parasite: 'parasite' };
const ROLE_SV: Record<string, string> = { plant: 'betare', meat: 'jägare', detritus: 'asätare', filter: 'filtrerare', parasite: 'parasit' };
const HUE_EN: Record<string, string> = { red: 'red-glow', gold: 'gold-glow', green: 'green-glow', blue: 'blue-glow' };
const HUE_SV: Record<string, string> = { red: 'rödglödande', gold: 'guldglödande', green: 'grönglödande', blue: 'blåglödande' };

/** Locale common names ("blue-glow grazer", "blåglödande betare"). */
export function commonNameFor(f: NameFeatures): { en: string; sv: string } {
  const role = dietKey(f);
  const hue = f.glowHue < 0.08 || f.glowHue > 0.75 ? 'red' : f.glowHue < 0.2 ? 'gold' : f.glowHue < 0.45 ? 'green' : 'blue';
  let en = `${HUE_EN[hue]} ${ROLE_EN[role]}`, sv = `${HUE_SV[hue]} ${ROLE_SV[role]}`;
  if (f.size > 0.8) { en = `giant ${en}`; sv = `jätte${sv}`; }
  else if (f.size < 0.15) { en = `tiny ${en}`; sv = `pytte${sv}`; }
  if (f.spikes >= 2) { en = `spined ${en}`; sv = `taggig ${sv}`; }
  return { en, sv };
}

export function binomialFor(seed: number, speciesId: number, f: NameFeatures, parent: NameFeatures | null,
  inheritGenus: string | null, takenGenus?: (g: string) => boolean, takenEpithet?: (g: string, e: string) => boolean): Binomial {
  const genus = inheritGenus ?? genusFor(seed, speciesId, f, takenGenus);
  const epithet = epithetFor(genus, f, parent, takenEpithet ? (e) => takenEpithet(genus, e) : undefined);
  return { genus, epithet, common: commonNameFor(f) };
}
