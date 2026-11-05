/** Tiny DOM helpers: `h()` builds elements, `Emitter` is a minimal change signal. No framework. */
export type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> | null | undefined;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'style') el.style.cssText = String(v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'min' || k === 'max' || k === 'step') {
        (el as unknown as Record<string, unknown>)[k] = v;
        if (k === 'disabled' && v) el.setAttribute('disabled', '');
      } else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Element): void { while (el.firstChild) el.removeChild(el.firstChild); }

/** Replace an element's children. */
export function mount(el: Element, ...children: Child[]): void { clear(el); append(el, children); }

/** Italic binomial name. */
export function binomial(name: string): HTMLElement { return h('i', { class: 'binomial' }, name); }

export class Emitter<T = void> {
  private ls = new Set<(v: T) => void>();
  on(fn: (v: T) => void): () => void { this.ls.add(fn); return () => this.ls.delete(fn); }
  emit(v: T): void { for (const l of [...this.ls]) l(v); }
}

/** Safe localStorage access (per-viewer conveniences only). */
export const store = {
  get(key: string): string | null { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } },
  set(key: string, v: string): void { try { globalThis.localStorage?.setItem(key, v); } catch { /* private mode */ } },
};

/** Small deterministic PRNG for view-side mock data and picking jitter (never sim). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
