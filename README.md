# Phylotank

**An artificial-life fishtank for your desktop.** A dark, glowing, deep-sea tank, seen from the side, full of creatures whose bodies grow from DNA, whose brains are evolved neural networks, and whose every trait is heritable, including how they reproduce and how fast they mutate. Light grows plankton, grazers eat the plankton, predators eat the grazers, scavengers eat the dead, and the dead feed the plankton again. You design creatures, release them, and as god throw meteors, plagues and cold snaps at the tank to see how life copes. Nobody scripts what happens.

One persistent world, four ways to watch it:

- a calm **wallpaper** with no text and no controls (through [Lively Wallpaper](https://github.com/rocksdanister/lively) on Windows);
- a **screensaver** whose camera films the tank like a nature documentary;
- a **TV** view, cast to a Chromecast or Google TV, with ambient sound;
- a **god window** with the creature designer, god powers, an inspector with a live brain view, and stats.

Free and open source: code under the [Unlicense](LICENSE), creature designs, names, art and texts under [CC0](ASSETS-LICENSE). Every design is original.

## Status: v0.1 "Glass tank", in progress

Phylotank is being built in the open and is **not ready for everyday use yet**. Here is what works today and what does not.

**Works**

- The tank runs in a browser tab with nothing installed. It starts with about 350 creatures of five original species: Motefly microbes near the surface, Meadowlamp grazers on the shelf, Ashpicker scavengers on the floor, drifting Sievebell filter feeders and a few Hushmaw predators. Their bodies are grown from their genomes (segments, fins, mouths, eyes, light organs), they swim by real physics, their brains drive their muscles, and they feed, grow, breed with mutation, age and die in a habitat with currents, light, plankton and nutrient cycling. Every gram of matter is accounted for, the same seed always gives the same world, and the tank saves itself in the browser every 5 minutes and resumes when you come back.
- A Node host that keeps one persistent world on your PC, saves it every 10 minutes, recovers exactly after a crash by replaying its journal, and streams the world to every view over a local WebSocket.
- The god window, against a practice world that runs inside the page: speed controls with leases, the twelve core god powers with countdowns and hold-to-confirm, the inspector with a live brain view, population, species-tree, food-web, gene and gene-drift charts, timeline, bookmarks, rewind, renaming species, world knobs with presets, a welcome tour, gamepad control, a high-contrast theme, English and Swedish.
- The creature designer: gene sliders and a part editor over one genome, a growth strip, an energy budget estimate, validation that warns but never forbids.
- The TV view's overlay for a remote or a gamepad.
- Sharing creatures as `.ptkg` files, `PTK1.` strings, share links and QR codes, with a share page that makes no network requests.
- Packaging: a Lively Wallpaper package, a Windows `.scr` screensaver and a tray app that supervises the host, built and tested in CI.

**Just joined, so expect rough edges**

- The real genome, physics, brain and ecosystem modules were joined into one simulation on 5 November 2026. Balance (who survives, how fast things evolve) is still being tuned with long headless runs, the full simulation is much heavier than before and has not been measured on ordinary PCs, and at the whole-tank zoom the creatures are faint specks.

**Not done yet**

- The god window cannot yet change a world on a host (it watches only), and the screensaver's camera still drifts like the wallpaper's instead of following the director.
- A test tank in the designer that runs the real physics, LAN pairing for the TV, the GPU backend.
- Nothing has been tried yet on the target Windows PC, in Lively itself or on a real TV; those steps are marked unverified in [INSTALL.md](docs/INSTALL.md).

The [user guide](docs/USER-GUIDE.md) marks every feature as working, partly working or planned.

## Quick start

**Just look at it.** Download the web bundle from the [releases page](https://github.com/TengilOurLiberator/phylotank/releases), serve the folder with any static web server and open `index.html` (browsers will not start it from a double-clicked file). See [INSTALL.md](docs/INSTALL.md) for this, the Lively wallpaper, the screensaver and casting to a TV.

**From source** (Node.js 22 or later):

```sh
git clone https://github.com/TengilOurLiberator/phylotank.git
cd phylotank
npm ci
npm run dev        # the tank on http://127.0.0.1:8000/ (also wallpaper.html, screensaver.html, tv.html, god.html)
```

**The persistent world:**

```sh
npm run host       # builds, then serves every view on http://127.0.0.1:47615/
```

It prints the address of each view and a private link for the god window. **Tests:** `npm test` (or `PT_FAST=1 npm test` to skip the hour-long golden run); browser tests and everything else are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

| For | Read |
|---|---|
| Installing on Windows, Lively, the screensaver, a TV | [docs/INSTALL.md](docs/INSTALL.md) |
| What each view shows, god powers, templates, designing and sharing creatures, saving worlds | [docs/USER-GUIDE.md](docs/USER-GUIDE.md) |
| Questions | [docs/FAQ.md](docs/FAQ.md) |
| Words from biology, physics and the project | [docs/GLOSSARY.md](docs/GLOSSARY.md) |
| Contributing: set-up, tests, the rules | [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) |
| How the code fits together | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| The binding interface contract | [docs/CONTRACT.md](docs/CONTRACT.md) |
| The design and its reasons | [docs/DESIGN.md](docs/DESIGN.md), with detailed [sections](docs/sections/), the [review](docs/REVIEW.md), module notes in [docs/modules/](docs/modules/) and measurements in [docs/spikes/](docs/spikes/) |

## Repository layout

| Path | What |
|---|---|
| `src/core` | the contract in code: types, constants, deterministic maths, the Philox RNG, hashes, the world layout, codecs |
| `src/genome` | development from DNA, mutation, crossover, species, templates |
| `src/physics` | bodies, joints, muscles, water, contacts, bites and grabs |
| `src/brain` | brain layout from the grown body, wiring, senses, the brain tick |
| `src/ecosystem` | habitat, fields, plankton, the mass and energy ledger, feeding, ageing, disease, god-power effects |
| `src/sim` | the tick pipeline, births and deaths, the journal, view frames, the dream-tank worker, pacing |
| `src/render` | the WebGL2 renderer |
| `src/director`, `src/audio` | the camera director and idle drift; the generative ambience |
| `src/ui` | the view shell, the god window, the designer, the library and sharing |
| `src/host` | the Node host: HTTP and WebSocket, persistence, recovery, throttling, detectors, CLI |
| `web/`, `site/` | the entry pages; the public site with the demo and the share page |
| `packaging/` | Lively package, Windows screensaver and tray app, portable zip, Android TV notes |
| `tools/` | the headless evolution lab and integration scripts |
| `tests/` | cross-module, determinism, boundary, golden and browser tests |

## Licence

Code: [Unlicense](LICENSE). Assets (creature designs, names, art, audio patches, texts and documentation): [CC0 1.0](ASSETS-LICENSE). All creature designs, names and art are original to Phylotank; other artificial-life projects are cited in the design documents as prior art only.
