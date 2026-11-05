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
    const p = payload as { worldConfig?: Partial<WorldConfig>; caps?: { proto?: unknown } };
    if (!session) {
      session = new SimSession({ ...DEFAULT_DREAM_CONFIG, ...(p.worldConfig ?? {}), backend: 'cpu' });
      const s = session;
      pacer = new Pacer({ hz: 30, onTicks: (n) => s.tick(n), currentTick: () => s.world.g.tick });
      s.attachPacer(pacer);
      pacer.start();
    }
    // the dream tank is private to its page, so its one client may also command it
    const proto = typeof p.caps?.proto === 'number' ? p.caps.proto : 0x0100;
    session.add(client, ['view', 'god'], { proto });
    return;
  }
  if (h.type === FRAME.BYE) { session?.remove(client); pacer?.stop(); return; }
  session?.receive(client, bytes);
};
