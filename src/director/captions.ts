/**
 * Captions (06 §6.2.8, DESIGN R30): the documentary lower third. Text templates per story type,
 * a deterministic pseudo-Latin namer keyed by species id (original morpheme tables), and the
 * caption timing and placement rules. The DOM overlay itself belongs to src/ui.
 */
import { hash32 } from '../core/index.js';
import type { Story } from './storybook.js';

const GENUS_A = ['Luc', 'Noct', 'Phot', 'Abyss', 'Glim', 'Umbr', 'Cael', 'Vitr', 'Thal', 'Pel', 'Bath', 'Scot', 'Lamp', 'Aur', 'Hyal', 'Cyan'];
const GENUS_B = ['ella', 'ichthys', 'onema', 'aster', 'ops', 'ura', 'idium', 'ostoma', 'iscus', 'aria', 'odon', 'ina'];
const EPI = ['lucens', 'profunda', 'gracilis', 'vagans', 'serena', 'minuta', 'maxima', 'radians', 'tenebrosa', 'velox', 'placida', 'spinosa', 'errans', 'obscura', 'fulgens', 'nitida'];
const COMMON_A = ['Glass', 'Lantern', 'Ember', 'Veil', 'Spark', 'Drift', 'Thread', 'Moon', 'Ghost', 'Ink', 'Halo', 'Ribbon', 'Pearl', 'Ash', 'Frost', 'Dusk'];
const COMMON_B = ['whip', 'mote', 'fin', 'eel', 'jelly', 'darter', 'worm', 'shrimp', 'ray', 'snail', 'comb', 'wisp'];

export interface SpeciesName { common: string; binomial: string }

/** A stable original name for a species id. */
export function speciesName(id: number): SpeciesName {
  const h = hash32(id >>> 0, 0x6e616d65, 0x31);
  const h2 = hash32(id >>> 0, 0x6e616d65, 0x32);
  const genus = GENUS_A[h & 15]! + GENUS_B[(h >>> 4) % GENUS_B.length]!;
  const epithet = EPI[(h >>> 8) & 15]!;
  const common = COMMON_A[h2 & 15]! + COMMON_B[(h2 >>> 4) % COMMON_B.length]!;
  return { common, binomial: `${genus} ${epithet}` };
}

export interface CaptionText { line1: string; line2: string; species: number | null }

/** Caption text for a story, or null when the type has no caption. */
export function captionFor(s: Story, names: (id: number) => SpeciesName = speciesName): CaptionText | null {
  const sp = s.species[0];
  const nm = sp !== undefined ? names(sp) : null;
  const line1 = nm ? `${nm.common} · ${nm.binomial}` : '';
  switch (s.type) {
    case 'disaster': {
      const p = String(s.info['power'] ?? 'event');
      return { line1: 'The tank', line2: DISASTER[p] ?? 'Something stirs in the tank', species: null };
    }
    case 'speciation': {
      const parent = s.species[1] !== undefined ? names(s.species[1]).common : 'its parent';
      return nm ? { line1, line2: `A new species: the ${nm.common}, split from the ${parent}`, species: sp! } : null;
    }
    case 'lastOfSpecies': return nm ? { line1, line2: `The last ${nm.common}.`, species: sp! } : null;
    case 'extinction': return nm ? { line1, line2: `The ${nm.common} is gone.`, species: sp! } : null;
    case 'record': {
      const kind = String(s.info['kind'] ?? 'size');
      const v = Number(s.info['value'] ?? 0);
      if (kind === 'size') return { line1, line2: `The largest creature this tank has ever grown: ${fmtLen(v)} long`, species: sp ?? null };
      return { line1, line2: `A new tank record for ${kind}`, species: sp ?? null };
    }
    case 'outbreak': {
      const pct = Math.round(100 * Number(s.info['prevalence'] ?? 0));
      return nm ? { line1, line2: `A parasite is spreading through the ${nm.common}: ${pct}% infected`, species: sp! } : null;
    }
    case 'giant': return nm ? { line1, line2: 'A giant of the tank', species: sp! } : null;
    case 'giantKill': return { line1: 'The hunt', line2: 'A giant on the hunt', species: null };
    case 'novelty': return nm ? { line1, line2: 'A body plan this tank has never seen', species: sp! } : null;
    case 'school': return nm ? { line1, line2: `A school of ${Math.round(s.magnitude)} ${nm.common}s`, species: sp! } : null;
    case 'newRole': return nm ? { line1, line2: `The ${nm.common} has found a new way to live`, species: sp! } : null;
    case 'carcass': return { line1: 'A fall', line2: 'Scavengers gather at a carcass', species: null };
    case 'massDeath': return { line1: 'A die-off', line2: `${Math.round(s.magnitude)} creatures died here`, species: null };
    default: return null;
  }
}

const DISASTER: Record<string, string> = {
  meteor: 'A meteor strikes', plague: 'A plague takes hold', coldSnap: 'A cold snap', heatwave: 'A heatwave',
  bloom: 'A bloom spreads', vent: 'A vent opens', currentShift: 'The current shifts', longNight: 'A long night falls',
  mutagen: 'Something in the water changes them', cull: 'A cull', bless: 'A blessing', nutrientFlood: 'A flood of nutrients',
  iceAge: 'An ice age begins', storm: 'A storm above', earthquake: 'The floor shakes', whaleFall: 'Something huge sinks',
};

function fmtLen(m: number): string {
  if (m >= 1) return `${(Math.round(m * 100) / 100).toFixed(2)} m`;
  if (m >= 0.01) return `${Math.round(m * 1000) / 10} cm`;
  return `${Math.round(m * 10000) / 10} mm`;
}

export interface CaptionState {
  text: CaptionText;
  /** Wall second it starts fading in. */
  tShow: number;
  tEnd: number;
  side: 'left' | 'right';
  storyId: number;
}

/** Normalised screen box [x0, y0, x1, y1] (0..1, y down) the caption occupies on a side. */
export function captionBox(side: 'left' | 'right'): [number, number, number, number] {
  return side === 'left' ? [0.05, 0.75, 0.5, 0.95] : [0.5, 0.75, 0.95, 0.95];
}

export function boxesOverlap(a: readonly number[], b: readonly number[]): boolean {
  return a[0]! < b[2]! && b[0]! < a[2]! && a[1]! < b[3]! && b[1]! < a[3]!;
}
