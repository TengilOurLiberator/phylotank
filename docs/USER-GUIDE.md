# Phylotank user guide

Phylotank is an artificial-life fishtank: a dark, glowing, deep-sea tank seen from the side, full of creatures whose bodies grow from DNA, whose brains are evolved neural networks and whose every trait is heritable. You watch it as a wallpaper, a screensaver or on the TV, and from the god window you design creatures, release them and throw disasters at the tank to see how life copes. Nobody scripts what happens.

This guide describes the experience Phylotank is built to give, and says plainly what works today. Phylotank is at **v0.1 "Glass tank", in progress**, so much of what follows is still being built. Every feature carries one of these marks:

- **Works now**: you can use it in the current build.
- **Partly**: some of it works; the note says what is missing.
- **Planned (vX.Y)**: designed but not built yet, with the milestone it belongs to.

Installing is covered in [INSTALL.md](INSTALL.md). Words you may not know are in the [glossary](GLOSSARY.md), and common questions in the [FAQ](FAQ.md).

---

## Contents

1. [Status at a glance](#1-status-at-a-glance)
2. [Getting started](#2-getting-started)
3. [What you will see in the tank](#3-what-you-will-see-in-the-tank)
4. [The views](#4-the-views)
5. [Life in the tank](#5-life-in-the-tank)
6. [God powers](#6-god-powers)
7. [Time and speed](#7-time-and-speed)
8. [The starter templates](#8-the-starter-templates)
9. [Designing a creature](#9-designing-a-creature)
10. [Sharing creatures](#10-sharing-creatures)
11. [Saving worlds, snapshots and rewind](#11-saving-worlds-snapshots-and-rewind)
12. [Comfort, safety and accessibility](#12-comfort-safety-and-accessibility)
13. [Privacy](#13-privacy)

---

## 1. Status at a glance

| Feature | Status |
|---|---|
| The tank in a browser tab (the "dream tank", no install) | **Works now**: about 350 creatures of five species in the Basin habitat, with grown bodies, physics, brains, feeding, breeding with mutation and an exact matter ledger; saved in the browser and resumed on your next visit. Joined on 5 November 2026, so balance is still being tuned |
| Grown bodies drawn up close (segments, fins, eyes, mouths, light organs, glow and trails) | **Works now** when you zoom in; at the whole-tank zoom creatures are faint specks |
| Wallpaper through Lively Wallpaper | **Partly**: the package is built and checked in a headless browser; Lively itself is untested on real hardware |
| Screensaver (`phylotank.scr`) with captions | **Partly**: built and tested in CI; the camera director is built and tested but the screensaver view still drifts like the wallpaper |
| TV by casting a Chrome tab | **Works now**, including the overlay for a remote or a gamepad; LAN pairing and the Android TV app are **planned (v0.6)** |
| One persistent world on your PC (the host) | **Works now**: runs all the time, autosaves, recovers from a crash, streams to every view |
| God window: speed, inspector, charts, timeline, bookmarks, rewind, renaming, knobs, tour | **Partly**: works against a built-in practice world in the page; against your host it can watch but not yet change the world |
| God powers | **Partly**: every power's effect is built into the simulation, and the twelve core powers can be cast in the god window's practice world, but the god window cannot yet cast them into the dream tank or your host |
| Creature designer (gene sliders, part editor, growth strip, energy budget) | **Partly**: works, with real grown bodies; the test tank is still a toy model |
| Sharing creatures (`.ptkg` files, `PTK1.` strings, links, QR codes, the share page) | **Works now** |
| Generative ambient sound | **Partly**: built and tested; heard by default only in the TV view |
| English and Swedish | **Works now** in the god window, including the designer's slider labels |
| The public demo site and share page | **Works now** once the project's GitHub Pages site is switched on |

---

## 2. Getting started

**In a browser, without installing anything.** Download the web bundle from the releases page (or build it, see [CONTRIBUTING.md](../CONTRIBUTING.md)), serve the folder with any static web server and open `index.html`. Browsers do not start the simulation from a file opened by double-click, because it runs in a Web Worker, which needs a web address. [INSTALL.md](INSTALL.md) has the exact steps. **Works now.**

**From source.** With Node.js 22 or later:

```sh
npm ci
npm run dev       # builds and serves the tank on http://127.0.0.1:8000/
```

Then open `http://127.0.0.1:8000/` (the tank), `wallpaper.html`, `screensaver.html`, `tv.html` or `god.html`. **Works now.**

**The persistent world on your PC.** Run the host and every view watches the same world:

```sh
npm run host      # builds, then serves on http://127.0.0.1:47615/
```

The host prints the address of each view and a private link for the god window. The world lives in your user data folder (`~/.local/share/phylotank/worlds/default` on Linux, `%LOCALAPPDATA%\Phylotank\worlds\default` on Windows) and resumes where it left off. On Windows the tray app starts and supervises the host for you; see [INSTALL.md, part 2](INSTALL.md#part-2-williams-full-set-up). **Works now.**

---

## 3. What you will see in the tank

The tank is a finite slice of ocean seen from the side, 16:9 like your screen. The default world is 32 m wide and 18 m deep in the browser, and 64 m by 36 m on a PC host later.

- **Water and light.** Sunlight falls from the surface and fades with depth: red goes first, then green, until the deep is lit only by the creatures themselves. Slow light shafts move through the upper water. Day and night follow the sim clock (a sim day is 20 minutes, a sim year 20 days), and seasons move the light and temperature. **Works now**: the depth light, the light shafts and the day clock.
- **The habitat.** The default "Basin" has a sunlit shelf with reefs, a slope riddled with caves, a dark abyssal plain and a trench with hydrothermal vents. **Works now** in the simulation; the views do not draw the rocks and caves yet, because the stream does not carry the terrain.
- **Plankton and marine snow.** Plankton is a living field that grows where light and nutrients meet and blooms in spring; dead matter falls as slow marine snow. **Partly**: drifting marine snow is drawn, and plankton feeds the creatures today, but plankton itself is not yet drawn.
- **Creatures.** From far away a creature is a glowing speck whose colour is its body's own glow. Zoom in and specks resolve into soft, translucent bodies with fins, eyes, mouths and light organs, trailing light as they swim; there is no sudden pop between the two. Every living creature glows at least a little (the free "baseline glow"), so the tank never goes dark, but bright displays cost energy and evolve. **Works now**, with one caveat for this early build: at the whole-tank zoom the creatures are still faint.
- **Scale.** The zoom spans about three orders of magnitude, from 0.5 mm microbes to giants of about 20 cm in the default world, and larger leviathans you release yourself. **Planned (v0.4)** for evolved giants.

---

## 4. The views

There is one world and four ways to look at it. God events show up in every view; the wallpaper shows a gentler version.

### 4.1 Wallpaper

Pure ambience, with no text and no controls at all. A slow "idle drift" camera wanders towards lively places. Silent by default, at most 30 frames per second, and it stops drawing while the page is hidden. On Windows it runs through [Lively Wallpaper](https://github.com/rocksdanister/lively), which also pauses it when a game goes full screen.

- Open: add the Lively package to Lively, or open `wallpaper.html`.
- Source: your host's world if the host is running, otherwise the built-in dream tank after about 2 seconds, switching back to the host as soon as it answers.
- God events: shown in-world only, with slow fades and capped brightness; day and night are softened to 40% of their range.
- Status: **Works now** in a browser; **partly** as a Lively wallpaper (packaged and checked headlessly, untested in Lively itself).

### 4.2 Screensaver

The camera works on its own like a nature documentary crew. It watches for interesting moments (hunts, births of giants, new species, mass deaths, swarms, disease outbreaks, your god powers), scores them as stories, and films the best: an establishing shot, a tracking shot, a slow push-in, a scale reveal, the aftermath. It moves with smooth springs and slow dips to dark rather than hard cuts, and shows an occasional documentary caption (held 5 seconds, at least 45 seconds apart). Any key, click or real mouse movement ends it.

- Open: install `phylotank.scr` (see [INSTALL.md](INSTALL.md)), or open `screensaver.html`.
- Sound: off by default.
- Status: **Partly**. The `.scr` wrapper is built in CI. Captions work. The director is built and passes its property tests, but the screensaver view does not use it yet, so the camera drifts like the wallpaper's.

### 4.3 TV

The documentary camera tuned for the sofa: larger captions (held 6 seconds, at least 25 seconds apart) and sound on.

- Open: cast a Chrome tab showing `tv.html` to a Chromecast or Google TV (steps in [INSTALL.md](INSTALL.md#4-tv-cast-a-chrome-tab-to-google-tv)). Expect some banding in dark gradients, because casting compresses the picture as video.
- **Overlay**: press any button on the remote or a gamepad to bring up a card that controls only this TV's camera and sound: Director, Follow (the creature nearest the centre), Next event, Zoom in and out, Captions on or off, Sound 0 to 10. Arrows or the D-pad move between controls, Back (Escape or Backspace on a keyboard) closes it, and it hides itself after 8 seconds. On a gamepad the left stick pans and the right stick or triggers zoom.
- Status: **Works now** as a cast tab with the overlay (the overlay acts on the PC tab you cast). **Planned (v0.6)**: a codec-friendly cast mode, LAN pairing so the TV can render the stream itself, and an optional Android TV app.

### 4.4 God window

The only view with controls, and the only one that may change the world.

- **Top bar**: the sim clock, the speed buttons and the speed actually achieved, and whether you are connected to a host or to the practice world.
- **Map**: drag to pan, scroll to zoom, a minimap of the whole tank.
- **Powers**: the god powers palette (section 6).
- **Inspector**: click a creature (or press C for the one nearest the centre) to see its species, age, energy, diet and a live view of its brain: inputs on the left, outputs on the right, hidden neurons between, brightness showing activity. Click a neuron to trace it for 20 seconds. F follows the selected creature.
- **Stats**: population by species over time (linear or log), the species tree, the food web (who eats whom, laid out by trophic level), a chosen gene's distribution now or as a drift heat map over time, and diversity indices. Each chart has a table view.
- **Renaming**: give a species your own name from the inspector, the stats table or the map. Your names win over generated ones and pass to daughter species of the same genus.
- **Knobs**: world settings (day and year length, light, temperatures, currents, plankton growth, recycling, metabolic cost, mutation rate, population cap, disease, disasters, autosave, view brightness and glow) with the presets Gentle, Harsh and Fast evolution. A knob the host does not support yet says so instead of pretending.
- **Timeline**: births of new species, extinctions, giants, hunts, mass deaths and your own powers. N and Shift+N jump to the next and previous event.
- **Bookmarks and rewind**: save a place and zoom to return to it; rewind the world to a snapshot (section 11).
- **Designer** and **Library**: sections 9 and 10.
- **Settings**: language (English, Swedish), a high-contrast theme, UI scale from 75% to 200%, a colour-blind-safe chart palette, and "Show the welcome and tour again".
- **Welcome tour**: a short, skippable tour (inspect a creature, cast an algae bloom, open the designer) shown the first time the tank fills up. The "?" button in the top bar shows it again.

Gamepad: A clicks, B cancels, X opens powers, Y the inspector, LB and RB switch panels, the sticks pan and zoom.

Keyboard: Space pauses or resumes; 1, 2, 3 and 4 set 1x, 4x, 16x and max speed, 5 pauses; arrow keys pan; + and - zoom; M, P, D, L, S and T (or B) open the map, powers, designer, library, stats and bookmarks panels; I toggles the inspector; Esc cancels; Ctrl+, opens settings. Every action works without a pointer.

Status: **Partly**. Opened on its own (`god.html` from a static server or the dev server), the god window runs a built-in practice world inside the page and labels it "mock sim"; everything above works against it, but the practice world is a simple toy, not the real simulation. Opened from the host, it shows the real world and can watch, but it does not yet send the private god token, so the host refuses its commands. **Planned (v0.5)**: zooming into the species tree, a pop-out for panels, the god window's remote for a cast TV tab.

### 4.5 Designer

Where you build a creature: section 9. It lives inside the god window (press D).

---

## 5. Life in the tank

What follows is how the simulation works. All of it is built, and it has run as one simulation since 5 November 2026, so this is the part where Phylotank is youngest: the balance between species is still being tuned, and long evolution (giants, many species, arms races) is what milestone **v0.4 "Deep evolution"** is about.

- **The food web.** Light grows plankton, plant creatures and mats on the rocks; vents feed mats by chemistry in the dark. Grazers crop them, predators hunt grazers, parasites drain hosts, scavengers eat carcasses and marine snow, and everything that dies becomes dissolved nutrient that feeds the plankton again. There is a fixed amount of matter in the tank, so populations are limited by food, light and each other, not by a script.
- **Bodies that make sense.** A body is grown from a recipe in its DNA: segments, fins, limbs, mouths, eyes, smell organs, spikes, light organs, cilia, jets, gas bladders and glands. Swimming comes from physics: a fin only pushes if it is shaped and placed to push water, drag grows with size and bluntness, and a microbe in syrupy water needs a whip or cilia while a giant can glide. Badly built bodies swim badly, so selection keeps the plausible ones.
- **Brains.** Every organ brings its own neurons: an eye brings light receptors, a joint a muscle and a sense of its angle, a segment a small ganglion and a rhythm generator for swimming. Built-in reflexes (swim, startle, graze, bite what tastes like food, avoid walls, flee, breed) let a newborn survive, and evolution tunes the wiring, the reflex strengths and twelve personality genes such as boldness, sociality and appetite.
- **Reproduction.** Genes decide. A lineage may bud (copy itself with mutations), mate (mix two parents' genes), or anything between, and that choice is itself a gene, as is the mutation rate.
- **Species.** When genomes drift far enough apart, a new species is recognised automatically, given a generated scientific name (such as *Pratilux tondens*) and an English and Swedish common name, and added to the species tree.
- **Disease.** Pathogens with lock-and-key antigens coevolve with their hosts' immune keys, so outbreaks come and go.
- **Ageing.** Every creature ages and dies; living longer costs energy for repair, so no gene setting is free or immortal.
- **Nature mode.** While you are away, the tank throws its own mild weather (small cold snaps, heatwaves, current shifts, storms and blooms, about one every 10 sim days), never meteors or plagues.

Things worth watching for: a predator's hunt and its prey's escape, a school turning together, a spring bloom and the grazer boom after it, a carcass drawing scavengers, a new species splitting off, a parasite wave, and the slow drift of a lineage's body shape over many generations.

---

## 6. God powers

Powers are cast from the god window's Powers panel (P). Pick a power, aim it (a point, a circle, a depth band, a stroke, a species or one creature, depending on the power), set its intensity and duration, and see a preview of what is in range. Then confirm:

- **Minor powers**: one click. They fire 1 second later.
- **Major powers**: hold the button for 1.2 seconds (or press "Confirm without holding", or hold Enter). They fire 3 seconds later, with a countdown, and the world is snapshotted first, so you can always rewind to just before. A power is major if it can change the world for good: meteor, plague, cull, ice age, predator flood, rift barrier and earthquake always; cold snap and heatwave above half intensity; long night above 0.7; toxin leak above 0.3; nutrient flood above half; and releasing a leviathan.

The lead time gives every view time to get ready: the screensaver's camera arrives before the meteor does. While the world is paused, the countdown waits.

| Power | What it does | Major | Status |
|---|---|---|---|
| Algae bloom | Producers grow up to ten times faster in an area for a few days; often followed by shading, a crash and an oxygen dead zone | no | **Partly** |
| Hydrothermal vent | A new hot spring on the floor: heat, minerals and chemosynthetic food, fading over sim weeks | no | **Partly** |
| Cold snap | The surface cools by 2 to 15 °C, sinking through the layers; may trigger turnover | above 0.5 | **Partly** |
| Heatwave | The surface warms by 2 to 15 °C, strengthening the layers and starving the surface of nutrients | above 0.5 | **Partly** |
| Plague | A fresh pathogen strain fitted to a species, which then evolves on its own | always | **Partly** |
| Meteor | An impact: shockwave, kill radius, crater, a dust cloud that dims the light, nutrients stirred up, a cold "impact winter" for big ones | always | **Partly** |
| Current shift | Changes the currents, moving plankton, larvae and spores to new places | no | **Partly** |
| Long night | Light falls to as little as nothing for up to two weeks | above 0.7 | **Partly** |
| Mutagen burst | Mutation rates rise up to twenty times in an area for a few days: a burst of novelty and many misfits | no | **Partly** |
| Cull | Removes a fraction of a species, leaving carcasses for the scavengers | always | **Partly** |
| Bless | Tops up the energy of a species or one creature | no | **Partly** |
| Nutrient flood | A pulse of dissolved nutrient: bloom, crash, dead zone, then a detritivore boom | above 0.5 | **Partly** |
| Release | Puts creatures from your library into the world (section 9) | as leviathan | **Partly** |
| Marine snow | A rain of food falling through a depth band | no | **Planned (v1.0)** in the god window; effect built |
| Toxin leak | Makes an area toxic for a while | above 0.3 | **Planned (v1.0)** in the god window; effect built |
| Ice age | A long cold: the sea level falls, ice covers the surface, the shelf shrinks, then recovers | always | **Planned (v1.0)** in the god window; effect built |
| Predator flood | Releases a wave of predators | always | **Planned (v1.0)** in the god window; effect built |
| Storm | Strong surface currents and mixing on the shelf | no | **Planned (v1.0)** in the god window; effect built |
| Whale fall | Drops a large carcass that feeds the deep for days | no | **Planned (v1.0)** in the god window; effect built |
| Rift barrier | Raises a rock wall that splits the tank, so populations can become separate species; lower it later to watch them meet | always | **Planned (v1.0)** in the god window; effect built |
| Dead zone | Strips the oxygen from an area | no | **Planned (v1.0)** in the god window; effect built |
| Earthquake | Opens or collapses caves and sends a sediment slide down the slope | always | **Planned (v1.0)** in the god window; effect built |
| Seasons | Pause the seasons, jump to one, or change the length of the year | no | **Planned (v1.0)** |

"Partly" for the core twelve means: their real effects are part of the simulation and tested, and you can cast them in the god window's practice world (a simpler toy world), but the god window cannot yet cast them into the dream tank or your host. For the rest, the effect is built but the god window has no button for it yet. Every power is reproducible: its seed is journalled, so replaying the world gives the same outcome.

---

## 7. Time and speed

The sim runs at a fixed 30 steps per sim second on every machine, so worlds behave the same on a laptop and on a big PC; a slower machine simply runs fewer steps per real second.

- **Speeds**: pause, 0.25x, 1x, 4x, 16x and max. The god window shows the speed you asked for and the speed the machine actually achieves.
- **Speed leases**: anything above 1x is a lease that lapses when you close the god window, so the wallpaper always returns to calm on its own. Phylotank never fast-forwards silently: a caption says when time runs faster.
- **Overnight lease**: "Run at max until ..." asks the world to evolve flat out until a time you choose, even with the god window closed. It shows a banner and a Stop button while it runs.
- **Your PC comes first**: the host backs off when a game goes full screen, another program uses the GPU or the laptop runs on battery. The probes that notice these are Windows only, in the tray app, and untested on real hardware so far.

Status: **Works now** in the dream tank and the host; the god window's buttons drive the practice world (and will drive the host once the god token is wired).

---

## 8. The starter templates

Eight original starter designs, each with a matching set of instincts. They are read-only in the library; fork one to make it yours. All names and designs are original to Phylotank.

| Template | Scientific name | Swedish name | Niche | In brief |
|---|---|---|---|---|
| **Meadowlamp** | *Pratilux tondens* | Ängslykta | grazer | A 1 cm, five-segment grazer of the sunlit shelf with a broad rasping mouth, paired fins, wide-set eyes and a faint edge glow. Slow, so it relies on schooling and its eyes. |
| **Hushmaw** | *Tacitostoma insidians* | Tystgap | ambush predator | A 5 cm twilight hunter with a huge jaw, a stalked glowing lure, tiny fins and a strong fluke for short bursts. Patient; starves when prey is scarce. |
| **Sievebell** | *Cribrocampana lenta* | Silklocka | filter feeder | A translucent, radially symmetric bell with six comb mouths, a ring of light organs and a pulsing jet. Drifts with the currents; nearly defenceless. |
| **Tetherling** | *Haerentula furtiva* | Tjuderling | parasite | A 2 mm latcher with a proboscis, hooked spikes and long smell antennae. Bold, quick to mutate, and lost without a host. |
| **Ashpicker** | *Cineralegus sedulus* | Askplockare | scavenger | A 2 cm, seven-segment cold-water scavenger with a suction mouth, a long flexible tail and keen senses for movement and smell. Starves when nothing dies. |
| **Deepcrown** | *Bathycorona patiens* | Djupkrona | leviathan seed | A 25 cm deep giant with a crown of spikes, great pectoral fins, a fluke, jaws plus a filter comb and a slow deep glow. Released as a leviathan: very slow to mature and breed. |
| **Motefly** | *Flagellux minima* | Stoftfluga | whip microbe | A 0.8 mm cell with a beating whip, an eyespot and a filter mouth, at the bottom of the zoom where water feels like syrup. A pure budder. |
| **Blank** | *Nudisoma simplex* | Tom | none | One segment and default genes: a clean start for your own design. |

Status: **Works now**. Five of them (Motefly, Meadowlamp, Ashpicker, Sievebell and Hushmaw) found the dream tank; Tetherling, Deepcrown and Blank are in the library to release.

---

## 9. Designing a creature

The designer edits one genome through two views, so they can never disagree. **Partly**: everything below works except where marked.

- **Gene sliders**: every heritable gene, grouped (Size, Life, Reproduction, Diet, Habitat, Look, Behaviour and so on), generated from the genome schema so nothing is hidden. Brain genes are labelled "starting instinct, may evolve". Diet also has a triangle picker between plants, meat and detritus.
- **Part editor**: click a part to select the growth rule that made it; all its copies light up ("this fin comes from one rule and appears 6 times"). Add parts from the palette, change a part's shape, muscle, armour or glow, change how it attaches (position, angle, repeats, symmetry), duplicate or delete it, or "break out" one copy to edit it alone.
- **Growth strip**: scrub from newborn to adult, or play it.
- **Energy budget**: an estimate of what the design burns and needs (break-even food density, time to starve), with "trade-off chips" showing the three changes that would help most. Always labelled an estimate.
- **Warn, never forbid**: problems are listed and highlight the responsible slider or part, but the Release button is never disabled; with a serious problem it reads "Release anyway". Evolution decides.
- **Undo and redo**: Ctrl+Z and Ctrl+Shift+Z.
- **Test tank**: **partly**. Today it animates the grown body and reports speeds from the budget model, labelled "toy model". A test tank running the real physics and brain in the page is **planned (v0.5)**.
- **Body preview**: the real growth function, the same one the simulation uses, so what you see is what will swim.
- **Release**: choose where and how many, and whether the founders get a short protection. "Release as leviathan" lets the design grow beyond the world's size ceiling and brings extra nutrients into the tank so the food web can carry it; it is a major action (hold to confirm, snapshot first). **Partly**: works in the practice world.

---

## 10. Sharing creatures

A creature is its genome, a few kilobytes. You can share it in four ways. **Works now.**

- **A `.ptkg` file**: download it from the library and attach it anywhere. A `.ptkg` can also hold a pack of up to 64 designs.
- **A `PTK1.` string**: the same bytes as text, to paste into a message or a forum post.
- **A share link**: `share#ptk=PTK1....` on the project site. The creature is in the part of the link after `#`, which browsers never send to a server, and the share page makes no network requests at all, so nobody learns what you looked at. It shows the creature's name, notes and a still preview, with buttons to download it or copy the string.
- **A QR code**: shown in the library for designs short enough to fit.

Each design has a **fingerprint** such as `3fa9-12c0-88e1-04bd`; two designs with the same fingerprint are the same creature. Imports are checked for size, damage and hostile text, and always open in the designer first, never straight into your world. Shared designs are dedicated to the public domain (CC0).

Your library lives in the browser's local storage for now; a library folder on the host is **planned (v0.5)**.

---

## 11. Saving worlds, snapshots and rewind

**With the host** (**works now**): the world saves itself every 10 minutes (keeping the last 6), once a day (keeping 7), before every major power, before every rewind, when the host shuts down and whenever you ask. Every input is journalled, so after a crash the host loads the last snapshot and replays the journal to the exact same state, losing at most the last 9 seconds or so. Snapshots are `.ptk` files in the world folder.

```sh
node dist/host.mjs inspect   # list the snapshots and journals and verify their checksums
node dist/host.mjs replay    # load the newest snapshot, replay the journal and verify, writing nothing
```

**Rewind** goes back to a snapshot in place: the present is saved first as "before rewind", and the world's epoch goes up by one, so nothing is ever lost. "Open as a separate world" for what-if experiments is **planned (v0.5)**. In the god window, rewind and bookmarks **work now** against the practice world.

**In the browser** (the dream tank, **works now**): the tank saves itself to the browser's storage every 5 minutes and when you leave the page, and resumes from there on your next visit. Clearing the site's data starts a fresh tank.

---

## 12. Comfort, safety and accessibility

- **Photosensitive safety** (**works now**): Phylotank is slow by design. Every glow pulse is clamped (at most once a second on the wallpaper, twice elsewhere, and slower still for saturated red), brightness changes are slew-limited, the whole-screen brightness can change only 10% per second on the wallpaper, and a runtime check dims the picture if anything flashes anyway. Every view aims to meet WCAG 2.3.1 (no more than three flashes in any second).
- **Calm**: the wallpaper has no text and no sudden movement; disasters are shown with slow fades.
- **Keyboard, gamepad, remote**: every god window action has a key (section 4.4) and the whole tour and Release flow work keyboard only; the god window and the TV overlay also work with a gamepad, and the TV overlay with a remote.
- **Seeing the screen**: a high-contrast theme, UI scale up to 200% and a colour-blind-safe chart palette, in Settings. The god window is checked with the axe-core accessibility tester in both themes.
- **Languages**: English and Swedish (**works now** in the god window, slider labels included). The language follows your browser; `?lang=sv` or `?lang=en` in the address overrides it.
- **Screen readers**: the share page and site are structured for them, and the god window's "Describe view" reads out where you are and what is in view (for example "Viewing the twilight zone, 340 creatures, mostly ...").

---

## 13. Privacy

Phylotank makes no network calls of its own. The browser demo runs entirely in the page. The host listens only on your own computer (127.0.0.1) unless you switch on LAN mode for a TV (**planned, v0.6**), and then only to devices you pair with a code. There are no trackers, analytics or accounts. Your worlds stay in your user folder.
