/**
 * Bench entry (bundled with esbuild, run with node): prints one JSON document with the adapter,
 * the device microbenchmarks and the kernel rows. Usage, from the repo root:
 *   npx esbuild src/gpu/bench-cli.ts --bundle --platform=node --format=esm --outfile=bench/local/gpu-bench.mjs
 *   PT_WEBGPU=bench/local/dawn/node_modules/webgpu/index.js node bench/local/gpu-bench.mjs [--quick] [--out file.json]
 * On Windows with the RTX 5090, PT_WEBGPU points at the same package installed there (it ships
 * win32-x64/dawn.node); no Vulkan variables are needed.
 */
import { acquireGpu } from './device.js';
import { benchBrain, benchPhysics, benchTransport, deviceMicro, type BenchRow } from './bench.js';

const argv = (globalThis as { process?: { argv: string[]; env: Record<string, string | undefined> } }).process!;
const quick = argv.argv.includes('--quick');
const outAt = argv.argv.indexOf('--out');
const gpu = await acquireGpu({ module: argv.env.PT_WEBGPU });
if (!gpu) { console.log(JSON.stringify({ error: 'no WebGPU adapter' })); } else {
  const log = (k: string, r: BenchRow | BenchRow[]): void => { console.error(k, JSON.stringify(r)); };
  const out: Record<string, unknown> = { adapter: gpu.adapterInfo, limits: gpu.limits };
  out.micro = await deviceMicro(gpu); log('micro', out.micro as BenchRow);
  const segCapMax = Math.floor(gpu.limits.maxStorageBufferBindingSize / (22 * 4) / 1.25); // sst, the largest buffer with private scratch
  const sizes = (quick ? [256, 2048] : [256, 1024, 4096, 16384, 65536]).filter((n) => n * 8 <= segCapMax);
  const phys: BenchRow[] = [];
  for (const n of sizes) { const r = await benchPhysics(gpu, n, n >= 16384 ? 5 : 20, n <= 4096); phys.push(r); log('physics', r); }
  for (const n of sizes.filter((k) => k <= 4096 && k * 8 * 280 * 1.25 <= gpu.limits.maxStorageBufferBindingSize)) { const r = await benchPhysics(gpu, n, 10, false, true); phys.push(r); log('physics', r); }
  out.physics = phys;
  const brains: BenchRow[] = [];
  for (const [c, n] of (quick ? [[0, 1024]] : [[0, 4096], [0, 32768], [2, 4096], [4, 512]]) as [number, number][]) { const r = await benchBrain(gpu, c, n); brains.push(r); log('brain', r); }
  out.brain = brains;
  const tr: BenchRow[] = [];
  for (const [w, h] of (quick ? [[128, 72]] : [[256, 144], [1024, 576], [2048, 1152]]) as [number, number][]) { const r = await benchTransport(gpu, w, h); tr.push(r); log('transport', r); }
  out.transport = tr;
  const json = JSON.stringify(out, null, 1);
  console.log(json);
  if (outAt > 0) { const fs = await import('node:fs'); fs.writeFileSync(argv.argv[outAt + 1]!, json); }
  gpu.device.destroy();
}
