/**
 * Pick the best available preview for a genome (see body.ts): the UI module's preview hook,
 * then genome.develop(), then the local schematic. A missing or unimplemented module is the
 * normal phase-1 state, so every failure falls through quietly to the next source.
 */
import { MAX_PARTS, NotImplementedError, PRESETS, type Genome } from '../../src/core/index.js';
import { genome as genomeModule } from '../../src/genome/index.js';
import * as ui from '../../src/ui/index.js';
import { paintBody, phenotypeBody, schematicBody, type Body } from './body.js';

/** The preview hook this page looks for on src/ui (docs/contract-requests/site.md). */
export type DesignPreviewHook = (canvas: HTMLCanvasElement, g: Genome, opts: { maturity: number; still: boolean }) => boolean;

export function uiPreviewHook(mod: unknown = ui): DesignPreviewHook | null {
  const f = (mod as Record<string, unknown>).drawDesignPreview;
  return typeof f === 'function' ? (f as DesignPreviewHook) : null;
}

/** develop() if it works, else the schematic. */
export function bodyFor(g: Genome, dev: typeof genomeModule = genomeModule): Body {
  try {
    const ph = dev.develop(g, 1, { depth01: 0.5, tempC: 14 }, { maxParts: MAX_PARTS, lCeilingM: PRESETS.small.lCeilingM });
    if (ph && ph.nParts > 0) return phenotypeBody(ph, g);
  } catch (e) {
    if (!(e instanceof NotImplementedError)) console.warn('genome.develop failed; showing the schematic preview', e);
  }
  return schematicBody(g);
}

export interface PreviewResult { source: Body['source']; body: Body | null }

/** Draw a still preview into the canvas, sized for its CSS box and the device pixel ratio. */
export function drawPreview(canvas: HTMLCanvasElement, g: Genome): PreviewResult {
  const hook = uiPreviewHook();
  if (hook) {
    try { if (hook(canvas, g, { maturity: 1, still: true })) return { source: 'ui', body: null }; } catch (e) { console.warn('ui preview failed', e); }
  }
  const body = bodyFor(g);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (ctx) paintBody(ctx, body, w, h);
  return { source: body.source, body };
}
