# Contributing to Phylotank

Thank you for wanting to help. Phylotank is an open-source artificial-life fishtank, and contributions of every size are welcome: bug reports, a fix for a typo, a new gene, a god power, a shader, a translation, a creature design, or a long evolution run that shows something interesting (or broken).

Please read this page before your first pull request. It is short, and three rules in it are strict: **original designs only**, **determinism**, and the **module boundaries**.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Contents

1. [Licence and originality](#1-licence-and-originality)
2. [Set-up](#2-set-up)
3. [Running Phylotank](#3-running-phylotank)
4. [Tests](#4-tests)
5. [The determinism lint](#5-the-determinism-lint)
6. [The boundaries test](#6-the-boundaries-test)
7. [Changing the contract](#7-changing-the-contract)
8. [Commits and pull requests](#8-commits-and-pull-requests)
9. [Writing docs](#9-writing-docs)
10. [Reporting bugs and security problems](#10-reporting-bugs-and-security-problems)

---

## 1. Licence and originality

- **Code** is released under the [Unlicense](LICENSE): public domain, no conditions.
- **Assets** (creature designs and templates, `.ptkg` files, species names and name tables, images, look parameters, audio patches, texts and documentation) are dedicated to the public domain under [CC0 1.0](ASSETS-LICENSE).
- By opening a pull request you agree that your contribution is released under the same terms, and you confirm that you have the right to release it.

**Original designs only.** Every creature, name, piece of art, sound and text in Phylotank must be your own work (or already in the public domain, with its source stated). Do not copy, trace or closely imitate creatures, names, art, music or text from existing games, films, books or other software (Spore, The Bibites and the rest). Prior art may inspire the genre and the algorithms, and the design documents cite it, but nothing is copied from it. A design that is plainly a known character with the serial numbers filed off will be declined, however good it is.

**Dependencies** must be compatible with releasing Phylotank into the public domain: permissive licences (MIT, BSD, ISC, Apache-2.0, CC0, Unlicense) only, no GPL or other copyleft. Phylotank has very few runtime dependencies on purpose (`ws` for the host); please discuss a new one in an issue first.

## 2. Set-up

You need:

- **Node.js 22 or later** and npm (CI uses Node 22).
- For the browser tests: **Playwright with headless Chromium**, installed globally (it is not a dev dependency, to keep `npm ci` light):

  ```sh
  npm install --global playwright
  playwright install --with-deps chromium
  ```

  The browser scripts find it through `NODE_PATH`, so run them with `NODE_PATH="$(npm root -g)"` in front, as shown below.
- Optional, only for the Windows wrappers in `packaging/`: **Rust stable**. On Linux, `rustup target add x86_64-pc-windows-gnu` lets you type-check the Windows code.

Then:

```sh
git clone https://github.com/TengilOurLiberator/phylotank.git
cd phylotank
npm ci
```

There is no GPU requirement: the simulation runs on the CPU reference backend, and the browser tests render WebGL2 through SwiftShader.

## 3. Running Phylotank

```sh
npm run dev        # watch build, serve dist/ on http://127.0.0.1:8000/ (the in-page dream tank)
npm run build      # typecheck and bundle into dist/
npm run host       # build, then run the Node host on http://127.0.0.1:47615/
```

Pages: `index.html` (the dream tank), `wallpaper.html`, `screensaver.html`, `tv.html` and `god.html`. Served by the host they show the host's world; elsewhere they run a world in a Web Worker. Useful address options: `?host=ws://127.0.0.1:47615/ws/v1` (connect to a host), `?sim=worker` (force the in-page worker), `?sim=mock` (the god window's in-page practice world), `?lang=sv` or `?lang=xx` (Swedish, or the pseudo-locale that finds clipped text).

The host has a small CLI (run `npm run build` first, or use `node scripts/build.mjs` to bundle without the typecheck):

```sh
node dist/host.mjs --memory                  # serve a world kept in RAM only (nothing written to disk)
node dist/host.mjs --headless --ticks 3000   # run without a server and print the state hash
node dist/host.mjs inspect                   # list and verify the saved snapshots and journals
node dist/host.mjs replay                    # load the newest snapshot, replay the journal, verify, write nothing
```

Other options: `--port`, `--world <dir>`, `--name`, `--preset small|default|large`, `--seed`, `--autosave-min`, `--lan`. Without `--memory` the host keeps its world in your user data folder (`$XDG_DATA_HOME/phylotank/worlds/default`, `%LOCALAPPDATA%\Phylotank\worlds\default` on Windows).

The headless evolution lab runs long experiments and writes CSV, JSON and PNG charts:

```sh
node tools/evolab/evolab.mjs help
node tools/evolab/evolab.mjs run --engine toy --hours 1 --out ../evolab-toy   # a folder outside the repository
```

`--engine sim` runs the real simulation instead of the fast toy world, and `tune` searches parameters against the ecosystem's target bands.

## 4. Tests

### Unit, property and integration tests (vitest)

```sh
npm test                             # everything in tests/ and src/**/*.test.ts
PT_FAST=1 npm test                   # the same, skipping the one-hour golden run (about 80 s alone)
npx vitest run tests/genome          # one file or a prefix
npm run test:watch                   # re-run on change
```

Use `PT_FAST=1` for your inner loop; CI runs the full suite. On a busy machine the full suite can take several minutes, and the host and sim tests set long timeouts for that reason.

`PT_SPIKE=1` turns the quick physics benchmark tests into the full spike measurements, printing JSON lines tagged `SPIKE`. Spike reports with measured numbers live in [docs/spikes/](docs/spikes/).

### End-to-end browser tests

```sh
NODE_PATH="$(npm root -g)" npm run test:e2e          # bundle, load the dream tank and the host in headless Chromium, save tests/artifacts/smoke.png
NODE_PATH="$(npm root -g)" node tests/ui-screens.e2e.cjs     # after a build: drive the god window, write tests/artifacts/ui-*.png
NODE_PATH="$(npm root -g)" node tests/e2e/brain-crossengine.cjs   # the brain gives the same hash in Node and Chromium
NODE_PATH="$(npm root -g)" node tests/genome-chromium.cjs         # development and mutation are bit-identical in Node and Chromium
```

The site and the Lively package have their own checks (`node site/build.mjs` then `node site/e2e.cjs`; `node packaging/lively/build-zip.mjs` then `node packaging/lively/check-package.cjs`), both with the same `NODE_PATH`.

### Goldens

A golden is a recorded known-good result. Three kinds guard against accidental change:

| Golden | Where | Re-record |
|---|---|---|
| The state hash and digest after one simulated hour (108,000 ticks) | `GOLDEN_1H` in `tests/sim-acceptance.test.ts` | edit the one line, with the new values from the failing test |
| Phenotype hashes of every template at three growth stages | `GOLDEN` in `tests/genome.test.ts` | edit the table, with the new values from the failing test |
| Rendered images of test scenes (compared by SSIM, at least 0.98) | `tests/render-goldens/*.png`, test `tests/render-snapshot.test.ts` | `UPDATE_GOLDENS=1 npx vitest run tests/render-snapshot.test.ts` |

A golden that changes means behaviour changed. That is fine when you meant it: re-record it in the same commit and **say why in the commit message**. If you did not mean it, you have found a bug, very often a determinism bug (section 5).

### What tests to add

- A unit test for every new behaviour, in `tests/<module>*.test.ts`.
- A property or determinism test where the contract asks for one: same seed gives the same result; mass is conserved exactly (`ecosystem.audit` is integer equality, not a tolerance); a new gene's default leaves existing phenotypes unchanged.
- Keep `npm test` green on your branch.

## 5. The determinism lint

The simulation must replay bit for bit on every machine and JavaScript engine (see [ARCHITECTURE.md, section 6](docs/ARCHITECTURE.md#6-determinism-rules) for why and for all the rules). `tests/determinism-lint.test.ts` scans the sim code (`src/core`, `src/genome`, `src/physics`, `src/brain`, `src/ecosystem`, `src/sim`) and fails on:

| Banned | Use instead |
|---|---|
| `Math.random` | the Philox streams in `src/core/rng.ts`: `ctx.rng.draw(RNG_STREAM.X, ctx.tick, subjectId)` |
| `Date`, `performance.now`, `setTimeout` and other timers | the tick (`world.g.tick`, `ctx.tick`); outside inputs come through the journal |
| `crypto.getRandomValues`, `crypto.randomUUID` | the Philox streams |
| `Math.sin`, `cos`, `tan`, `exp`, `log`, `pow`, `atan`, `atan2`, `tanh`, `sinh`, `cosh`, `asin`, `acos`, `hypot`, `cbrt`, `expm1`, `log1p`, `log2`, `log10` | the same names from `src/core/dmath.ts` (plus `sigmoid`, `wrapAngle`, `hypot2`) |
| `.sort()` without a comparator | `.sort((a, b) => ...)` with a total order (break ties by slot or id) |

`Math.sqrt`, `floor`, `abs`, `min`, `max`, `round`, `trunc`, `sign` and `fround` are exactly specified and allowed. Three files that pace or transport the sim but never compute it are exempt (`src/sim/pacer.ts`, `src/sim/worker.ts`, `src/sim/client.ts`); do not add to that list lightly.

The lint cannot catch everything. Also keep to these by hand:

- Process entities in ascending slot order, and break every tie by slot.
- Never iterate a `Map`, `Set` or object keys to produce a sim result.
- Accumulate scatter-adds in integers or fixed point.
- Move matter only through the ledger, so the audit stays exact.

Run it alone with `npx vitest run tests/determinism-lint.test.ts`.

## 6. The boundaries test

Each directory under `src/` is a module with a narrow set of modules it may import ([ARCHITECTURE.md, section 2](docs/ARCHITECTURE.md#2-module-map), and CONTRACT 16). `tests/boundaries.test.ts` checks every relative import in `src/` and `web/` against that table, and that only `src/host` imports `node:` built-ins. For example, `src/director` may import only `src/core`, and `src/ui` may import `src/sim/client.ts` but nothing else from `src/sim`.

If you need something across a boundary, the answer is almost always to move a type or a pure function into `src/core` through a contract change (section 7), not to widen the table. Run it alone with `npx vitest run tests/boundaries.test.ts`.

## 7. Changing the contract

[docs/CONTRACT.md](docs/CONTRACT.md) is the single source of truth for everything shared between modules: units, the tick, the RNG streams, the world layout, the genome format, brain I/O, the ledger, events, the view protocol, god commands and the file formats. `src/core` is that contract in code.

A contract change is one commit that changes all three of: the text in `docs/CONTRACT.md`, the code in `src/core` (constants, schema tables, types), and `tests/contract.test.ts` where it checks the value. The commit message says what changed and why. Formats change only in forward-compatible ways: new genome fields and sections are appended with neutral defaults, new snapshot columns are matched by name, and readers ignore what they do not know.

If you are unsure whether a change is wanted, write it up first as a proposal in `docs/contract-requests/<module>.md` (what, why, the exact type or diff) or in an issue.

## 8. Commits and pull requests

**Commit messages** follow the style of the history:

```
genome: duplication keyed by paralog count, so a second copy gets a new id

Repair used to drop the second duplicate of a module because both copies took the same
innovation id (review R22). Test: duplicating one module three times gives three copies.
```

- The subject is `<area>: <what changed>`, in the present tense, with no full stop. The area is the module (`core`, `genome`, `physics`, `brain`, `ecosystem`, `sim`, `render`, `director`, `audio`, `ui`, `host`, `site`, `packaging`, `evolab`) or `docs`, `tests` or `ci`.
- The body says why, and anything a reviewer would otherwise have to dig for: a re-recorded golden and the reason, a contract change, measured numbers.
- Refer to design and test ids where they exist: review findings (R12), design decisions (DESIGN R3), test ids (UX-T35, B2).
- One logical change per commit; keep `npm test` green at every commit if you can.
- If an AI assistant wrote part of the change, say so with a `Co-Authored-By:` trailer, as the history does.

**Pull requests**:

- Branch from `main`; keep the pull request to one topic.
- CI runs on every pull request (`.github/workflows/ci.yml`): `npm test`, `npm run build`, the e2e smoke in headless Chromium, the Lively package check, the Rust tests and lints for the wrappers, and a Windows build with an install and uninstall smoke test. It must be green.
- Describe what you changed, how you tested it, and what you saw: a screenshot or a short clip for anything visual, numbers for anything about speed or balance.
- Visual changes must keep the photosensitive-safety limits (`src/render/safety.ts` and CONTRACT 15): nothing may flash, and the wallpaper stays gentle.

## 9. Writing docs

- **British English** (colour, behaviour, licence as a noun), plain words, short sentences.
- **No em-dashes**: use a colon, a comma, brackets or a new sentence.
- Say honestly what works and what does not; mark unbuilt features as planned, with their milestone.
- Where things live: user-facing docs in [README.md](README.md), [docs/USER-GUIDE.md](docs/USER-GUIDE.md), [docs/INSTALL.md](docs/INSTALL.md) and [docs/FAQ.md](docs/FAQ.md); contributor docs in this file and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); terms in [docs/GLOSSARY.md](docs/GLOSSARY.md); each module's decisions in `docs/modules/<module>.md` and its README; measurements in `docs/spikes/`.
- Every command you document should be one you have run.

## 10. Reporting bugs and security problems

- **Bugs**: open an issue with what you did, what you expected and what happened. For a simulation bug, the seed, the preset and the tick help most: a deterministic world can be replayed exactly, so a world folder or a `.ptk` snapshot plus its journal is the best bug report there is.
- **Security problems** (the host serves pages and a WebSocket, and parses snapshots and shared creatures): please do not open a public issue. Use GitHub's private vulnerability reporting on the repository ("Security", then "Report a vulnerability") where it is offered, or ask the maintainer for a private channel in an issue that gives no details.
