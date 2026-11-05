# Contract requests from the site module

Filed by the site engineer, phase 1 (2026-11-05). The site lives in `site/` (landing page, embedded demo tank, creature share page) and is published by `.github/workflows/pages.yml`.

## 1. Add `site/` to CONTRACT 16 and to `tests/boundaries.test.ts`

**What.** A new row in the ownership table:

| Directory | Owns (interfaces and files) | May import |
|---|---|---|
| `site/` | the public GitHub Pages site: landing page, share page, site build and browser check | core, genome, ui |

and in `tests/boundaries.test.ts`:

```diff
   web: ['ui', 'core'],
+  site: ['core', 'genome', 'ui'],
 };
@@ function moduleOf(abs: string): string | null {
   if (rel.startsWith('web/')) return 'web';
+  if (rel.startsWith('site/')) return 'site';
@@
-    for (const f of [...files(join(root, 'src')), ...files(join(root, 'web'))]) {
+    for (const f of [...files(join(root, 'src')), ...files(join(root, 'web')), ...files(join(root, 'site/src'))]) {
```

**Why.** The share page decodes `.ptkg` and genomes (core), grows the preview with `genome.develop()` (genome), and looks for the UI's design preview (ui). Today `site/` is not scanned, so nothing stops it importing the sim or the host by mistake.

## 2. A design-preview hook on `src/ui`

**What.** `src/ui/index.ts` exports

```ts
/** Draw a still preview of a design into the canvas at its CSS size; false if it cannot. */
export function drawDesignPreview(canvas: HTMLCanvasElement, g: Genome, opts: { maturity: number; still: boolean }): boolean;
```

the same routine the library thumbnails (07 §2.2, 96x64) and the designer preview use.

**Why.** 07 §2.3 says the share page "runs the designer preview". Until this exists the share page draws a schematic of its own from the genome's module graph (`site/src/body.ts`), labelled as such. When the export appears, `site/src/preview.ts` uses it automatically (it checks for the function at run time), so no site change is needed. `still: true` means no animation (the share page shows a still image).

## 3. (Information) `develop()` Phenotype pose fields

`site/src/body.ts` `phenotypeBody()` assumes Phenotype parts are parent-first, `attachU` is 0..1 along the parent from its base, `restAngle` is in radians relative to the parent, and `length` and `radius` are metres. If the genome module defines them differently, please say so in CONTRACT 7 and the adapter will follow.
