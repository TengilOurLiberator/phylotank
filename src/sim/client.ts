/**
 * View-side links to a sim (CONTRACT 12): a Web Worker running the dream tank, or a WebSocket
 * to the host. The only part of src/sim that src/ui may import.
 */
import type { SimLink } from '../core/index.js';

function own(frame: Uint8Array): ArrayBuffer {
  const copy = frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength ? frame : frame.slice();
  return copy.buffer as ArrayBuffer;
}

export class WorkerLink implements SimLink {
  readonly kind = 'worker' as const;
  private readonly w: Worker;
  private cb: ((f: Uint8Array) => void) | null = null;
  constructor(url: string) {
    this.w = new Worker(url);
    this.w.onmessage = (e: MessageEvent<ArrayBuffer>) => this.cb?.(new Uint8Array(e.data));
    this.w.onerror = (e) => console.error('sim worker error', e.message);
  }
  onFrame(cb: (f: Uint8Array) => void): void { this.cb = cb; }
  send(frame: Uint8Array): void { const b = own(frame); this.w.postMessage(b, [b]); }
  close(): void { this.w.terminate(); }
}

export class SocketLink implements SimLink {
  readonly kind = 'socket' as const;
  private readonly ws: WebSocket;
  private cb: ((f: Uint8Array) => void) | null = null;
  private queue: Uint8Array[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (e: MessageEvent<ArrayBuffer>) => this.cb?.(new Uint8Array(e.data));
    this.ws.onopen = () => { for (const f of this.queue) this.ws.send(own(f)); this.queue = []; };
  }
  onFrame(cb: (f: Uint8Array) => void): void { this.cb = cb; }
  send(frame: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(own(frame));
    else this.queue.push(frame.slice());
  }
  close(): void { this.ws.close(); }
}
