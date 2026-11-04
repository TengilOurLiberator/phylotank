# Phylotank

An artificial-life fishtank. A glowing, deep-sea, 2D side view of a finite tank holds creatures whose bodies are grown from DNA, whose brains are evolved neural networks, and whose every trait, including how they reproduce and how fast they mutate, is heritable. Light-grown plankton feed grazers, grazers feed predators, corpses feed scavengers and the plankton again. You design creatures, release them, and as god throw meteors, plagues and cold snaps at the tank to watch it react. Nobody scripts outcomes.

One persistent world, four views of it: a calm **wallpaper** (Lively Wallpaper), a **screensaver** with a documentary camera director, a **TV** view, and a **god window** with the creature designer, powers and stats.

## Status

**Phase 0** (2026-11-05): the interface contract and a running skeleton. Not a creature simulation yet.

- [docs/CONTRACT.md](docs/CONTRACT.md) defines every shared interface: units, coordinates, tick, presets, RNG and determinism rules, the world-state layout, the genome binary format v1, the developed body, brain I/O and the brain tick, the mass and energy ledger, the agent-cap tax, events, the view protocol, god commands, the `.ptk` and `.ptkg` formats, view modes and module ownership.
- The skeleton runs end to end: a web page starts a worker, the worker runs the sim loop on a small world (glowing motes drifting in a divergence-free current), and a WebGL2 canvas draws them. The same sim runs in Node, behind the host's WebSocket and in headless tests.
- Every module directory has typed stubs implementing its contract interface and a README with its responsibilities, the review findings it must address, its first spike and its acceptance tests.

Design: [docs/DESIGN.md](docs/DESIGN.md) (with William's answers in §10), review: [docs/REVIEW.md](docs/REVIEW.md), detail: [docs/sections/](docs/sections/).

## Run it

Requires Node 22 or later.

```sh
npm install
npm run dev        # watch build and serve dist/ on http://127.0.0.1:8000/ (in-page dream tank)
npm run build      # typecheck and bundle into dist/
npm test           # unit, contract, determinism, boundary and host tests (vitest)
npm run test:e2e   # build, load the page in headless Chromium, save tests/artifacts/smoke.png
npm run host       # build and run the Node host on http://127.0.0.1:47615/
node dist/host.mjs --headless --ticks 3000   # run without a server and print the state hash
```

Pages: `index.html` (dream tank, wallpaper profile), `wallpaper.html`, `screensaver.html`, `tv.html`, `god.html`. Served by the host they stream from the host's world; opened elsewhere they run the sim in a worker. `?host=ws://127.0.0.1:47615/ws/v1` or `?sim=worker` force either.

## Layout

| Path | Owns |
|---|---|
| `src/core` | the contract: types, constants, deterministic maths, Philox RNG, hashes, SoA layout, codecs |
| `src/genome` | development, mutation, crossover, species, templates |
| `src/physics` | bodies, fluid, contacts, metabolism inputs |
| `src/brain` | substrate, I/O channels, brain tick, perception |
| `src/ecosystem` | habitat, fields, ledger, feeding, ageing, disease, god-power effects |
| `src/sim` | the tick pipeline, journal, births and deaths, worker, pacer, view links |
| `src/render` | WebGL2 renderer (WebGPU later) |
| `src/director` | camera director and idle drift |
| `src/audio` | generative ambience |
| `src/ui` | view shell, god window, designer |
| `src/host` | Node host: HTTP, WebSocket, persistence |
| `web/` | entry pages |
| `packaging/` | Lively, screensaver wrapper, Android TV notes |
| `tests/` | cross-module and end-to-end tests |

## Licence

Code: [Unlicense](LICENSE). Assets (designs, names, art, audio patches, texts): [CC0 1.0](ASSETS-LICENSE). All creature designs, names and art are original.
