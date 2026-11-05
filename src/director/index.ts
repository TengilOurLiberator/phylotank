/**
 * src/director: the camera director (StoryBook, scoring, shots, springs, van Wijk zoom paths,
 * captions) and the wallpaper's idle drift. Runs in the view as a pure function of the event
 * log, the census and the seed (DESIGN R19). CONTRACT 11, 15. See README.md and
 * docs/modules/director.md.
 */
import { log2, sin, TAU, type Camera, type DirectorModule, type SimEvent } from '../core/index.js';

export { Director, createDirector } from './director.js';
export type { Census, CensusSpecies, DirectorConfig, DirectorFrame, ShotRecord, Transition } from './director.js';
export { StoryBook, type Story } from './storybook.js';
export { ExposureMemory } from './exposure.js';
export { springCritical, saturate, softCap, ZoomPath, trapezoid } from './motion.js';
export { directorParams, SHOT_PARAMS, TYPE_PARAMS, type DirectorParams, type ShotKind, type StoryType } from './params.js';
export { captionFor, speciesName, captionBox, type CaptionState, type CaptionText, type SpeciesName } from './captions.js';
export { DriftPlanner, type HeatMap } from './drift.js';

/**
 * Stateless idle drift: frame the whole tank (cover) with a little headroom, and wander slowly on
 * incommensurate periods of minutes. The fallback camera before a census arrives; the heat-map
 * drift is `createDirector({ mode: 'wallpaper', ... })`.
 */
export function idleDrift(tS: number, tankW: number, tankH: number, viewW: number, viewH: number): Camera {
  const ppm = Math.max(viewW / tankW, viewH / tankH) * 1.12;
  const visW = viewW / ppm;
  const visH = viewH / ppm;
  const mx = Math.max(0, (tankW - visW) / 2);
  const my = Math.max(0, (tankH - visH) / 2);
  const cx = tankW / 2 + mx * 0.9 * sin((TAU * tS) / 317);
  const cy = tankH / 2 + my * 0.9 * sin((TAU * tS) / 443 + 1.3);
  const breathe = 1 + 0.03 * sin((TAU * tS) / 601);
  return { cx, cy, zeta: log2(ppm * breathe) };
}

/** Phase-0 stand-in kept for src/ui until it constructs a Director with the tank and view size. */
export class PassThroughDirector implements DirectorModule {
  update(events: readonly SimEvent[], dtWall: number, current: Camera): Camera {
    void events; void dtWall;
    return current;
  }
  caption(): string | null { return null; }
}

export const director: DirectorModule = new PassThroughDirector();
