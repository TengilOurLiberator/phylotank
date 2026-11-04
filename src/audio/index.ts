/**
 * src/audio: generative WebAudio ambience (06 §6.3): drone, pads, giants' thuds, birth bells,
 * darkness after disasters, seasonal key, species leitmotifs. Off on the wallpaper, on for TV
 * (CONTRACT 15). See README.md.
 *
 * Phase 0: a silent stub that satisfies AudioModule.
 */
import type { AudioModule } from '../core/index.js';

export interface Mood { activity: number; richness: number; stress: number; darkness: number; season: number }

export class SilentAudio implements AudioModule {
  running = false;
  mood: Mood = { activity: 0, richness: 0, stress: 0, darkness: 0, season: 0 };
  async start(): Promise<void> { this.running = true; }
  stop(): void { this.running = false; }
  setMood(m: Mood): void { this.mood = { ...m }; }
}

export const audio: AudioModule = new SilentAudio();
