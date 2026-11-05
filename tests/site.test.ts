/**
 * The public site (site/): share-string decoding and its import-safety rules (07 §2.4,
 * CONTRACT 14.2), the schematic preview, the static pages' privacy and accessibility rules,
 * the site build and the Pages workflow. The browser side is in site/e2e.cjs.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  encodeGenome, encodePtkg, GENOME_FORMAT_VERSION, KIND, LINK_FLAG, LINK_RECORD, MAX_PARTS, NotImplementedError,
  PTKG_KIND, toPtkString, defaultRecord, type GenomeModule, type LinkGene, type Phenotype,
} from '../src/core/index.js';
import { blankGenome, genome as genomeModule } from '../src/genome/index.js';
import { describeBody, schematicBody } from '../site/src/body.js';
import { exampleContainer, exampleGenome, exampleString } from '../site/src/example.js';
import { bodyFor, uiPreviewHook } from '../site/src/preview.js';
import {
  designMeta, displayName, inflateRawCapped, loadShare, MAX_STRING_CHARS, ptkgFileName, readFragment, safeMeta, shareLink, ShareError,
} from '../site/src/ptk.js';

const root = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const zlib = { deflate: (b: Uint8Array) => new Uint8Array(deflateRawSync(b)), inflate: () => { throw new Error('unused'); } };

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(ShareError); return (e as ShareError).code; }
  throw new Error('expected a ShareError');
}
function container(payload: unknown, kind: number = PTKG_KIND.DESIGN, z?: typeof zlib): Uint8Array {
  return encodePtkg({ kind, genomeVersion: GENOME_FORMAT_VERSION, payload: payload as never }, z);
}

describe('site: share fragment', () => {
  it('reads the canonical, bare, encoded and wrapped forms', () => {
    const s = exampleString();
    expect(readFragment('')).toEqual({ kind: 'none' });
    expect(readFragment('#')).toEqual({ kind: 'none' });
    expect(readFragment('#example')).toEqual({ kind: 'example' });
    expect(readFragment(`#ptk=${s}`)).toEqual({ kind: 'ptk', value: s });
    expect(readFragment(`#${s}`)).toEqual({ kind: 'ptk', value: s });
    expect(readFragment(`#ptk=${encodeURIComponent(s)}`)).toEqual({ kind: 'ptk', value: s });
    expect(readFragment(`#ptk=${s.slice(0, 40)}%0A ${s.slice(40)}`)).toEqual({ kind: 'ptk', value: s });
    expect(readFragment(`#v=2&ptk=${s}`)).toEqual({ kind: 'ptk', value: s });
    expect(() => readFragment('#ptk=%E0%A4%A')).toThrow(ShareError);
    expect(() => readFragment(`#ptk=${'A'.repeat(MAX_STRING_CHARS * 4)}`)).toThrow(ShareError);
  });
  it('builds share links relative to the page', () => {
    expect(shareLink('https://tengilourliberator.github.io/phylotank/share#old', 'PTK1.abc'))
      .toBe('https://tengilourliberator.github.io/phylotank/share#ptk=PTK1.abc');
  });
});

describe('site: loading a shared design', () => {
  it('round-trips the example and gives a 07 §2.3 fingerprint', async () => {
    const s = exampleString();
    const r = await loadShare(s);
    expect(r.string).toBe(s);
    expect(r.kind).toBe('design');
    expect(r.compressed).toBe(false);
    expect(Array.from(r.container)).toEqual(Array.from(exampleContainer()));
    expect(r.designs).toHaveLength(1);
    const d = r.designs[0]!;
    expect(d.fingerprint).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(displayName(d.meta)).toBe('Vitrilampas demonstrata');
    expect(d.meta.common).toBe('Example glassdart');
    expect(Array.from(encodeGenome(d.genome))).toEqual(Array.from(encodeGenome(exampleGenome())));
    // the string is deterministic, so links stay stable across builds
    expect(exampleString()).toBe(s);
    expect(s.length).toBeLessThan(3000); // UX-T11
  });
  it('opens deflate-compressed designs and species packs', async () => {
    const g = encodeGenome(blankGenome());
    const meta = designMeta({ name: { genus: 'Testa', epithet: 'compressa' } });
    const z = await loadShare(toPtkString(container({ meta, genome: g }, PTKG_KIND.DESIGN, zlib)));
    expect(z.compressed).toBe(true);
    expect(z.designs[0]!.meta.genus).toBe('Testa');
    const pack = await loadShare(toPtkString(container({ meta, designs: [{ meta, genome: g }, { meta: { ...meta, name: { genus: 'Testa', epithet: 'secunda' } }, genome: g }] }, PTKG_KIND.PACK, zlib)));
    expect(pack.kind).toBe('pack');
    expect(pack.designs.map((d) => d.meta.epithet)).toEqual(['compressa', 'secunda']);
  });
  it('gives a specific reason for each kind of bad input', async () => {
    const s = exampleString();
    const bytes = exampleContainer();
    const flip = bytes.slice(); flip[40] = flip[40]! ^ 0xff;
    expect(await code(loadShare('hello'))).toBe('not-ptk');
    expect(await code(loadShare('PTK1.abc$def'))).toBe('bad-base64');
    expect(await code(loadShare(toPtkString(flip)))).toBe('bad-checksum');
    expect(await code(loadShare(s.slice(0, 33)))).toBe('truncated');
    expect(await code(loadShare(s.slice(0, 30)))).toBe('bad-base64');
    expect(await code(loadShare(`PTK1.${'A'.repeat(MAX_STRING_CHARS)}`))).toBe('too-large');
    const notPtk = bytes.slice(); notPtk[0] = 0x51;
    expect(await code(loadShare(toPtkString(notPtk)))).toMatch(/bad-magic|bad-checksum/);
    const newer = encodePtkg({ kind: 1, genomeVersion: GENOME_FORMAT_VERSION + 1, payload: { meta: designMeta({ name: { genus: 'a', epithet: 'b' } }), genome: new Uint8Array(4) } });
    expect(await code(loadShare(toPtkString(newer)))).toBe('newer');
    expect(await code(loadShare(toPtkString(container({ meta: {} }))))).toBe('no-genome');
    expect(await code(loadShare(toPtkString(container({ meta: {}, genome: new Uint8Array(64) }))))).toBe('bad-genome');
    expect(await code(loadShare(toPtkString(container({ meta: {} }, PTKG_KIND.WORLD_REF))))).toBe('world-ref');
    expect(await code(loadShare(toPtkString(container({ meta: {}, designs: [] }, PTKG_KIND.PACK))))).toBe('empty-pack');
    expect(await code(loadShare(toPtkString(container({ meta: {} }, 9))))).toBe('unknown-kind');
  });
  it('aborts a decompression bomb at the 256 KB cap', async () => {
    const bomb = new Uint8Array(deflateRawSync(new Uint8Array(4 << 20)));
    expect(bomb.length).toBeLessThan(65_536);
    expect(await code(inflateRawCapped(bomb, 262_144))).toBe('too-large-inflated');
    const c = container({ meta: {}, genome: new Uint8Array(4 << 20) }, PTKG_KIND.DESIGN, zlib);
    expect(await code(loadShare(toPtkString(c)))).toBe('too-large-inflated');
    expect(await code(inflateRawCapped(new Uint8Array([1, 2, 3, 4, 5]), 1000))).toBe('bad-deflate');
  });
});

describe('site: untrusted metadata', () => {
  it('strips control and bidi characters, caps lengths and ignores wrong types', () => {
    const m = safeMeta({
      name: { genus: 'Evil‮genus\u0007', epithet: 'x'.repeat(100), common: 42 },
      notes: `<img src=x onerror=alert(1)>${'n'.repeat(2000)}`,
      author: ['not', 'a', 'string'],
      created: 'yesterday', origin: 'hacked', tags: ['a', 7, 'b'.repeat(50), ...Array(40).fill('t')],
      world: { name: 'Tank', day: 3.7, generation: -2 }, licence: 'CC0-1.0',
    });
    expect(m.genus).toBe('Evilgenus');
    expect(m.epithet).toHaveLength(40);
    expect(m.common).toBe('');
    expect(m.notes.startsWith('<img src=x')).toBe(true); // kept as literal text; the page uses textContent
    expect(m.notes).toHaveLength(1024);
    expect(m.author).toBe('');
    expect(m.created).toBe('');
    expect(m.origin).toBe('unknown');
    expect(m.tags.length).toBeLessThanOrEqual(16);
    expect(m.tags[1]).toHaveLength(24);
    expect(m.world).toEqual({ name: 'Tank', day: 3, generation: 0 });
    expect(safeMeta(null).genus).toBe('');
    expect(displayName(safeMeta(null))).toBe('Unnamed creature');
  });
  it('makes file names safe on every OS', () => {
    expect(ptkgFileName(safeMeta({ name: { genus: 'Pratilux', epithet: 'tondens' } }))).toBe('Pratilux-tondens.ptkg');
    expect(ptkgFileName(safeMeta({ name: { genus: 'Ångström', epithet: '../../etc' } }))).toBe('Angstrom-etc.ptkg');
    expect(ptkgFileName(safeMeta({ name: { genus: '***', epithet: '' } }))).toBe('phylotank-design.ptkg');
  });
  it('never writes imported text as HTML', () => {
    for (const f of readdirSync(join(root, 'site/src'))) {
      const src = read(`site/src/${f}`);
      expect(src, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
    }
  });
});

describe('site: preview', () => {
  it('unfolds the example genome into the expected parts', () => {
    const b = schematicBody(exampleGenome());
    const n = (k: number): number => b.parts.filter((p) => p.kind === k).length;
    expect(b.source).toBe('schematic');
    expect(n(KIND.SEGMENT)).toBe(5); // head plus four trunk repeats
    expect(n(KIND.FIN)).toBe(4); // tail fluke, a mirrored pair, a dorsal fin
    expect(n(KIND.EYE)).toBe(1);
    expect(n(KIND.PHOTOPHORE)).toBe(5); // a belly light per trunk segment plus the lure
    expect(describeBody(b)).toBe('5 body segments, 4 fins, 1 limb or tentacle, 1 eye, 5 light organs and a mouth');
    for (const p of b.parts) for (const v of [p.x, p.y, p.angle, p.length, p.radius]) expect(Number.isFinite(v)).toBe(true);
    expect(schematicBody(exampleGenome())).toEqual(b);
  });
  it('stays within MAX_PARTS on runaway recursion and copes with empty genomes', () => {
    const g = blankGenome();
    const l = defaultRecord<LinkGene>(LINK_RECORD);
    Object.assign(l, { innov: 9000, fromInnov: 1, toInnov: 1, flags: LINK_FLAG.ENABLED, repeat: 16, attachPos: 255, childScale: 128, repeatScale: 128 });
    g.modules[0]!.recursionLimit = 7;
    g.links.push(l, { ...l, innov: 9001, attachAngle: 40 });
    expect(schematicBody(g).parts.length).toBeLessThanOrEqual(MAX_PARTS);
    expect(schematicBody(blankGenome()).parts).toHaveLength(1);
    const empty = blankGenome(); empty.modules = [];
    expect(schematicBody(empty).parts).toHaveLength(0);
  });
  it('falls back to the schematic while develop() is a stub, and uses develop() once it works', () => {
    const g = exampleGenome();
    expect(bodyFor(g).source).toBe('schematic'); // the phase-0 stub throws NotImplementedError
    const stub = { ...genomeModule, develop: () => { throw new NotImplementedError('x'); } } as GenomeModule;
    expect(bodyFor(g, stub).source).toBe('schematic');
    const ph = {
      nParts: 2, parent: Int16Array.from([-1, 0]), kind: Uint8Array.from([0, 1]), subtype: new Uint8Array(2),
      attachU: Float32Array.from([0, 1]), restAngle: Float32Array.from([0, 0.3]), length: Float32Array.from([0.02, 0.01]),
      radius: Float32Array.from([0.004, 0.002]), taper: Float32Array.from([1, 0.5]), glow: new Float32Array(2), hue: new Float32Array(2),
      adultLengthM: 0.03,
    } as unknown as Phenotype;
    const real = { ...genomeModule, develop: () => ph } as GenomeModule;
    const b = bodyFor(g, real);
    expect(b.source).toBe('develop');
    expect(b.parts[1]!.x).toBeCloseTo(-0.02, 6);
    expect(uiPreviewHook({})).toBeNull();
    const hook = (): boolean => true;
    expect(uiPreviewHook({ drawDesignPreview: hook })).toBe(hook);
  });
});

describe('site: static pages', () => {
  const pages = ['site/index.html', 'site/share.html'];
  it('load nothing from other origins and carry no trackers', () => {
    for (const p of pages) {
      const html = read(p);
      for (const m of html.matchAll(/<(script|link|img|iframe|source|video|audio)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
        expect(m[2], `${p}: ${m[0]}`).not.toMatch(/^(https?:)?\/\//);
      }
      expect(html).toMatch(/http-equiv="Content-Security-Policy"[^>]*default-src 'none'/);
      expect(html).toMatch(/connect-src 'none'/);
      expect(html).toMatch(/<html lang="en-GB">/);
      expect(html).toMatch(/<meta name="viewport"/);
      expect(html).toMatch(/class="skip" href="#main"/);
    }
    const all = [...pages, 'site/style.css', ...readdirSync(join(root, 'site/src')).map((f) => `site/src/${f}`)].map(read).join('\n');
    expect(all).not.toMatch(/google-analytics|googletagmanager|gtag\(|plausible|umami|matomo|segment\.io|hotjar|fonts\.googleapis|fonts\.gstatic|cdnjs|jsdelivr|unpkg|@import|@font-face/i);
    expect(all).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource/);
    expect(read('site/style.css')).not.toMatch(/url\((?!["']?data:)/);
  });
  it('use British English without em-dashes, and links point at the real repo', () => {
    const text = [...pages, 'site/README.md', 'site/style.css'].map(read).join('\n');
    expect(text).not.toMatch(/—/);
    const index = read('site/index.html');
    expect(index).toContain('https://github.com/TengilOurLiberator/phylotank/releases');
    expect(index).toContain('https://github.com/TengilOurLiberator/phylotank/blob/main/docs/INSTALL.md');
    expect(index).toContain('Unlicense');
    expect(index).toContain('CC0 1.0');
    expect(index).toMatch(/id="demo-frame"/);
  });
  it('respect reduced motion and do not flash', () => {
    const css = read('site/style.css');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*animation: none/);
    // every animation is a slow drift: no keyframes touch opacity, filter or colour
    for (const m of css.matchAll(/@keyframes [\w-]+ \{([^}]*\}[^}]*)\}/g)) expect(m[1]).not.toMatch(/opacity|filter|color|background/);
    for (const m of css.matchAll(/animation(?:-duration)?: (?:[a-z][\w-]* )?([\d.]+)s/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(10);
  });
  it('meet WCAG AA contrast for the text colours', () => {
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const ratio = (a: string, b: string): number => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
    const css = read('site/style.css');
    const token = (n: string): string => new RegExp(`--${n}: (#[0-9a-f]{6})`, 'i').exec(css)![1]!;
    // the lightest backgrounds text sits on: the top of the page gradient and the card tops
    for (const bg of ['#062a40', '#0a3248', token('water')]) {
      for (const fg of ['text', 'muted', 'link', 'glow', 'violet', 'amber']) expect(ratio(token(fg), bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio('#02141c', '#4fe3d2')).toBeGreaterThanOrEqual(4.5); // primary button text
    expect(ratio(token('focus'), token('deep'))).toBeGreaterThanOrEqual(3); // focus ring
  });
});

describe('site: build and Pages workflow', () => {
  it('assembles a self-contained site with the app in tank/, without the host or source maps', async () => {
    const { buildSite } = (await import(pathToFileURL(join(root, 'site/build.mjs')).href)) as {
      buildSite(o: { outDir: string; distDir: string; withApp: boolean; quiet: boolean }): Promise<string>;
    };
    const tmp = mkdtempSync(join(tmpdir(), 'pt-site-'));
    try {
      const dist = join(tmp, 'dist');
      mkdirSync(dist);
      for (const f of ['index.html', 'app.js', 'sim-worker.js', 'app.js.map', 'host.mjs', 'god.html']) writeFileSync(join(dist, f), f);
      const out = await buildSite({ outDir: join(tmp, 'out'), distDir: dist, withApp: true, quiet: true });
      for (const f of ['index.html', 'share.html', 'style.css', 'landing.js', 'share.js', 'assets/favicon.svg', 'tank/index.html', 'tank/app.js', 'tank/sim-worker.js', 'tank/god.html']) {
        expect(existsSync(join(out, f)), f).toBe(true);
      }
      expect(existsSync(join(out, 'tank/host.mjs'))).toBe(false);
      expect(existsSync(join(out, 'tank/app.js.map'))).toBe(false);
      const share = readFileSync(join(out, 'share.js'), 'utf8');
      expect(share).not.toMatch(/https?:\/\/(?!www\.w3\.org|tengilourliberator\.github\.io)[a-z]/i);
      const bare = await buildSite({ outDir: join(tmp, 'bare'), distDir: join(tmp, 'nothing'), withApp: false, quiet: true });
      expect(readFileSync(join(bare, 'tank/index.html'), 'utf8')).toContain('not built');
      await expect(buildSite({ outDir: join(tmp, 'x'), distDir: join(tmp, 'nothing'), withApp: true, quiet: true })).rejects.toThrow(/npm run build/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
  it('pages.yml builds the app, then the site, checks it and deploys with actions/deploy-pages', () => {
    const y = read('.github/workflows/pages.yml');
    expect(y).toMatch(/branches: \[main\]/);
    expect(y).toMatch(/workflow_dispatch/);
    expect(y).toMatch(/npm ci/);
    expect(y).toMatch(/npm run build/);
    expect(y).toMatch(/node site\/build\.mjs --out _site/);
    expect(y).toMatch(/node site\/e2e\.cjs _site/);
    expect(y).toMatch(/actions\/upload-pages-artifact@v\d/);
    expect(y).toMatch(/actions\/deploy-pages@v\d/);
    expect(y).toMatch(/pages: write/);
    expect(y).toMatch(/id-token: write/);
    expect(y).toMatch(/name: github-pages/);
    expect(y).toMatch(/needs: build/);
    expect(y.indexOf('npm run build')).toBeLessThan(y.indexOf('node site/build.mjs'));
  });
});
