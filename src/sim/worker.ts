/**
 * Web Worker entry (the dream tank, DESIGN R31): runs a SimSession and speaks the view
 * protocol over postMessage. Bundled to dist/sim-worker.js.
 */
import { decodeCborFrame, FRAME, readHeader, type WorldConfig } from '../core/index.js';
import { Pacer } from './pacer.js';
import { DEFAULT_DREAM_CONFIG, SimSession, type SessionClient } from './session.js';
import { decodeDreamWorld, encodeDreamWorld } from './autosave.js';
import { sim } from './index.js';

/** Best-effort autosave to IndexedDB every 5 minutes (DESIGN 6 v0.1, acceptance test 7). */
export const AUTOSAVE_MS = 5 * 60 * 1000;
const DB = 'phylotank', STORE = 'worlds', KEY = 'dream';
function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = (self as unknown as { indexedDB?: IDBFactory }).indexedDB?.open(DB, 1);
      if (!req) { resolve(null); return; }
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function loadSaved(): Promise<Uint8Array | null> {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      r.onsuccess = () => resolve(r.result instanceof ArrayBuffer ? new Uint8Array(r.result) : null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
async function save(bytes: Uint8Array): Promise<void> {
  const db = await idb();
  if (!db) return;
  try { db.transaction(STORE, 'readwrite').objectStore(STORE).put(bytes.slice().buffer, KEY); } catch { /* best effort */ }
}

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
let starting: Promise<void> | null = null;
let pacer: Pacer | null = null;

scope.onmessage = (e) => {
  const bytes = new Uint8Array(e.data);
  const h = readHeader(bytes);
  if (h.type === FRAME.HELLO) {
    const { payload } = decodeCborFrame(bytes);
    const p = payload as { worldConfig?: Partial<WorldConfig> };
    if (!starting) {
      starting = (async () => {
        const config = { ...DEFAULT_DREAM_CONFIG, ...(p.worldConfig ?? {}), backend: 'cpu' as const };
        // resume the last autosave unless the page asked for a specific world
        let restored;
        if (!p.worldConfig) {
          try { const b = await loadSaved(); if (b) restored = decodeDreamWorld(b, sim); } catch { restored = undefined; }
        }
        session = new SimSession(config, sim, restored);
        const s = session;
        pacer = new Pacer({ hz: 30, onTicks: (n) => s.tick(n), currentTick: () => s.world.g.tick });
        s.attachPacer(pacer);
        pacer.start();
        setInterval(() => { try { void save(encodeDreamWorld(s.world)); } catch { /* best effort */ } }, AUTOSAVE_MS);
        (self as unknown as { __restored?: boolean }).__restored = !!restored;
      })();
    }
    // the dream tank is private to its page, so its one client may also command it
    void starting.then(() => session!.add(client, ['view', 'god']));
    return;
  }
  if (h.type === FRAME.BYE) {
    if (session) { try { void save(encodeDreamWorld(session.world)); } catch { /* best effort */ } }
    session?.remove(client); pacer?.stop(); return;
  }
  session?.receive(client, bytes);
};
