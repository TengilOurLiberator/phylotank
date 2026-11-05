# Frequently asked questions

Unfamiliar words are explained in the [glossary](GLOSSARY.md). For what works today, see the status table at the top of the [user guide](USER-GUIDE.md).

## About Phylotank

**What is Phylotank?**
An artificial-life fishtank: a glowing deep-sea tank whose creatures have bodies grown from DNA, brains that are evolved neural networks, and heritable everything. It runs as a wallpaper, a screensaver, on a TV and in a god window where you can design creatures and cast disasters.

**Is it a game?**
Not really. There is no score, no goal and no way to win. It is closer to an aquarium crossed with an experiment: you watch, you meddle, and evolution does the rest.

**Is anything scripted?**
No. Creatures swim because their fins push water, starve when they burn more than they eat, and split into new species when their genomes drift apart. The tank does not decide that a predator should win or a species should survive. Even the documentary camera only chooses what to film; it never changes what happens.

**Where does the name come from?**
From *phylogeny* (the tree of descent) and *tank*.

**Is it finished?**
No. It is at v0.1 "Glass tank", in progress. Its parts were built and tested separately and have only just been joined into one simulation, so the balance between species is still being tuned. The README and the user guide say exactly what works.

**Was it written with AI?**
Much of the initial code and documentation was written with an AI coding assistant; commits that it wrote carry a `Co-Authored-By` trailer that says so. Contributions from people are very welcome (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Running it

**Do I need a powerful graphics card?**
No. Today everything simulates on the CPU, and the renderer needs only WebGL2, which any recent browser and graphics chip has. A big GPU will matter later, when a GPU backend lets the Default and Large tanks hold far more creatures.

**Does it run on macOS or Linux?**
The browser tank and the Node host run anywhere Node.js 22 and a modern browser do; Phylotank is developed and tested on Linux. The Lively wallpaper, the `.scr` screensaver and the tray app are Windows only.

**Will it run on a laptop?**
That is a design goal: the Small tank on the CPU is limited to 4,096 creatures, and the wallpaper caps itself at 30 frames per second. It has not been measured on a slow laptop yet.

**Why does the page not work when I double-click `index.html`?**
The simulation runs in a Web Worker, and browsers do not start workers for files opened directly from disk. Serve the folder with any static web server (for example `npx http-server -p 8000` or `python -m http.server 8000`) and open the `http://` address. [INSTALL.md](INSTALL.md) has the steps.

**Will it slow down my games?**
It is designed not to. The host has throttle states: it backs off when a game goes full screen, when another program is busy on the GPU, or on battery, and Lively pauses the wallpaper during full-screen apps. The Windows probes that detect these are part of the tray app and have not been tried on real hardware yet.

**Does the tank keep living when my screen is off?**
With the host running, yes: the world runs all the time at its normal speed and every view joins it where it is. A browser tab on its own (the dream tank) runs only while the tab is open; it saves itself every 5 minutes and when you leave, and carries on from there next time.

**Does it fast-forward while I am away?**
Only if you ask. Speeds above 1x are leases that lapse when the god window closes. The one exception is the overnight lease ("run at max until ..."), which you start deliberately and which shows a banner while it runs. Phylotank never fast-forwards silently.

**Where are my worlds saved, and how do I back one up?**
In your user data folder: `%LOCALAPPDATA%\Phylotank\worlds\default` on Windows, `~/.local/share/phylotank/worlds/default` on Linux, `~/Library/Application Support/Phylotank/worlds/default` on macOS. A world is that folder of `.ptk` snapshots and journal files; copy the folder to back it up or move it. `node dist/host.mjs inspect` lists and verifies what is in it.

**What happens if the host crashes or the PC loses power?**
On the next start the host loads the newest snapshot that passes its checksums and replays the journal recorded since, checking the state hash as it goes. You lose at most the last 9 seconds or so (the time since the last journalled hash).

**The wallpaper is black, or the screensaver is not in the Windows list.**
See the troubleshooting table in [INSTALL.md](INSTALL.md#troubleshooting).

## The tank and its creatures

**Why do I only see glowing dots?**
Creatures too small to draw at the current zoom are drawn as specks, which is how the tank looks from far away by design: most creatures are a few millimetres to a few centimetres long in a tank 32 metres wide. When the camera is close enough to a creature, it resolves into a full glowing body, regrown in the view from its genome. In this early build the specks at the whole-tank zoom are fainter than they should be.

**Can the population explode, or everything die?**
It cannot explode: there is a fixed amount of matter in the tank, counted exactly, and every newborn is built from food its parent ate. As the tank fills, births get more expensive (a birth tax that hits tiny fast breeders hardest), and at the cap they wait. Everything dying is possible, and is meant to be: if it happens, the timeline and the ledger say why. The design adds safety valves (reseeding from a gene bank, a trickle of immigrants), which are logged and shown, never hidden.

**Why can my creatures not grow huge?**
Each world has a size ceiling that its food budget can carry, about 20 cm in the Default tank. Giants need a food web big enough to feed them. To have a real leviathan, release one deliberately ("Release as leviathan"): it may grow beyond the ceiling and brings extra nutrients into the tank so the food web can carry it.

**Do the creatures learn?**
Their brains are evolved, so most behaviour is inherited. A lineage can also evolve a gene for learning within a lifetime, which costs energy, and what one creature learns is never passed to its children.

**Can they see colour?**
Yes. Eyes have up to three colour bands, chosen by genes, plus a sense of nearness.

**Why is the water so thick?**
Phylotank's water is 20 times as viscous as sea water, so that one tank can hold both a 0.5 mm microbe, for which water is like syrup, and a giant that glides. With real sea water at this tank's scale the microbes' physics would need a far smaller time step.

**Why does every power wait a second or three before it happens?**
So that every view can get ready: the screensaver's camera reaches the meteor before it lands. Major powers wait 3 seconds with a countdown, and the world is snapshotted first so you can rewind; minor ones wait 1 second.

**Can I undo a disaster?**
Yes. Every major power takes a snapshot first, and rewind returns the world to any snapshot. Rewinding saves the present first, so it never deletes anything.

## Designs and sharing

**How do I share a creature?**
From the library: download a `.ptkg` file, copy its `PTK1.` string, copy a share link, or show a QR code. The share link carries the creature after the `#`, which browsers never send to a server. See the [user guide](USER-GUIDE.md#10-sharing-creatures).

**Is it safe to open a creature someone sent me?**
Imports are checked for size, damage and hostile text, and always open in the designer first, never straight into your world. A creature file holds only a genome and its name and notes; it cannot run code.

**Can I recreate creatures from other games or films?**
Please do not share them with the project. Phylotank's designs, names and art are all original and public domain, and contributions must be too. Your own private tank is your own business.

**Who owns the creatures I design?**
Designs shared with the project are dedicated to the public domain (CC0), like all of Phylotank's assets, so anyone may use them for anything.

## Privacy and safety

**Does Phylotank send any data anywhere?**
No. It makes no network calls of its own, has no analytics, trackers or accounts, and the host listens only on your own computer unless you turn on LAN mode for a TV and pair the TV with a code (LAN pairing is planned for v0.6).

**Is it safe for people with photosensitive epilepsy?**
It is designed to be: glow pulses are slow and clamped, saturated red pulses slower still, brightness changes are limited per second, and a runtime check dims the picture if anything flashes anyway, aiming at WCAG 2.3.1 (no more than three flashes in any second) in every view. An automated flash analyser runs in the tests. As with any moving image, stop if you feel unwell.

## Contributing

**How can I help?**
Report bugs, try it on hardware we have not (Lively, a Windows PC, a TV, a slow laptop), run long evolution experiments, translate, design creatures, or write code. Start with [CONTRIBUTING.md](../CONTRIBUTING.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

**Why are the rules about determinism so strict?**
Because the whole project leans on exact replay: crash recovery replays the journal to the identical state, rewind and golden tests depend on it, and a bug report with a seed can be reproduced exactly on anyone's machine. One stray `Math.random` or `Math.sin` in the simulation breaks that for everyone.

**Can I use Phylotank in my own project, or commercially?**
Yes. The code is public domain under the Unlicense and the assets under CC0: no permission, credit or fee needed (credit is appreciated).
