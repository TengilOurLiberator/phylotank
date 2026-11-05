# site: the public GitHub Pages site

Owner: site engineer. Published at **https://tengilourliberator.github.io/phylotank/** from `.github/workflows/pages.yml`. Design: DESIGN §8 (v1.0 public release), William's Q12 (browser-only mode on the static site, share links with the creature in the URL fragment), [07 §2.3 to 2.5 and §5.3](../docs/sections/07-ux.md), [CONTRACT 14.2](../docs/CONTRACT.md) (`.ptkg` and `PTK1.` strings).

## One-time set-up (William)

The workflow cannot turn Pages on by itself, and nobody has done it yet. Once, in the GitHub repo:

1. **Settings, Pages** (https://github.com/TengilOurLiberator/phylotank/settings/pages).
2. Under **Build and deployment, Source**, choose **GitHub Actions**. Do not pick a branch.
3. Push to `main`, or run the **Pages** workflow by hand from the Actions tab (it has a "Run workflow" button).

Until Pages is enabled, the workflow's `build` job still builds and checks the site, and the `deploy` job fails with a "Pages site not found" error. That failure is expected and harmless. The first successful deploy creates the `github-pages` environment; nothing else needs configuring (no secrets, no custom domain, no Jekyll).

## What is here

| Path | What |
|---|---|
| `index.html` | Landing page: what Phylotank is, the embedded demo tank, screenshot placeholders, downloads (GitHub releases), install steps linked to [docs/INSTALL.md](../docs/INSTALL.md), share, licence and privacy. |
| `share.html` | Creature share page: `share#ptk=PTK1.xxx` (also `share.html#ptk=`, `share#PTK1.xxx` and `share#example`). |
| `style.css` | The deep-sea look. System fonts only. |
| `assets/` | `favicon.svg` (an original bell mark). |
| `src/ptk.ts` | Fragment parsing, `.ptkg` decoding with the 07 §2.4 import limits, metadata sanitising, file names. |
| `src/body.ts` | The preview: a schematic unfolding of the genome graph, a Phenotype adapter for `genome.develop()`, and a Canvas 2D painter. |
| `src/preview.ts` | Picks the preview source: the UI module's hook, then `develop()`, then the schematic. |
| `src/example.ts` | The built-in example creature, *Vitrilampas demonstrata* (an original CC0 design). |
| `src/share-main.ts`, `src/landing.ts` | Page scripts. |
| `build.mjs` | Assembles the site into one folder: bundles the scripts with esbuild, copies the pages, and copies the app from `dist/` into `tank/` without `host.mjs` and source maps. |
| `e2e.cjs` | Browser check in headless Chromium, with screenshots in `tests/artifacts/site-*.png`. |
| `tsconfig.json` | Typecheck for the site code (the root config does not include `site/`). |

Unit tests are in [`tests/site.test.ts`](../tests/site.test.ts).

## Build and check locally

```sh
npm run build                                # the app, into dist/
node site/build.mjs                          # the site, into site/_site/ (git-ignored)
NODE_PATH="$(npm root -g)" node site/e2e.cjs # needs a global Playwright, as for npm run test:e2e
npx vitest run tests/site
npx tsc --noEmit -p site/tsconfig.json
```

`node site/build.mjs --out _site` writes elsewhere; `--no-app` builds without a demo tank (a placeholder page instead). To look at it, serve the folder under a `/phylotank/` prefix, or just open `site/_site/index.html` from any static server (`npx http-server site/_site`); the demo tank needs HTTP because it starts a Web Worker. `e2e.cjs` serves it exactly like Pages does, including `/share` resolving to `share.html`.

## Decisions

- **The demo tank is the app itself.** `pages.yml` runs `npm run build` and `site/build.mjs` copies `dist/` into `tank/`, so the site always shows the current sim and renderer. The landing page embeds `tank/index.html?sim=worker` (the wallpaper profile: calm idle drift, 30 fps cap, the renderer's flash defence) in an iframe. It starts when it scrolls into view, waits for **Start** when the visitor prefers reduced motion or reduced data, and **Stop** unloads it completely. "Open it full screen" and "Screensaver view" link to the other pages in `tank/`. `chooseLink` already picks the worker on github.io, so no app change was needed.
- **The share page never talks to a network.** The creature is in the fragment, which browsers do not send to servers. The page's CSP is `default-src 'none'` with `connect-src 'none'`; the e2e check loads it, blocks every request, then opens a link (UX-T14), and asserts that no request is even attempted. `<meta name="referrer" content="no-referrer">` on every page.
- **Import safety (07 §2.4).** At most 64 KB raw (checked on the string length before decoding), at most 256 KB after inflate (the stream is cancelled as soon as it passes the cap), CRC checked by `decodePtkg`, genome CRC checked by `decodeGenome`, names capped at 40 characters, notes at 1 KB, tags at 16 of 24 characters, control and bidi characters stripped by `sanitiseText`, and every text is set with `textContent`. Each failure has its own sentence ("damaged: checksum does not match", "cut short", "made with a newer Phylotank", "a world reference, not a creature", and so on).
- **Download .ptkg** saves the container bytes exactly as shared (no re-encoding), named `Genus-epithet.ptkg` in ASCII. **Copy string** and **Copy link** use the clipboard API with a select-and-copy fallback. Packs (kind 2) show a chooser; world references (kind 3) are refused with an explanation.
- **Preview sources.** The contract has no UI preview interface yet, and `genome.develop()` is a phase-0 stub, so the page falls through, in order: a `drawDesignPreview(canvas, genome, {maturity, still})` export on `src/ui` (proposed in [docs/contract-requests/site.md](../docs/contract-requests/site.md)); `genome.develop()` drawn from the Phenotype; and a **schematic** unfolding done in `src/body.ts` (BFS over enabled links with attach position and angle, repeats, terminal-only links, mirror and radial symmetry, child and repeat scale, recursion limits and the 64-part cap). The page says which one it shows. The preview is a still image: nothing on the share page animates.
- **No flashing, accessible.** The only animations are slow drifts (14 s and longer) that never change brightness, and all of them stop under `prefers-reduced-motion`. Text colours are checked for WCAG AA contrast in the unit tests; focus is always visible; there is a skip link, landmarks, one `h1` per view, labelled form controls, a titled iframe, `role="img"` with a written description for the preview canvas, live regions for status messages and forced-colours support. The e2e script checks the structural rules on every view and that phones (390 px) get no horizontal scroll.
- **Self-contained.** No trackers, analytics, cookies, external fonts, CDNs or remote images; the unit tests scan the pages, styles and scripts for them, and the e2e check fails on any request that leaves the site's origin.
- **Downloads link to GitHub releases** (`/releases/latest` and `/releases`) and name the three assets that `release.yml` produces, because the asset names carry the version. Releases start as drafts, so `/releases/latest` shows nothing until William publishes one.
- **The site's code imports `src/core`, `src/genome` and `src/ui`**: what `web/` may import, plus `genome` for `develop()`. `tests/boundaries.test.ts` does not scan `site/` yet; the contract request adds a `site` row.

## Still to do

- Real screenshots once v0.1 creatures swim (replace the three placeholders in `index.html`).
- QR code on the share page (07 §2.3 shows it under 2,300 bytes), once a QR encoder is in the repo.
- "Add to my tank" hand-off to a local host is out of scope for v1 (Q12 default: no local hand-off).
- Swedish, with the rest of the UI's localisation.
