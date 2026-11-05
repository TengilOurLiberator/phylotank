/**
 * A running sim session that speaks the view protocol (CONTRACT 12). Shared by the browser
 * worker (dream tank) and the Node host, so both emit identical frames.
 */
import {
  CENSUS_EVERY, decodeCborFrame, encodeCborFrame, FRAME, PRESETS, readHeader, TICK_HZ,
  type CborValue, type World, type WorldConfig,
} from '../core/index.js';
import { encodeViewFrames, envFrameFor, paletteBytes } from './frames.js';
import { sim } from './index.js';

/** Frames per second of DUST_FRAME output (every 2nd tick at 30 Hz). */
export const DUST_EVERY = 2;

export const DEFAULT_DREAM_CONFIG: WorldConfig = {
  preset: 'small', seedLo: 0x5eed1234, seedHi: 0x0000beef, backend: 'cpu', skeletonMotes: 3000,
};

export { paletteBytes };

export function welcomeFor(world: World, scopes: string[]): CborValue {
  return {
    worldId: `${world.g.seedHi.toString(16)}-${world.g.seedLo.toString(16)}`,
    tickHi: Math.floor(world.g.tick / 4294967296), epoch: world.g.epoch, tickHz: TICK_HZ,
    tank: { w: world.preset.widthM, h: world.preset.heightM, preset: world.preset.name },
    lCeiling: world.lCeilingM, palette: paletteBytes(), speciesTable: [], schemaHash: 'v0.0', scopes,
  };
}

export interface SessionClient { send(frame: Uint8Array): void }

/** Owns one world and fans frames out to clients. Time comes from the caller (a Pacer). */
export class SimSession {
  readonly world: World;
  private readonly clients = new Set<SessionClient>();

  constructor(config: WorldConfig) {
    if (!PRESETS[config.preset]) throw new Error(`unknown preset ${config.preset}`);
    this.world = sim.create(config);
  }

  add(c: SessionClient, scopes: string[]): void {
    this.clients.add(c);
    c.send(encodeCborFrame(FRAME.WELCOME, this.world.g.tick, welcomeFor(this.world, scopes)));
    c.send(envFrameFor(this.world));
    c.send(encodeViewFrames(this.world));
  }

  remove(c: SessionClient): void { this.clients.delete(c); }

  /** Handle one inbound frame from a client (HELLO is handled by the transport). */
  receive(c: SessionClient, bytes: Uint8Array): void {
    const h = readHeader(bytes);
    if (h.type === FRAME.COMMAND) {
      const { payload } = decodeCborFrame(bytes);
      const id = (payload as { id?: unknown }).id;
      c.send(encodeCborFrame(FRAME.COMMAND_RESULT, this.world.g.tick, {
        id: typeof id === 'string' ? id.slice(0, 32) : '', ok: false, reason: 'not-implemented',
      }));
    }
    // VIEWPORT and ACK are accepted and ignored in phase 0 (whole-tank streams).
  }

  tick(n: number): void {
    for (let i = 0; i < n; i++) {
      sim.step(this.world);
      const t = this.world.g.tick;
      if (this.clients.size === 0) continue;
      if (t % DUST_EVERY === 0) this.broadcast(encodeViewFrames(this.world));
      if (t % CENSUS_EVERY === 0) this.broadcast(envFrameFor(this.world));
    }
  }

  private broadcast(frame: Uint8Array): void { for (const c of this.clients) c.send(frame); }
}
