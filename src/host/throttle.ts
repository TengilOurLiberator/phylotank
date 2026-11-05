/**
 * Throttle states and GPU etiquette (05 §5.2.4, REVIEW R19). The host decides the state from
 * which views are visible plus OS probes. The probes are Windows-only (fullscreen through
 * SHQueryUserNotificationState and the foreground rect, NVML, the optional ComfyUI queue) and
 * live in the Tauri shell; here they sit behind `OsProbe`, with a stub for Linux, macOS, CI and
 * tests. The state never enters the sim: it only changes how many ticks run per wall second.
 */

export type ThrottleState = 'watching' | 'ambient' | 'background' | 'yield' | 'evicted' | 'battery';

export interface ProbeSample {
  /** A fullscreen or borderless-fullscreen app has the foreground. */
  fullscreen: boolean;
  /** GPU utilisation by other processes, 0..1 (NVML, our PID excluded); null if unknown. */
  otherGpuUtil: number | null;
  /** Free VRAM in GB; null if unknown. */
  freeVramGb: number | null;
  /** Board power in watts (NVML); null if unknown. Input to the power budget (R19). */
  gpuPowerW: number | null;
  /** ComfyUI queue has running or pending items (opt-in probe). */
  comfyBusy: boolean;
  /** A process from the user's yield list is running. */
  listedProcess: boolean;
  onBattery: boolean;
  /** Session locked or displays off. */
  sessionLocked: boolean;
}

export interface OsProbe {
  readonly name: string;
  /** Which signals this probe can really measure on this OS. */
  readonly provides: readonly (keyof ProbeSample)[];
  sample(): ProbeSample;
}

export const IDLE_SAMPLE: ProbeSample = {
  fullscreen: false, otherGpuUtil: null, freeVramGb: null, gpuPowerW: null, comfyBusy: false, listedProcess: false,
  onBattery: false, sessionLocked: false,
};

/** Probe for platforms without the shell's probes. Tests and the shell's stdio bridge set values. */
export class StubProbe implements OsProbe {
  readonly name = 'stub';
  readonly provides: readonly (keyof ProbeSample)[] = [];
  current: ProbeSample = { ...IDLE_SAMPLE };
  set(p: Partial<ProbeSample>): void { this.current = { ...this.current, ...p }; }
  sample(): ProbeSample { return this.current; }
}

/**
 * Interfaces the Windows shell implements (05 §5.2.4). They report over the shell's stdio
 * control channel; nothing here calls Win32, NVML or the network.
 */
export interface FullscreenProbe { fullscreen(): boolean }
export interface NvmlProbe { utilisationExcludingSelf(): number; freeVramGb(): number; powerW(): number }
export interface ComfyUiProbe { queueBusy(): boolean }
/** Compose shell-side probes into one OsProbe; any of them may be absent. */
export class ShellProbe implements OsProbe {
  readonly name = 'shell';
  readonly provides: readonly (keyof ProbeSample)[];
  constructor(private readonly p: { fullscreen?: FullscreenProbe; nvml?: NvmlProbe; comfy?: ComfyUiProbe; battery?: () => boolean; locked?: () => boolean }) {
    const prov: (keyof ProbeSample)[] = [];
    if (p.fullscreen) prov.push('fullscreen');
    if (p.nvml) prov.push('otherGpuUtil', 'freeVramGb', 'gpuPowerW');
    if (p.comfy) prov.push('comfyBusy');
    if (p.battery) prov.push('onBattery');
    if (p.locked) prov.push('sessionLocked');
    this.provides = prov;
  }
  sample(): ProbeSample {
    return {
      fullscreen: this.p.fullscreen?.fullscreen() ?? false,
      otherGpuUtil: this.p.nvml?.utilisationExcludingSelf() ?? null,
      freeVramGb: this.p.nvml?.freeVramGb() ?? null,
      gpuPowerW: this.p.nvml?.powerW() ?? null,
      comfyBusy: this.p.comfy?.queueBusy() ?? false,
      listedProcess: false,
      onBattery: this.p.battery?.() ?? false,
      sessionLocked: this.p.locked?.() ?? false,
    };
  }
}

export interface Visibility { watching: boolean; wallpaper: boolean; screensaver: boolean }

export interface ThrottleOutput {
  state: ThrottleState;
  /** Upper bound on sim speed (x of 1x) in this state; the lease may ask for less, never more. */
  maxSpeed: number;
  /** GPU duty cap (fraction), for the GPU backend's controller; the CPU backend uses it as a CPU budget. */
  dutyCap: number;
  streaming: 'full' | 'wallpaper' | 'reduced' | 'none';
  /** True while frozen in Yield but the screensaver is up: trickle at 0.1x and 2% (05 §5.2.4). */
  trickle: boolean;
  /** Release GPU buffers (Evicted). */
  evict: boolean;
  /** Speed limit from the power budget alone (Infinity without one); an unattended lease is held to it in Background. */
  powerCap: number;
}

export interface ThrottleConfig {
  yieldEnterMs: number;
  yieldLeaveMs: number;
  evictAfterMs: number;
  otherGpuThreshold: number;
  minFreeVramGb: number;
  /** Background speed (05: 1x by default, configurable down to 0). */
  backgroundSpeed: number;
  /** Power budget above idle, in watts (R19); null disables it. */
  powerBudgetW: number | null;
  idlePowerW: number;
}
export const DEFAULT_THROTTLE: ThrottleConfig = {
  yieldEnterMs: 5_000, yieldLeaveMs: 30_000, evictAfterMs: 600_000, otherGpuThreshold: 0.3, minFreeVramGb: 3,
  backgroundSpeed: 1, powerBudgetW: null, idlePowerW: 30,
};

const TABLE: Record<ThrottleState, Omit<ThrottleOutput, 'state' | 'trickle' | 'evict' | 'powerCap'>> = {
  watching: { maxSpeed: Infinity, dutyCap: 0.35, streaming: 'full' },
  ambient: { maxSpeed: Infinity, dutyCap: 0.15, streaming: 'wallpaper' },
  background: { maxSpeed: 1, dutyCap: 0.10, streaming: 'none' },
  yield: { maxSpeed: 0, dutyCap: 0, streaming: 'none' },
  evicted: { maxSpeed: 0, dutyCap: 0, streaming: 'none' },
  battery: { maxSpeed: 0.25, dutyCap: 0.05, streaming: 'reduced' },
};

/** Hysteresis state machine. Feed it a probe sample and the visible views; it is a pure function of its inputs and the clock. */
export class Throttle {
  private triggerSince: number | null = null;
  private clearSince: number | null = null;
  private yieldSince: number | null = null;
  private yielding = false;
  private gpuBusySince: number | null = null;
  private powerAvgW: number | null = null;
  out: ThrottleOutput = { state: 'background', ...TABLE.background, trickle: false, evict: false, powerCap: Infinity };
  constructor(readonly cfg: ThrottleConfig = DEFAULT_THROTTLE) {}

  update(nowMs: number, s: ProbeSample, v: Visibility): ThrottleOutput {
    const c = this.cfg;
    // other GPU users count only after 5 s above the threshold
    if (s.otherGpuUtil !== null && s.otherGpuUtil > c.otherGpuThreshold) this.gpuBusySince ??= nowMs;
    else this.gpuBusySince = null;
    const gpuBusy = this.gpuBusySince !== null && nowMs - this.gpuBusySince >= c.yieldEnterMs;
    const trigger = s.fullscreen || gpuBusy || s.comfyBusy || s.listedProcess;
    if (trigger) { this.triggerSince ??= nowMs; this.clearSince = null; } else { this.clearSince ??= nowMs; this.triggerSince = null; }
    if (!this.yielding && this.triggerSince !== null && (nowMs - this.triggerSince >= c.yieldEnterMs || gpuBusy)) {
      this.yielding = true; this.yieldSince = nowMs;
    }
    if (this.yielding && this.clearSince !== null && nowMs - this.clearSince >= c.yieldLeaveMs) {
      this.yielding = false; this.yieldSince = null;
    }
    let state: ThrottleState;
    const lowVram = s.freeVramGb !== null && s.freeVramGb < c.minFreeVramGb;
    if (this.yielding && (lowVram || (this.yieldSince !== null && nowMs - this.yieldSince >= c.evictAfterMs))) state = 'evicted';
    else if (this.yielding) state = 'yield';
    else if (s.onBattery) state = 'battery';
    else if (v.watching || v.screensaver) state = 'watching';
    else if (v.wallpaper && !s.sessionLocked) state = 'ambient';
    else state = 'background';
    const base = TABLE[state];
    let maxSpeed = state === 'background' ? c.backgroundSpeed : base.maxSpeed;
    // power budget (R19): smoothed watts above idle; scale speed down proportionally when over
    if (s.gpuPowerW !== null) this.powerAvgW = this.powerAvgW === null ? s.gpuPowerW : this.powerAvgW * 0.9 + s.gpuPowerW * 0.1;
    let powerCap = Infinity;
    if (c.powerBudgetW !== null && this.powerAvgW !== null) {
      const over = this.powerAvgW - c.idlePowerW;
      if (over > c.powerBudgetW) powerCap = c.powerBudgetW / over;
    }
    if (powerCap < Infinity && maxSpeed > 0) maxSpeed = Math.min(maxSpeed === Infinity ? 1 : maxSpeed, powerCap);
    const trickle = (state === 'yield') && v.screensaver;
    this.out = {
      state, maxSpeed: trickle ? 0.1 : maxSpeed, dutyCap: trickle ? 0.02 : base.dutyCap,
      streaming: trickle ? 'reduced' : base.streaming, trickle, evict: state === 'evicted', powerCap,
    };
    return this.out;
  }
}
