/**
 * CMA-ES, the (mu/mu_w, lambda) variant with rank-one and rank-mu updates and cumulative step-size
 * adaptation, after Hansen's tutorial (arXiv:1604.00772). Minimises. Deterministic given `normal`.
 * Ask/tell interface so the harness can evaluate candidates however it likes (seeds, early stops).
 */

/** Jacobi eigendecomposition of a symmetric matrix: returns eigenvalues and column eigenvectors. */
export function eigSym(a: number[][]): { values: number[]; vectors: number[][] } {
  const n = a.length;
  const A = a.map((r) => r.slice());
  const V: number[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i]![j]! * A[i]![j]!;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (A[q]![q]! - A[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k]![p]!, akq = A[k]![q]!;
          A[k]![p] = c * akp - s * akq;
          A[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p]![k]!, aqk = A[q]![k]!;
          A[p]![k] = c * apk - s * aqk;
          A[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k]![p]!, vkq = V[k]![q]!;
          V[k]![p] = c * vkp - s * vkq;
          V[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: A.map((r, i) => r[i]!), vectors: V };
}

export interface CmaOptions {
  mean: number[];
  sigma: number;
  lambda?: number;
  /** Clamp candidates into [lo, hi] per coordinate (unit cube by default). */
  lo?: number;
  hi?: number;
}

export class CmaEs {
  readonly n: number;
  readonly lambda: number;
  readonly mu: number;
  readonly weights: number[];
  readonly muEff: number;
  mean: number[];
  sigma: number;
  private C: number[][];
  private B: number[][];
  private D: number[];
  private pc: number[];
  private ps: number[];
  private readonly cc: number;
  private readonly cs: number;
  private readonly c1: number;
  private readonly cmu: number;
  private readonly damps: number;
  private readonly chiN: number;
  generation = 0;
  private lastZ: number[][] = [];
  private lastY: number[][] = [];
  best: { x: number[]; f: number } = { x: [], f: Infinity };

  constructor(o: CmaOptions, private readonly normal: () => number) {
    const n = o.mean.length;
    this.n = n;
    this.lambda = o.lambda ?? 4 + Math.floor(3 * Math.log(n));
    this.mu = Math.floor(this.lambda / 2);
    const w = Array.from({ length: this.mu }, (_, i) => Math.log(this.mu + 0.5) - Math.log(i + 1));
    const ws = w.reduce((a, b) => a + b, 0);
    this.weights = w.map((v) => v / ws);
    this.muEff = 1 / this.weights.reduce((a, b) => a + b * b, 0);
    this.mean = o.mean.slice();
    this.sigma = o.sigma;
    this.cc = (4 + this.muEff / n) / (n + 4 + (2 * this.muEff) / n);
    this.cs = (this.muEff + 2) / (n + this.muEff + 5);
    this.c1 = 2 / ((n + 1.3) * (n + 1.3) + this.muEff);
    this.cmu = Math.min(1 - this.c1, (2 * (this.muEff - 2 + 1 / this.muEff)) / ((n + 2) * (n + 2) + this.muEff));
    this.damps = 1 + 2 * Math.max(0, Math.sqrt((this.muEff - 1) / (n + 1)) - 1) + this.cs;
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
    this.C = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
    this.B = this.C.map((r) => r.slice());
    this.D = new Array<number>(n).fill(1);
    this.pc = new Array<number>(n).fill(0);
    this.ps = new Array<number>(n).fill(0);
    this.lo = o.lo ?? 0;
    this.hi = o.hi ?? 1;
  }
  private readonly lo: number;
  private readonly hi: number;

  /** Sample lambda candidates (clamped to the box). */
  ask(): number[][] {
    const n = this.n;
    this.lastZ = [];
    this.lastY = [];
    const xs: number[][] = [];
    for (let k = 0; k < this.lambda; k++) {
      const z = Array.from({ length: n }, () => this.normal());
      const y = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += this.B[i]![j]! * this.D[j]! * z[j]!;
        y[i] = s;
      }
      this.lastZ.push(z);
      this.lastY.push(y);
      xs.push(this.mean.map((m, i) => Math.min(this.hi, Math.max(this.lo, m + this.sigma * y[i]!))));
    }
    return xs;
  }

  /** Update from the fitness of the last ask() (lower is better). */
  tell(xs: number[][], fs: number[]): void {
    const n = this.n;
    const idx = fs.map((f, i) => [f, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((p) => p[1]);
    if (fs[idx[0]!]! < this.best.f) this.best = { x: xs[idx[0]!]!.slice(), f: fs[idx[0]!]! };
    // use the clamped points' actual steps so the mean follows evaluated candidates
    const ys = xs.map((x) => x.map((v, i) => (v - this.mean[i]!) / this.sigma));
    const yw = new Array<number>(n).fill(0);
    for (let k = 0; k < this.mu; k++) for (let i = 0; i < n; i++) yw[i]! += this.weights[k]! * ys[idx[k]!]![i]!;
    this.mean = this.mean.map((m, i) => m + this.sigma * yw[i]!);
    // C^(-1/2) yw = B D^-1 B^T yw
    const bty = new Array<number>(n).fill(0);
    for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < n; i++) s += this.B[i]![j]! * yw[i]!; bty[j] = s / this.D[j]!; }
    const cy = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < n; j++) s += this.B[i]![j]! * bty[j]!; cy[i] = s; }
    const csn = Math.sqrt(this.cs * (2 - this.cs) * this.muEff);
    this.ps = this.ps.map((p, i) => (1 - this.cs) * p + csn * cy[i]!);
    const psNorm = Math.sqrt(this.ps.reduce((a, b) => a + b * b, 0));
    this.generation++;
    const hsig = psNorm / Math.sqrt(1 - Math.pow(1 - this.cs, 2 * this.generation)) / this.chiN < 1.4 + 2 / (n + 1) ? 1 : 0;
    const ccn = Math.sqrt(this.cc * (2 - this.cc) * this.muEff);
    this.pc = this.pc.map((p, i) => (1 - this.cc) * p + hsig * ccn * yw[i]!);
    const C = this.C;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let rmu = 0;
        for (let k = 0; k < this.mu; k++) rmu += this.weights[k]! * ys[idx[k]!]![i]! * ys[idx[k]!]![j]!;
        const v = (1 - this.c1 - this.cmu) * C[i]![j]! + this.c1 * (this.pc[i]! * this.pc[j]! + (1 - hsig) * this.cc * (2 - this.cc) * C[i]![j]!) + this.cmu * rmu;
        C[i]![j] = v; C[j]![i] = v;
      }
    }
    this.sigma *= Math.exp((this.cs / this.damps) * (psNorm / this.chiN - 1));
    const e = eigSym(C);
    this.B = e.vectors;
    this.D = e.values.map((v) => Math.sqrt(Math.max(v, 1e-20)));
  }
}
