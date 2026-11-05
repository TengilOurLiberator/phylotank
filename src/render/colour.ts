/**
 * Colour from genes (06 §6.1.8). Everything is OKLCH in, linear sRGB out, so equal gene steps
 * look like equal colour steps. Pure functions; no GPU, no DOM.
 */

export type RGB = [number, number, number];

/** OKLab to linear sRGB (Ottosson 2020). */
export function oklabToLinear(L: number, a: number, b: number): RGB {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Linear sRGB to OKLab (for tests and for measuring colour distance). */
export function linearToOklab(r: number, g: number, b: number): RGB {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const inGamut = (c: RGB): boolean => c[0] >= -1e-4 && c[1] >= -1e-4 && c[2] >= -1e-4 && c[0] <= 1.0001 && c[1] <= 1.0001 && c[2] <= 1.0001;

/**
 * OKLCH (hue in degrees) to linear sRGB, gamut-mapped by reducing chroma at constant
 * lightness and hue (bisection), so a vivid gene never clips to a different hue.
 */
export function oklchToLinear(L: number, C: number, hDeg: number): RGB {
  const h = (hDeg * Math.PI) / 180;
  const ca = Math.cos(h), sa = Math.sin(h);
  let c = oklabToLinear(L, C * ca, C * sa);
  if (inGamut(c)) return c;
  let lo = 0, hi = C;
  for (let i = 0; i < 18; i++) {
    const mid = 0.5 * (lo + hi);
    if (inGamut(oklabToLinear(L, mid * ca, mid * sa))) lo = mid; else hi = mid;
  }
  c = oklabToLinear(L, lo * ca, lo * sa);
  return [Math.min(1, Math.max(0, c[0])), Math.min(1, Math.max(0, c[1])), Math.min(1, Math.max(0, c[2]))];
}

/** Euclidean OKLab distance (Delta E OK). */
export function deltaEOK(a: RGB, b: RGB): number {
  const p = linearToOklab(a[0], a[1], a[2]);
  const q = linearToOklab(b[0], b[1], b[2]);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** The luminescence hue warp of 06 §6.1.8: most of the gene range lands in blue to green. */
export function lumHueFromGene(g: number): number {
  const x = 2 * g - 1;
  return (((220 + 180 * x * x * x) % 360) + 360) % 360;
}

/**
 * Saturated red, for the stricter flash clamp (06 §6.1.7 layer 2). Conservative union of the
 * design's OKLCH rule (hue 0 to 40 degrees, chroma above 0.15) and WCAG's red ratio
 * R / (R + G + B) >= 0.8 on the linear colour.
 */
export function isSaturatedRed(hDeg: number, chroma: number, lin?: RGB): boolean {
  const h = ((hDeg % 360) + 360) % 360;
  if (chroma > 0.15 && (h <= 40 || h >= 350)) return true;
  if (lin) {
    const sum = lin[0] + lin[1] + lin[2];
    if (sum > 1e-6 && lin[0] / sum >= 0.8) return true;
  }
  return false;
}

/** The Look genes, each 0 to 1 (06 §6.1.8 table), as read from the TRAT block or a template. */
export interface LookGenes {
  pigHue: number; pigSat: number; pigLight: number; opacity: number;
  lumHue: number; lumGain: number; stripeFreq: number; stripeAmp: number;
  spotDensity: number; trailGain: number;
  /** Pulse genes for the aggregate organ: period in seconds (genome 0.25 to 20 s), duty 0 to 1. */
  pulsePeriodS: number; pulseDuty: number;
  /** Soft jelly-like lineages blend more (k multiplier, 0.5 to 2). */
  softness: number;
}

/** The decoded look a shader consumes: linear colours and alphas. */
export interface Look {
  albedo: RGB; bodyHue: number; bodyChroma: number; bodyL: number;
  coreAlpha: number; edgeAlpha: number;
  rimHue: number; rimChroma: number; rimGain: number; emission: RGB; red: boolean;
  stripeFreq: number; stripeAmp: number; spotDensity: number; trailGain: number;
  pulsePeriodS: number; pulseDuty: number; softness: number;
}

export function lookFromGenes(g: LookGenes): Look {
  const bodyHue = 360 * g.pigHue;
  const bodyChroma = 0.02 + 0.1 * g.pigSat;
  const bodyL = 0.3 + 0.35 * g.pigLight;
  const coreAlpha = 0.08 + 0.5 * g.opacity;
  const rimHue = lumHueFromGene(g.lumHue);
  const rimChroma = 0.2;
  const emission = oklchToLinear(0.75, rimChroma, rimHue);
  return {
    albedo: oklchToLinear(bodyL, bodyChroma, bodyHue), bodyHue, bodyChroma, bodyL,
    coreAlpha, edgeAlpha: Math.min(1, coreAlpha + 0.25),
    rimHue, rimChroma, rimGain: 4 * g.lumGain, emission, red: isSaturatedRed(rimHue, rimChroma, emission),
    stripeFreq: 1 + 11 * g.stripeFreq, stripeAmp: 0.6 * g.stripeAmp, spotDensity: g.spotDensity,
    trailGain: g.trailGain, pulsePeriodS: g.pulsePeriodS, pulseDuty: g.pulseDuty, softness: g.softness,
  };
}

/** Rec. 709 relative luminance of a linear colour. */
export function luminance(c: RGB): number { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
