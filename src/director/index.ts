/**
 * src/director: the camera director (StoryBook, scoring, shots, springs, van Wijk zoom paths,
 * captions) and the wallpaper's idle drift. Runs in the view as a pure function of the event
 * log, the census and the seed (DESIGN R19). CONTRACT 11, 15. See README.md.
 *
 * Phase 0: idleDrift (wallpaper camera, William's Q10) and a pass-through director stub.
 * Deterministic math is used so recorded logs replay to identical camera paths.
 */
import { log2, sin, TAU, type Camera, type DirectorModule, type SimEvent } from '../core/index.js';

/**
 * Idle drift: frame the whole tank (cover) with a little headroom, and wander slowly on
 * incommensurate periods of minutes, so the wallpaper never moves restlessly.
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

export class PassThroughDirector implements DirectorModule {
  private lastCaption: string | null = null;
  update(events: readonly SimEvent[], dtWall: number, current: Camera): Camera {
    void events; void dtWall;
    return current;
  }
  caption(): string | null { return this.lastCaption; }
}

export const director: DirectorModule = new PassThroughDirector();
