/**
 * Host CLI (bundled to dist/host.mjs).
 *   node dist/host.mjs [serve] [--port 47615] [--world <dir> | --memory] [--name default]
 *        [--preset small|default|large] [--seed N] [--motes N] [--autosave-min 10] [--lan] [--lan-god] [--shell]
 *   node dist/host.mjs --headless --ticks 3000        run without a server and print the state hash
 *   node dist/host.mjs inspect [--world <dir>]         list snapshots and journals, verify checksums
 *   node dist/host.mjs replay [--world <dir>]          load the newest valid snapshot, replay and verify, write nothing
 *   node dist/host.mjs gpu-probe --webgpu <dir>        try Dawn from <dir>/node_modules/webgpu (optional, not a dependency)
 *
 * With --shell the host speaks newline-delimited JSON on stdio to the Tauri shell (05 §5.2.3):
 * it prints {"ready":true,...}, and accepts {"cmd":"flush"} and {"probe":{...}} lines.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { HOST_PORT, toHex64, type PresetName, type WorldConfig } from '../core/index.js';
import { sim } from '../sim/index.js';
import { DEFAULT_DREAM_CONFIG } from '../sim/session.js';
import { GpuDeviceManager, loadDawn } from './gpu.js';
import { runHostWorker, WORKER_ROLE } from './worker.js';
import { decodeWorld } from './snapshot.js';
import { WorldStore } from './store.js';
import { StubProbe, type ProbeSample } from './throttle.js';
import { HostWorld } from './world-host.js';
import { startHost } from './index.js';

if (!isMainThread && (workerData as { ptkRole?: string } | null)?.ptkRole === WORKER_ROLE) {
  runHostWorker(parentPort!);
} else {
  await main();
}

async function main(): Promise<void> {
const argv = process.argv.slice(2);
const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'serve';
function arg(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const flag = (name: string): boolean => argv.includes(`--${name}`);

/** Per-user data root (05 §5.4.1). */
function defaultWorldDir(name: string): string {
  const base = process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Phylotank')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Phylotank')
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'phylotank');
  return join(base, 'worlds', name.replace(/[^A-Za-z0-9_-]/g, '_'));
}

const seed = Number(arg('seed') ?? DEFAULT_DREAM_CONFIG.seedLo);
const config: WorldConfig = {
  ...DEFAULT_DREAM_CONFIG,
  preset: (arg('preset') ?? 'small') as PresetName,
  seedLo: seed >>> 0,
  ...(arg('motes') !== undefined ? { skeletonMotes: Number(arg('motes')) } : {}),
};
const worldDir = flag('memory') ? undefined : (arg('world') ?? defaultWorldDir(arg('name') ?? 'default'));

if (flag('headless')) {
  const ticks = Number(arg('ticks') ?? 3000);
  const world = sim.create(config);
  const t0 = performance.now();
  for (let i = 0; i < ticks; i++) sim.step(world);
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ ticks, ms: Math.round(ms), ticksPerSec: Math.round((ticks * 1000) / ms), hash: toHex64(sim.hash(world)) }));
} else if (sub === 'inspect') {
  if (!worldDir) throw new Error('inspect needs a world directory');
  const store = new WorldStore(worldDir);
  const snapshots = store.listSnapshots().map((s) => {
    try {
      const d = decodeWorld(store.readSnapshot(s));
      return { id: s.id, ok: true, tick: d.header.tick, epoch: d.header.epoch, population: d.world.g.liveCount };
    } catch (e) { return { id: s.id, ok: false, error: (e as Error).message }; }
  });
  const journals = store.readJournals().map((j) => ({ seq: j.seq, epoch: j.epoch, startTick: j.startTick, records: j.records.length, torn: j.torn, lastTick: j.records.at(-1)?.tick ?? null }));
  console.log(JSON.stringify({ worldDir, snapshots, journals }, null, 2));
  store.close();
} else if (sub === 'gpu-probe') {
  // spike 2: does Dawn load here, and which adapter does it get? The sim stays on the CPU.
  const gpu = await loadDawn(arg('webgpu') ?? process.cwd());
  const m = gpu ? new GpuDeviceManager(gpu) : null;
  const d = m ? await m.acquire() : null;
  console.log(JSON.stringify({ dawnLoaded: gpu !== null, adapter: d?.adapter ?? null, timestampQuery: d?.timestampQuery ?? false, backend: 'cpu' }));
  m?.close();
  process.exit(0);
} else if (sub === 'replay') {
  if (!worldDir) throw new Error('replay needs a world directory');
  const hw = HostWorld.open({ dir: worldDir, config, readOnly: true });
  console.log(JSON.stringify({ ...hw.recovery, tick: hw.tick, hash: toHex64(sim.hash(hw.world)) }, null, 2));
  hw.close();
  process.exit(hw.recovery.mismatchAt === undefined ? 0 : 2);
} else {
  const staticDir = arg('static') ?? dirname(fileURLToPath(import.meta.url));
  const port = Number(arg('port') ?? HOST_PORT);
  const autosaveMin = Number(arg('autosave-min') ?? 10);
  const probe = new StubProbe();
  const shell = flag('shell');
  const host = await startHost({
    port, staticDir, config, ...(worldDir ? { worldDir } : {}), lan: flag('lan'), lanGod: flag('lan-god'),
    autosaveMs: Math.min(60, Math.max(2, autosaveMin)) * 60_000, probe, hashWorker: fileURLToPath(import.meta.url),
    log: (m) => { if (shell) console.log(JSON.stringify({ log: m })); else console.error(m); },
  });
  const r = host.recovery;
  if (shell) {
    console.log(JSON.stringify({ ready: true, port: host.port, tick: host.hw.tick, recovered: !r.created, replayedTicks: r.replayedTicks }));
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      try {
        const m = JSON.parse(line) as { cmd?: string; probe?: Partial<ProbeSample> };
        if (m.cmd === 'flush') { host.hw.save('auto'); console.log(JSON.stringify({ flushed: true, tick: host.hw.tick })); }
        if (m.probe) probe.set(m.probe);
      } catch { /* ignore malformed control lines */ }
    });
  } else {
    console.log(`Phylotank host on http://127.0.0.1:${host.port}/  (wallpaper.html, screensaver.html, tv.html, god.html)`);
    console.log(`God window: http://127.0.0.1:${host.port}/god.html#token=${host.godToken}`);
    console.log(worldDir ? `World: ${worldDir} (${r.created ? 'new' : `resumed at tick ${host.hw.tick}${r.replayedTicks ? `, replayed ${r.replayedTicks} ticks` : ''}`})` : 'World: in memory (not saved)');
    for (const f of r.failed) console.log(`  skipped damaged snapshot ${f.id}: ${f.reason}`);
  }
  const shutdown = (): void => { void host.stop().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
}
