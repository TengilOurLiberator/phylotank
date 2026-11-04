/**
 * Web Worker entry (the dream tank, DESIGN R31): runs a SimSession and speaks the view
 * protocol over postMessage. Bundled to dist/sim-worker.js.
 */
import { decodeCborFrame, FRAME, readHeader, type WorldConfig } from '../core/index.js';
import { Pacer } from './pacer.js';
import { DEFAULT_DREAM_CONFIG, SimSession, type SessionClient } from './session.js';

interface WorkerScope {
  onmessage: ((e: MessageEvent<ArrayBuffer>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

const client: SessionClient = {
  send(frame) {
    const copy = frame.byteOffset === 0 && frame.byteLength === frame.buffer.byteLength ? frame : frame.slice();
    scope.postMessage(copy.buffer, [copy.buffer as ArrayBuffer]);
  },
};

let session: SimSession | null = null;
let pacer: Pacer | null = null;

scope.onmessage = (e) => {
  const bytes = new Uint8Array(e.data);
  const h = readHeader(bytes);
  if (h.type === FRAME.HELLO) {
    const { payload } = decodeCborFrame(bytes);
    const p = payload as { worldConfig?: Partial<WorldConfig> };
    if (!session) {
      session = new SimSession({ ...DEFAULT_DREAM_CONFIG, ...(p.worldConfig ?? {}), backend: 'cpu' });
      pacer = new Pacer({ hz: 30, onTicks: (n) => session!.tick(n) });
      pacer.start();
    }
    session.add(client, ['view']);
    return;
  }
  if (h.type === FRAME.BYE) { pacer?.stop(); return; }
  session?.receive(client, bytes);
};
