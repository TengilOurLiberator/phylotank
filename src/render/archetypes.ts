/**
 * Synthetic render templates for the seven starter archetypes plus Blank (07 §1.6, DESIGN R23).
 *
 * This is a local adapter: `genome.develop` and `genome.template` are not implemented yet on
 * this branch, so the renderer draws hand-authored skeletons that follow each template's
 * description. When `develop` lands, `templateFromPhenotype` takes over and these remain as
 * fallbacks for the visual tests. Lengths are in body lengths, x forward, y ventral (down).
 */
import type { LookGenes } from './colour.js';
import { buildTemplate, CAP, SkeletonBuilder, type Organ, type RenderTemplate } from './template.js';

export const ARCHETYPES = ['meadowlamp', 'hushmaw', 'sievebell', 'tetherling', 'ashpicker', 'deepcrown', 'motefly', 'blank'] as const;
export type Archetype = (typeof ARCHETYPES)[number];

/** Typical adult length in metres, for the test scenes and the dust fallback. */
export const ARCHETYPE_LENGTH_M: Readonly<Record<Archetype, number>> = {
  meadowlamp: 0.06, hushmaw: 0.12, sievebell: 0.08, tetherling: 0.006, ashpicker: 0.09, deepcrown: 0.2, motefly: 0.0015, blank: 0.04,
};

const genes = (o: Partial<LookGenes>): LookGenes => ({
  pigHue: 0.55, pigSat: 0.4, pigLight: 0.4, opacity: 0.4, lumHue: 0.5, lumGain: 0.3,
  stripeFreq: 0.3, stripeAmp: 0.2, spotDensity: 0, trailGain: 0.5, pulsePeriodS: 4, pulseDuty: 0.5, softness: 1, ...o,
});
const PI = Math.PI;
const rep = <T,>(v: T, n: number): T[] => Array.from({ length: n }, () => v);
const organ = (node: number, radius: number, o: Partial<Organ> = {}): Organ => ({
  node, radius, hueShift: 0, periodS: 4, phase: 0, duty: 0.5, gain: 0.6, depth: 0.5, ...o,
});

function meadowlamp(): RenderTemplate {
  const b = new SkeletonBuilder(0.1);
  b.chain(0, [0.05], [0], [0.075], { r0: 0.09 }); // broad rasp mouth
  const sp = b.chain(0, rep(0.14, 5), [PI, 0.02, 0.02, 0, 0], [0.12, 0.13, 0.12, 0.095, 0.065], { amp0: 0.03, amp1: 0.22, wave: 3.6, bendW: 1 });
  b.chain(sp[4]!, rep(0.07, 4), [0], [0.04, 0.034, 0.024, 0.012], { kind: CAP.FIN, alpha: 0.45, amp0: 0.25, amp1: 0.55, lag0: 3.6, wave: 2.4, r0: 0.05 });
  for (const at of [sp[0]!, sp[2]!]) {
    b.chain(at, [0.14, 0.11], [b.rel(at, PI - 1.15), 0.35], [0.055, 0.022], { kind: CAP.FIN, alpha: 0.32, r0: 0.035, amp0: 0.2, amp1: 0.35, lag0: 1 });
    b.chain(at, [0.12, 0.09], [b.rel(at, PI + 1.2), -0.3], [0.045, 0.02], { kind: CAP.FIN, alpha: 0.26, r0: 0.03, amp0: 0.2, amp1: 0.3, lag0: 2 });
  }
  b.eye(0, 0.05, -0.95, 0.034);
  b.eye(0, 0.07, -0.35, 0.024);
  b.chain(sp[0]!, [0.15, 0.15], [b.rel(sp[0]!, PI), 0], [0.05, 0.04], { kind: CAP.GUT, r0: 0.04 });
  const o1 = b.point(sp[1]!, 0.07, b.rel(sp[1]!, PI / 2));
  const o2 = b.point(sp[3]!, 0.05, b.rel(sp[3]!, PI / 2));
  const t = buildTemplate('meadowlamp', b.nodes, [organ(o1, 0.05, { gain: 0.35, periodS: 3.2 }), organ(o2, 0.04, { gain: 0.3, periodS: 3.2, phase: 0.3 })],
    genes({ pigHue: 0.25, pigSat: 0.65, pigLight: 0.62, opacity: 0.32, lumHue: 0.12, lumGain: 0.22, stripeFreq: 0.55, stripeAmp: 0.5, spotDensity: 0.15, trailGain: 0.35, pulsePeriodS: 3.2 }),
    'undulate', 1.8);
  return t;
}

function hushmaw(red = false): RenderTemplate {
  const b = new SkeletonBuilder(0.17);
  // a huge jaw with a wide gape: two long jaws, separated, with needle teeth
  const upper = b.chain(0, [0.12, 0.12], [-0.38, 0.1], [0.075, 0.03], { r0: 0.13, amp0: 0.03, amp1: 0.03 });
  const lower = b.chain(0, [0.13, 0.13], [0.72, -0.12], [0.06, 0.028], { r0: 0.1, amp0: -0.05, amp1: -0.05 });
  for (const [j, a] of [[upper[0]!, 1.2], [upper[1]!, 1.3], [lower[0]!, -1.25], [lower[1]!, -1.3]] as const) {
    b.chain(j, [0.06], [a], [0.004], { r0: 0.012 });
  }
  const sp = b.chain(0, [0.17, 0.16, 0.14, 0.09], [PI, 0, 0.02, 0], [0.19, 0.15, 0.095, 0.045], { amp0: 0.02, amp1: 0.2, wave: 2.2, bendW: 1 });
  const tip = sp[3]!;
  b.chain(tip, [0.13, 0.07], [-0.6, 0.15], [0.07, 0.02], { kind: CAP.FIN, alpha: 0.5, r0: 0.04, amp0: 0.3, amp1: 0.4, lag0: 2.2 });
  b.chain(tip, [0.13, 0.07], [0.6, -0.15], [0.07, 0.02], { kind: CAP.FIN, alpha: 0.5, r0: 0.04, amp0: 0.3, amp1: 0.4, lag0: 2.2 });
  b.chain(sp[0]!, [0.07, 0.04], [b.rel(sp[0]!, PI - 1.1), 0.2], [0.03, 0.012], { kind: CAP.FIN, alpha: 0.35, r0: 0.025, amp0: 0.3, amp1: 0.3 });
  const lure = b.chain(0, [0.1, 0.1, 0.09, 0.08], [-1.6, 0.5, 0.55, 0.55], [0.012, 0.01, 0.008, 0.007], { amp0: 0.04, amp1: 0.12, wave: 1.2, r0: 0.016 });
  const bulb = b.chain(lure[3]!, [0.02], [0.4], [0.022], { r0: 0.012 });
  b.eye(0, 0.09, -0.75, 0.03);
  b.chain(sp[0]!, [0.16, 0.12], [b.rel(sp[0]!, PI), 0], [0.1, 0.065], { kind: CAP.GUT, r0: 0.08 });
  return buildTemplate(red ? 'hushmaw-red' : 'hushmaw', b.nodes,
    [organ(bulb[0]!, 0.06, red ? { gain: 1.4, hue: 18, chroma: 0.2, periodS: 1.2, depth: 0.9, duty: 0.3 } : { gain: 1.3, hue: 165, chroma: 0.16, periodS: 5, depth: 0.55 })],
    genes({ pigHue: 0.9, pigSat: 0.35, pigLight: 0.08, opacity: 0.75, lumHue: 0.52, lumGain: 0.1, stripeFreq: 0.1, stripeAmp: 0.1, spotDensity: 0.55, trailGain: 0.15, softness: 0.45 }),
    'undulate', 0.9);
}

function sievebell(): RenderTemplate {
  const b = new SkeletonBuilder(0.13);
  const up = b.chain(0, [0.13, 0.13, 0.12], [-1.75, -0.5, -0.55], [0.12, 0.085, 0.045], { amp0: 0.04, amp1: 0.1, pulse: 0.1 });
  const dn = b.chain(0, [0.13, 0.13, 0.12], [1.75, 0.5, 0.55], [0.12, 0.085, 0.045], { amp0: -0.04, amp1: -0.1, pulse: 0.1 });
  const man = b.chain(0, [0.14, 0.1], [PI, 0], [0.05, 0.035], { amp0: 0.02, amp1: 0.05, r0: 0.06 });
  b.chain(0, [0.12], [PI], [0.05], { kind: CAP.GUT, r0: 0.06 });
  const roots = [up[2]!, up[1]!, man[1]!, man[1]!, dn[1]!, dn[2]!];
  const spread = [-0.25, -0.12, -0.05, 0.05, 0.12, 0.25];
  roots.forEach((r, i) => {
    b.chain(r, rep(0.075, 7), [b.rel(r, PI + spread[i]!), 0], [0.016, 0.014, 0.012, 0.01, 0.008, 0.006, 0.004], {
      kind: CAP.FIN, alpha: 0.55, r0: 0.018, amp0: 0.08, amp1: 0.45, wave: 3.5, lag0: i * 0.4,
    });
  });
  const ring = [up[0]!, up[1]!, up[2]!, dn[2]!, dn[1]!, dn[0]!].map((n, i) => organ(n, 0.045, { gain: 0.7, periodS: 4.5, phase: i / 6, depth: 0.6, duty: 0.4 }));
  const t = buildTemplate('sievebell', b.nodes, ring,
    genes({ pigHue: 0.55, pigSat: 0.3, pigLight: 0.75, opacity: 0.06, lumHue: 0.88, lumGain: 0.45, stripeFreq: 0.7, stripeAmp: 0.35, spotDensity: 0, trailGain: 0.6, softness: 1.6 }),
    'jet', 0.6);
  t.radial = true;
  return t;
}

function tetherling(): RenderTemplate {
  const b = new SkeletonBuilder(0.09);
  b.chain(0, [0.12, 0.1], [0, 0.12], [0.03, 0.012], { r0: 0.05, amp0: 0.05, amp1: 0.15 }); // proboscis
  const sp = b.chain(0, [0.26, 0.26], [PI, 0], [0.17, 0.1], { amp0: 0.04, amp1: 0.12, wave: 1.5, bendW: 1 });
  for (const [at, a] of [[sp[0]!, PI + 1.0], [sp[0]!, PI - 1.1], [sp[1]!, PI + 0.7], [sp[1]!, PI - 0.75]] as const) {
    b.chain(at, [0.11, 0.05], [b.rel(at, a), -0.6], [0.012, 0.004], { r0: 0.03 }); // hook spikes
  }
  b.chain(sp[0]!, [0.28], [b.rel(sp[0]!, PI)], [0.06], { kind: CAP.GUT, r0: 0.08 });
  return buildTemplate('tetherling', b.nodes, [],
    genes({ pigHue: 0.97, pigSat: 0.35, pigLight: 0.6, opacity: 0.45, lumHue: 0.3, lumGain: 0, stripeFreq: 0.8, stripeAmp: 0.25, trailGain: 0.1 }),
    'undulate', 2.5);
}

function ashpicker(): RenderTemplate {
  const b = new SkeletonBuilder(0.07);
  b.chain(0, [0.09], [0.55], [0.035], { r0: 0.06 }); // scoop
  b.chain(0, [0.05], [-0.2], [0.03], { r0: 0.05 });
  const sp = b.chain(0, rep(0.085, 7), [PI, 0.03, 0.03, 0.02, 0, 0, 0], [0.085, 0.09, 0.085, 0.075, 0.062, 0.05, 0.04], { amp0: 0.04, amp1: 0.3, wave: 3.6, bendW: 1 });
  const tail = b.chain(sp[6]!, rep(0.06, 6), [0], [0.03, 0.024, 0.018, 0.012, 0.008, 0.004], { amp0: 0.3, amp1: 0.7, lag0: 3.6, wave: 3.5, bendW: 0.5 });
  void tail;
  b.chain(sp[1]!, [0.2, 0.2], [b.rel(sp[1]!, PI + 0.22), -0.12], [0.03, 0.012], { kind: CAP.FIN, alpha: 0.22, r0: 0.02, amp0: 0.05, amp1: 0.15, lag0: 1 });
  b.chain(sp[2]!, [0.12, 0.08], [b.rel(sp[2]!, PI - 0.3), 0.1], [0.025, 0.01], { kind: CAP.FIN, alpha: 0.2, r0: 0.02, amp0: 0.05, amp1: 0.12, lag0: 1.5 });
  b.eye(0, 0.045, -0.75, 0.022);
  b.chain(sp[0]!, [0.13, 0.13, 0.1], [b.rel(sp[0]!, PI), 0, 0], [0.045, 0.04, 0.03], { kind: CAP.GUT, r0: 0.035 });
  const lat = sp.slice(0, 7).map((n, i) => organ(b.point(n, 0.012, b.rel(n, PI / 2)), 0.022, { gain: 0.3, periodS: 7, phase: i * 0.08, depth: 0.4 }));
  return buildTemplate('ashpicker', b.nodes, lat,
    genes({ pigHue: 0.07, pigSat: 0.3, pigLight: 0.22, opacity: 0.6, lumHue: 0.2, lumGain: 0.14, stripeFreq: 0.9, stripeAmp: 0.35, spotDensity: 0.3, trailGain: 0.45 }),
    'undulate', 1.4);
}

function deepcrown(): RenderTemplate {
  const b = new SkeletonBuilder(0.09);
  b.chain(0, [0.09], [-0.15], [0.05], { r0: 0.075 });
  b.chain(0, [0.1], [0.38], [0.042], { r0: 0.065 });
  for (let i = 0; i < 4; i++) b.chain(1 + 1, [0.05, 0.04], [0.2 + i * 0.25, 0.3], [0.005, 0.003], { kind: CAP.FIN, alpha: 0.4, r0: 0.008, amp0: 0.1, amp1: 0.3, lag0: i }); // comb under the jaw
  const sp = b.chain(0, rep(0.095, 9), [PI, 0.02, 0.02, 0.01, 0, -0.01, -0.01, 0, 0], [0.1, 0.112, 0.116, 0.11, 0.1, 0.086, 0.07, 0.054, 0.038], { amp0: 0.015, amp1: 0.16, wave: 3.0, bendW: 1 });
  const ped = b.chain(sp[8]!, [0.06], [0], [0.028], { amp0: 0.2, amp1: 0.2, lag0: 3.0 });
  b.chain(ped[0]!, [0.15, 0.08], [-0.62, 0.12], [0.075, 0.018], { kind: CAP.FIN, alpha: 0.42, r0: 0.03, amp0: 0.25, amp1: 0.35, lag0: 3.3 });
  b.chain(ped[0]!, [0.15, 0.08], [0.62, -0.12], [0.075, 0.018], { kind: CAP.FIN, alpha: 0.42, r0: 0.03, amp0: 0.25, amp1: 0.35, lag0: 3.3 });
  b.chain(sp[1]!, [0.15, 0.13, 0.09], [b.rel(sp[1]!, PI - 0.75), 0.15, 0.15], [0.07, 0.06, 0.02], { kind: CAP.FIN, alpha: 0.3, r0: 0.04, amp0: 0.25, amp1: 0.4, lag0: 0.5 });
  b.chain(sp[1]!, [0.13, 0.11, 0.08], [b.rel(sp[1]!, PI - 1.15), 0.12, 0.12], [0.06, 0.05, 0.018], { kind: CAP.FIN, alpha: 0.18, r0: 0.035, amp0: 0.25, amp1: 0.35, lag0: 1.2 });
  b.chain(sp[3]!, [0.16, 0.14], [b.rel(sp[3]!, PI + 0.32), -0.1], [0.04, 0.012], { kind: CAP.FIN, alpha: 0.25, r0: 0.03, amp0: 0.05, amp1: 0.12, lag0: 1 });
  const crown: number[] = [];
  for (let i = 0; i < 5; i++) {
    const a = -2.55 + i * 0.36;
    const c = b.chain(0, [0.075, 0.05], [a, 0.15], [0.01, 0.003], { r0: 0.022, amp0: 0.02, amp1: 0.05 });
    crown.push(c[1]!);
  }
  b.eye(0, 0.05, -0.6, 0.028);
  b.chain(sp[0]!, [0.15, 0.15, 0.12], [b.rel(sp[0]!, PI), 0, 0], [0.06, 0.058, 0.045], { kind: CAP.GUT, r0: 0.05 });
  const row = sp.map((n, i) => organ(b.point(n, 0.6 * [0.1, 0.112, 0.116, 0.11, 0.1, 0.086, 0.07, 0.054, 0.038][i]!, b.rel(n, PI / 2 - 0.15)), 0.03, { gain: 0.55, periodS: 9, phase: i * 0.06, depth: 0.6, duty: 0.45 }));
  const tips = crown.map((n, i) => organ(n, 0.025, { gain: 0.5, periodS: 9, phase: 0.5 + i * 0.03, hueShift: -25 }));
  return buildTemplate('deepcrown', b.nodes, [...row, ...tips],
    genes({ pigHue: 0.7, pigSat: 0.55, pigLight: 0.28, opacity: 0.55, lumHue: 0.74, lumGain: 0.45, stripeFreq: 0.35, stripeAmp: 0.4, spotDensity: 0.45, trailGain: 0.8, pulsePeriodS: 9 }),
    'undulate', 0.7);
}

function motefly(): RenderTemplate {
  const b = new SkeletonBuilder(0.17);
  b.chain(0, [0.2, 0.2], [PI, 0], [0.22, 0.13], { amp0: 0.01, amp1: 0.05, bendW: 0.5 });
  b.chain(0, [0.16], [PI], [0.09], { kind: CAP.GUT, r0: 0.1 }); // nucleus
  b.chain(0, rep(0.075, 10), [0, 0], [0.016, 0.015, 0.014, 0.013, 0.012, 0.011, 0.01, 0.009, 0.008, 0.006], { amp0: 0.15, amp1: 0.6, wave: 7, r0: 0.02 });
  b.eye(0, 0.12, -1.1, 0.035); // stigma
  const o = b.point(0, 0.2, PI);
  return buildTemplate('motefly', b.nodes, [organ(o, 0.12, { gain: 0.35, periodS: 2.5, depth: 0.4 })],
    genes({ pigHue: 0.36, pigSat: 0.6, pigLight: 0.72, opacity: 0.18, lumHue: 0.05, lumGain: 0.3, stripeFreq: 0.2, stripeAmp: 0.1, trailGain: 0.3, softness: 1.5 }),
    'undulate', 6);
}

function blank(): RenderTemplate {
  const b = new SkeletonBuilder(0.12);
  b.chain(0, [0.06], [0], [0.07], { r0: 0.1 });
  const sp = b.chain(0, [0.35], [PI], [0.13], { amp0: 0.05, amp1: 0.12, bendW: 1 });
  b.chain(sp[0]!, [0.16, 0.12], [0, 0], [0.07, 0.025], { kind: CAP.FIN, alpha: 0.4, r0: 0.05, amp0: 0.2, amp1: 0.5, lag0: 1, wave: 1.5 });
  b.eye(0, 0.06, -0.8, 0.03);
  b.chain(0, [0.3], [PI], [0.06], { kind: CAP.GUT, r0: 0.06 });
  return buildTemplate('blank', b.nodes, [],
    genes({ pigHue: 0.55, pigSat: 0.4, pigLight: 0.4, opacity: 0.4, lumHue: 0.5, lumGain: 0.3 * 0.5 }), 'undulate', 1.5);
}

const cache = new Map<string, RenderTemplate>();
/** The synthetic template for an archetype (cached). `red` selects the red-lure Hushmaw variant used by the safety tests. */
export function archetypeTemplate(a: Archetype, variant: '' | 'red' = ''): RenderTemplate {
  const key = variant ? `${a}-${variant}` : a;
  let t = cache.get(key);
  if (!t) {
    switch (a) {
      case 'meadowlamp': t = meadowlamp(); break;
      case 'hushmaw': t = hushmaw(variant === 'red'); break;
      case 'sievebell': t = sievebell(); break;
      case 'tetherling': t = tetherling(); break;
      case 'ashpicker': t = ashpicker(); break;
      case 'deepcrown': t = deepcrown(); break;
      case 'motefly': t = motefly(); break;
      default: t = blank();
    }
    cache.set(key, t);
  }
  return t;
}
