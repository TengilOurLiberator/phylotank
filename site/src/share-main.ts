/**
 * The creature share page (07 §2.3 to 2.5, DESIGN Q12): `share#ptk=PTK1.xxx`. The design lives
 * in the URL fragment, which the browser never sends to a server, and this page makes no
 * network requests at all (its CSP says `connect-src 'none'`). Every imported text is shown
 * with textContent, never as HTML.
 */
import { exampleString } from './example.js';
import { describeBody } from './body.js';
import { drawPreview } from './preview.js';
import { displayName, loadShare, ptkgFileName, readFragment, shareLink, ShareError, type LoadedDesign, type LoadedShare } from './ptk.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const views = ['loading', 'empty', 'error', 'design'] as const;
type View = (typeof views)[number];
function show(v: View): void {
  for (const id of views) $(id).hidden = id !== v;
}

let current: LoadedShare | null = null;
let selected = 0;
let statusTimer = 0;

function status(text: string): void {
  const el = $('status');
  el.textContent = text;
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => { el.textContent = ''; }, 6000);
}

const ORIGIN: Record<string, string> = {
  designer: 'Designed by hand', captured: 'Evolved in a tank, then captured', template: 'A starter template', unknown: 'Unknown',
};

function setFact(id: string, value: string): void {
  const row = $(id);
  const dd = row.querySelector('dd');
  if (dd) dd.textContent = value;
  row.hidden = value.length === 0;
}

function renderDesign(share: LoadedShare, index: number): void {
  const d: LoadedDesign = share.designs[index]!;
  const m = d.meta;
  const name = displayName(m);
  document.title = `${name} - Phylotank creature`;
  const h1 = $('d-name');
  h1.textContent = '';
  if (m.genus || m.epithet) {
    const i = document.createElement('i');
    i.textContent = name;
    h1.appendChild(i);
  } else {
    h1.textContent = name;
  }
  $('d-common').textContent = m.genus || m.epithet ? m.common : '';
  $('d-common').hidden = !(m.common && (m.genus || m.epithet));
  setFact('f-fingerprint', d.fingerprint);
  setFact('f-origin', ORIGIN[m.origin] ?? 'Unknown');
  setFact('f-author', m.author);
  setFact('f-created', m.created ? m.created.slice(0, 10) : '');
  setFact('f-world', m.world ? `${m.world.name || 'a tank'}, day ${m.world.day}, generation ${m.world.generation}` : '');
  setFact('f-size', `${share.string.length.toLocaleString('en-GB')} characters (${share.container.length.toLocaleString('en-GB')} bytes${share.compressed ? ', compressed' : ''})`);
  setFact('f-licence', m.licence === 'CC0-1.0' ? 'CC0 1.0 (public domain)' : m.licence);
  $('d-notes').textContent = m.notes;
  $('d-notes').hidden = m.notes.length === 0;
  const tags = $('d-tags');
  tags.textContent = '';
  for (const t of m.tags) {
    const li = document.createElement('li');
    li.textContent = t;
    tags.appendChild(li);
  }
  tags.hidden = m.tags.length === 0;

  const canvas = $<HTMLCanvasElement>('preview');
  const res = drawPreview(canvas, d.genome);
  const bodyText = res.body ? describeBody(res.body) : '';
  setFact('f-body', bodyText ? bodyText.charAt(0).toUpperCase() + bodyText.slice(1) : '');
  canvas.setAttribute('aria-label', `Side view of ${name}${bodyText ? `: ${bodyText}` : ''}.`);
  $('preview-note').textContent = res.source === 'schematic'
    ? 'Schematic preview, unfolded from the genome on this page. The full body preview arrives with the creature designer.'
    : res.source === 'develop' ? 'Adult body, grown from the genome with Phylotank’s own development code.' : 'Preview from the Phylotank designer.';
  canvas.dataset.source = res.source;

  const str = $<HTMLTextAreaElement>('d-string');
  str.value = share.string;
  const pack = $('pack');
  pack.hidden = share.designs.length < 2;
  if (share.designs.length >= 2) {
    const list = $('pack-list');
    list.textContent = '';
    share.designs.forEach((x, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = displayName(x.meta);
      b.setAttribute('aria-pressed', String(i === index));
      b.addEventListener('click', () => { selected = i; renderDesign(share, i); });
      li.appendChild(b);
      list.appendChild(li);
    });
  }
}

async function load(userAction = false): Promise<void> {
  current = null;
  let req;
  try {
    req = readFragment(window.location.hash);
  } catch (e) {
    return fail(e, userAction);
  }
  if (req.kind === 'none') { document.title = 'Share a creature - Phylotank'; show('empty'); return; }
  const text = req.kind === 'example' ? exampleString() : req.value;
  show('loading');
  try {
    current = await loadShare(text);
    selected = 0;
    show('design'); // first, so the preview canvas has a size to draw at
    renderDesign(current, 0);
    if (req.kind === 'example') history.replaceState(null, '', `#ptk=${current.string}`);
    if (userAction) $('d-name').focus({ preventScroll: true });
    (window as unknown as { __share?: unknown }).__share = { ok: true, source: $('preview').dataset.source, designs: current.designs.length, fingerprint: current.designs[0]!.fingerprint };
  } catch (e) {
    fail(e, userAction);
  }
}

function fail(e: unknown, userAction = false): void {
  const reason = e instanceof ShareError ? e.message : 'Something unexpected went wrong while reading this creature.';
  if (!(e instanceof ShareError)) console.error(e);
  document.title = 'Creature link did not open - Phylotank';
  $('error-reason').textContent = reason;
  show('error');
  if (userAction) $('error-title').focus({ preventScroll: true });
  (window as unknown as { __share?: unknown }).__share = { ok: false, code: e instanceof ShareError ? e.code : 'unexpected' };
}

async function copyText(text: string, fallbackFrom: HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const details = fallbackFrom.closest('details');
      if (details) details.open = true;
      fallbackFrom.focus();
      fallbackFrom.select();
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

function wire(): void {
  $('download').addEventListener('click', () => {
    if (!current) return;
    const d = current.designs[selected]!;
    const blob = new Blob([current.container as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = ptkgFileName(current.kind === 'pack' ? { ...d.meta, genus: 'species-pack', epithet: d.meta.genus } : d.meta);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    status(`Saved ${a.download}.`);
  });
  $('copy-string').addEventListener('click', async () => {
    if (!current) return;
    const ok = await copyText(current.string, $<HTMLTextAreaElement>('d-string'));
    status(ok ? `Copied the PTK1 string (${current.string.length.toLocaleString('en-GB')} characters).` : 'Could not copy automatically: the string is selected below, so press Ctrl+C.');
  });
  $('copy-link').addEventListener('click', async () => {
    if (!current) return;
    const link = shareLink(window.location.href, current.string);
    const ok = await copyText(link, $<HTMLTextAreaElement>('d-string'));
    status(ok ? 'Copied the share link.' : 'Could not copy automatically: copy the address from the address bar.');
  });
  for (const form of document.querySelectorAll<HTMLFormElement>('form.paste-form')) {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const ta = form.querySelector('textarea');
      const v = (ta?.value ?? '').replace(/\s+/g, '');
      const msg = form.querySelector<HTMLElement>('.paste-msg');
      if (!v) { if (msg) msg.textContent = 'Paste a string that starts with PTK1. first.'; ta?.focus(); return; }
      if (msg) msg.textContent = '';
      const m = /[#&]ptk=([^&]+)/.exec(v);
      window.location.hash = `ptk=${m ? m[1] : v}`;
    });
  }
  window.addEventListener('hashchange', () => { void load(true); });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => { if (current) renderDesign(current, selected); }, 150);
  });
}

wire();
void load();
