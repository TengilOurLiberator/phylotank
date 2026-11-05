/**
 * Morris (1991) elementary-effects screening in the unit cube: r trajectories on a p-level grid
 * with step Delta = p / (2 (p - 1)). Returns mu* (mean absolute effect, the importance) and sigma
 * (spread, a sign of interactions or non-linearity) per parameter. Deterministic given `rand`.
 */
export interface MorrisResult { name: string; muStar: number; mu: number; sigma: number }

export function morrisTrajectories(k: number, r: number, p: number, rand: () => number): number[][][] {
  const delta = p / (2 * (p - 1));
  const out: number[][][] = [];
  const levels = Math.floor(p / 2); // starting levels that keep x + delta inside [0, 1]
  for (let t = 0; t < r; t++) {
    const x = Array.from({ length: k }, () => Math.floor(rand() * levels) / (p - 1));
    const order = Array.from({ length: k }, (_, i) => i);
    for (let i = k - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
    const traj = [x.slice()];
    const cur = x.slice();
    for (const i of order) {
      cur[i] = cur[i]! + delta <= 1 + 1e-12 ? cur[i]! + delta : cur[i]! - delta;
      traj.push(cur.slice());
    }
    out.push(traj);
  }
  return out;
}

export function morrisAnalyse(names: readonly string[], trajs: number[][][], ys: number[][]): MorrisResult[] {
  const k = names.length;
  const effects: number[][] = Array.from({ length: k }, () => []);
  trajs.forEach((traj, t) => {
    for (let s = 1; s < traj.length; s++) {
      const a = traj[s - 1]!, b = traj[s]!;
      let i = -1;
      for (let j = 0; j < k; j++) if (a[j] !== b[j]) { i = j; break; }
      if (i < 0) continue;
      const d = b[i]! - a[i]!;
      effects[i]!.push((ys[t]![s]! - ys[t]![s - 1]!) / d);
    }
  });
  return names.map((name, i) => {
    const e = effects[i]!;
    const n = Math.max(1, e.length);
    const mu = e.reduce((s, v) => s + v, 0) / n;
    const muStar = e.reduce((s, v) => s + Math.abs(v), 0) / n;
    const sigma = Math.sqrt(e.reduce((s, v) => s + (v - mu) * (v - mu), 0) / Math.max(1, e.length - 1));
    return { name, muStar, mu, sigma };
  });
}

/** Screen a function of the unit cube. */
export function morris(names: readonly string[], f: (u: number[]) => number, r: number, p: number, rand: () => number): MorrisResult[] {
  const trajs = morrisTrajectories(names.length, r, p, rand);
  const ys = trajs.map((tr) => tr.map((u) => f(u)));
  return morrisAnalyse(names, trajs, ys);
}
