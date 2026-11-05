/**
 * Per-creature behaviour classifier (03 §3.10), host side and read-only: fed one sample per
 * brain tick (or at 10 Hz), it labels the last 2 s window. Labels feed the inspector, stats and
 * the director's event stream. Schools, hunts and packs need neighbours and are host detectors.
 */
export type BehaviourLabel = 'rest' | 'cruise' | 'graze' | 'flee' | 'ambush' | 'strike';

export interface BehaviourSample {
  /** Speed relative to the water, body lengths per second. */
  speedBL: number;
  /** MOUTH_OPEN motor output (-1..1), 0 without a mouth. */
  mouthOpen: number;
  /** Fear drive output (-1..1). */
  fear: number;
  /** Food under the mouth (TASTE_NUTRITION input, 0..1). */
  food: number;
}

export class BehaviourTracker {
  private readonly buf: BehaviourSample[] = [];
  private cruise = 0.5;
  private stillFor = 0;
  constructor(readonly windowSamples = 20) {}

  push(s: BehaviourSample): void {
    this.buf.push(s);
    if (this.buf.length > this.windowSamples) this.buf.shift();
    // slow EMA of cruising speed (only while not fleeing or striking)
    if (s.speedBL < 3 * this.cruise + 0.2) this.cruise += 0.01 * (s.speedBL - this.cruise);
    this.stillFor = s.speedBL < 0.1 ? this.stillFor + 1 : 0;
  }

  /** Label of the current window (03 §3.10 detection metrics, simplified). */
  label(): BehaviourLabel {
    const n = this.buf.length;
    if (n === 0) return 'rest';
    const last = this.buf[n - 1]!;
    const cruise = Math.max(0.05, this.cruise);
    const maxSpeed = this.buf.reduce((m, s) => Math.max(m, s.speedBL), 0);
    const still = this.buf.filter((s) => s.speedBL < 0.1).length / n;
    const grazing = this.buf.filter((s) => s.mouthOpen > 0.5 && s.food > 0.2).length / n;
    if (last.speedBL > 5 * cruise && still > 0.5) return 'strike';
    if (maxSpeed > 3 * cruise && this.buf.some((s) => s.fear > 0.5)) return 'flee';
    if (grazing > 0.5 && last.speedBL < 0.5) return 'graze';
    if (still > 0.7) return this.stillFor > 3 * this.windowSamples ? 'ambush' : 'rest';
    return 'cruise';
  }
}
