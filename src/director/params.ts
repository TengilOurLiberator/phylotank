/**
 * Director parameters (06 §6.2.4 to §6.2.8 and §6.4), one record per profile. All initial values
 * come from the design tables; changes made here are recorded in docs/modules/director.md.
 */
import type { ViewMode } from '../core/index.js';

export type StoryType =
  | 'disaster' | 'lastOfSpecies' | 'speciation' | 'giantKill' | 'record' | 'massDeath' | 'carcass'
  | 'novelty' | 'hunt' | 'kill' | 'outbreak' | 'school' | 'mating' | 'giant' | 'birthNotable'
  // the ecosystem's extra kinds (DESIGN R19) and a few the 06 table leaves implicit
  | 'extinction' | 'frenzy' | 'migration' | 'bloomFront' | 'newRole' | 'endangered' | 'release';

export type ShotKind = 'establish' | 'track' | 'pushIn' | 'reveal' | 'aftermath' | 'drift';

export interface TypeParams {
  /** Base weight W. */
  w: number;
  /** Recency time constant in sim seconds (Infinity: "until it ends"). */
  tau: number;
  /** Magnitude scale m0. */
  m0: number;
  /** Shot sequence used to film it. */
  shots: ShotKind[];
  /** Interrupt-class: may cut in after 2 s of any shot when S > 8. */
  interrupt: boolean;
  /** Repeats of the same primary subject are allowed (lastOfSpecies, disasters). */
  repeatOk: boolean;
}

export const TYPE_PARAMS: Readonly<Record<StoryType, TypeParams>> = {
  disaster:      { w: 10,  tau: 120,      m0: 5,    shots: ['establish', 'pushIn', 'aftermath'], interrupt: true,  repeatOk: true },
  lastOfSpecies: { w: 6,   tau: Infinity, m0: 1,    shots: ['pushIn'],                         interrupt: true,  repeatOk: true },
  speciation:    { w: 5,   tau: 600,      m0: 10,   shots: ['establish'],                      interrupt: false, repeatOk: false },
  giantKill:     { w: 5,   tau: 20,       m0: 1,    shots: ['track'],                          interrupt: true,  repeatOk: false },
  record:        { w: 4.5, tau: 900,      m0: 10,   shots: ['reveal'],                         interrupt: false, repeatOk: false },
  massDeath:     { w: 4,   tau: 120,      m0: 20,   shots: ['establish'],                      interrupt: false, repeatOk: false },
  carcass:       { w: 4,   tau: 600,      m0: 3,    shots: ['reveal'],                         interrupt: false, repeatOk: false },
  novelty:       { w: 3.5, tau: 900,      m0: 1,    shots: ['pushIn'],                         interrupt: false, repeatOk: false },
  hunt:          { w: 3,   tau: 8,        m0: 1,    shots: ['track'],                          interrupt: false, repeatOk: false },
  kill:          { w: 3,   tau: 15,       m0: 0.05, shots: ['aftermath'],                      interrupt: false, repeatOk: false },
  outbreak:      { w: 3,   tau: 300,      m0: 0.02, shots: ['pushIn'],                         interrupt: false, repeatOk: false },
  school:        { w: 2.5, tau: 120,      m0: 30,   shots: ['establish', 'track'],             interrupt: false, repeatOk: false },
  mating:        { w: 2,   tau: 15,       m0: 0.05, shots: ['track'],                          interrupt: false, repeatOk: false },
  giant:         { w: 2,   tau: 60,       m0: 1,    shots: ['reveal'],                         interrupt: false, repeatOk: false },
  birthNotable:  { w: 1.5, tau: 20,       m0: 10,   shots: ['pushIn'],                         interrupt: false, repeatOk: false },
  extinction:    { w: 5,   tau: 30,       m0: 1,    shots: ['aftermath'],                      interrupt: true,  repeatOk: true },
  frenzy:        { w: 3.5, tau: 60,       m0: 5,    shots: ['establish'],                      interrupt: false, repeatOk: false },
  migration:     { w: 2,   tau: 120,      m0: 0.2,  shots: ['establish'],                      interrupt: false, repeatOk: false },
  bloomFront:    { w: 1.5, tau: 120,      m0: 1,    shots: ['establish'],                      interrupt: false, repeatOk: false },
  newRole:       { w: 4.5, tau: 600,      m0: 1,    shots: ['pushIn'],                         interrupt: false, repeatOk: false },
  endangered:    { w: 3,   tau: 300,      m0: 1,    shots: ['pushIn'],                         interrupt: false, repeatOk: false },
  release:       { w: 4,   tau: 120,      m0: 1,    shots: ['reveal'],                         interrupt: false, repeatOk: false },
};

export interface ShotParams { fill: number; hold: [number, number]; omega: number }

/** Shot framing and holds (screensaver values, 06 §6.2.5). */
export const SHOT_PARAMS: Readonly<Record<ShotKind, ShotParams>> = {
  establish: { fill: 0.25, hold: [10, 20], omega: 0.4 },
  track:     { fill: 0.35, hold: [8, 40], omega: 1.5 },
  pushIn:    { fill: 0.2,  hold: [12, 25], omega: 0.8 },
  reveal:    { fill: 0.4,  hold: [14, 25], omega: 0.8 },
  aftermath: { fill: 0.3,  hold: [5, 10], omega: 0.6 },
  drift:     { fill: 0.3,  hold: [0, Infinity], omega: 0.4 },
};

export interface DirectorParams {
  tickHz: number;
  a: number;
  switchMargin: number;
  softmaxTemp: number;
  candidateFrac: number;
  interruptScore: number;
  interruptAfterS: number;
  aftermathHoldS: number;
  idleThreshold: number;
  idleAfterS: number;
  diversityWindowS: number;
  diversityHigh: number;
  diversityLow: number;
  /** Exposure half-lives (wall s) and betas, 06 §6.2.4. */
  halfLife: { entity: number; species: number; type: number; region: number };
  beta: { entity: number; species: number; type: number; region: number };
  regionCellM: number;
  travelU0: number;
  mergeRadiusM: number;
  mergeWindowS: number;
  maxStories: number;
  /** No entity is the primary subject twice within this many wall seconds (property 1). */
  repeatWindowS: number;
  godLeadS: number;
  /** Camera limits. */
  panLimit: number;   // screen widths per second
  zoomLimit: number;  // octaves per second
  accelLimit: number; // screen widths per second squared
  zoomAccelLimit: number; // octaves per second squared
  /** Zoom paths may run at this multiple of the steady limits (decision D3 in docs/modules/director.md). */
  pathLimitScale: number;
  /** Zoom paths may accelerate at this multiple of the steady acceleration limits (D3). */
  pathAccelScale: number;
  rho: number;
  pathV: number;
  pathMinS: number;
  pathMaxS: number;
  glideMaxU: number;
  zoomPathMaxU: number;
  dipDownS: number;
  dipUpS: number;
  dipFloor: number;
  dipMinGapS: number;
  holdScale: number;
  weightScale: number;
  glidesOnly: boolean;
  wobble: boolean;
  /** Habitat margin as a fraction of the tank height. */
  marginFrac: number;
  /** Tightest view: visible height in metres. */
  minVisH: number;
  captions: null | { holdS: number; minGapS: number; settleS: number; fadeInS: number; fadeOutS: number };
  stories: boolean;
}

const BASE: DirectorParams = {
  tickHz: 2,
  a: 0.5,
  switchMargin: 0.35,
  softmaxTemp: 0.15,
  candidateFrac: 0.6,
  interruptScore: 8,
  interruptAfterS: 2,
  aftermathHoldS: 3,
  idleThreshold: 0.8,
  idleAfterS: 5,
  diversityWindowS: 20 * 60,
  diversityHigh: 0.5,
  diversityLow: 0.4,
  halfLife: { entity: 30 * 60, species: 10 * 60, type: 4 * 60, region: 3 * 60 },
  beta: { entity: 0.15, species: 0.04, type: 0.01, region: 0.01 },
  regionCellM: 32,
  travelU0: 4,
  mergeRadiusM: 20,
  mergeWindowS: 10,
  maxStories: 512,
  repeatWindowS: 15 * 60,
  godLeadS: 3,
  panLimit: 0.25,
  zoomLimit: 0.35,
  accelLimit: 0.5,
  zoomAccelLimit: 0.7,
  pathLimitScale: 2,
  pathAccelScale: 4,
  rho: 1.4,
  pathV: 0.8,
  pathMinS: 3,
  pathMaxS: 10,
  glideMaxU: 1.5,
  zoomPathMaxU: 6,
  dipDownS: 1.2,
  dipUpS: 1.5,
  dipFloor: 0.15,
  dipMinGapS: 20,
  holdScale: 1,
  weightScale: 1,
  glidesOnly: false,
  wobble: true,
  marginFrac: 0.02,
  minVisH: 0.05,
  captions: { holdS: 5, minGapS: 45, settleS: 2, fadeInS: 1.2, fadeOutS: 1.5 },
  stories: true,
};

export interface ParamOptions { reducedMotion?: boolean; calmDirector?: boolean }

/** Parameters for a view mode (CONTRACT 15, DESIGN R30), with R18's calm and reduced-motion rules. */
export function directorParams(mode: ViewMode, opts: ParamOptions = {}): DirectorParams {
  const p: DirectorParams = { ...BASE, halfLife: { ...BASE.halfLife }, beta: { ...BASE.beta } };
  if (mode === 'tv') p.captions = { holdS: 6, minGapS: 25, settleS: 2, fadeInS: 1.2, fadeOutS: 1.5 };
  if (mode === 'god') p.captions = null;
  if (mode === 'wallpaper') {
    p.captions = null;
    p.panLimit = 0.08; p.zoomLimit = 0.12; p.accelLimit = 0.16; p.zoomAccelLimit = 0.24;
    p.dipMinGapS = 120;
    p.glidesOnly = true;
    p.stories = opts.calmDirector === true; // William's Q10: idle drift only by default
    p.weightScale = 0.5;
    p.holdScale = 2.25; // minimum holds of about 45 s on the calm director
  }
  if (opts.reducedMotion) {
    p.panLimit = Math.min(p.panLimit, 0.08); p.zoomLimit = Math.min(p.zoomLimit, 0.12);
    p.accelLimit = Math.min(p.accelLimit, 0.16); p.zoomAccelLimit = Math.min(p.zoomAccelLimit, 0.24);
    p.glidesOnly = true;
    p.wobble = false;
  }
  return p;
}
