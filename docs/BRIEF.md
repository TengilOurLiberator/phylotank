# Phylotank: interview record and shared brief (2026-11-04)

Phylotank is an artificial-life "fishtank". William designs creatures. Their DNA mutates when they reproduce, several species share one habitat, and he watches the ecosystem evolve. It runs as his Windows desktop background, as a screensaver, on his TV, and in a god-mode window. The user is William: CS/ML MSc, data engineer, RTX 5090 PC, Windows; he loves science, evolution, Godzilla, Digimon, D&D.

## Decisions from the interview (all William's)
- **Audience:** public and open source (Unlicense or CC0, like his other projects). All creature designs, names and art are original; no copying of existing games (Spore, The Bibites, etc.), only the genre.
- **Tech:** web, meaning HTML plus WebGL or WebGPU, one codebase.
  - Wallpaper runs through Lively Wallpaper (free, open source, supports HTML wallpapers).
  - Screensaver is a small Windows `.scr` wrapper that opens the same web view.
  - TV is Google TV / Chromecast: cast the Chrome tab, or open the local web address on the TV.
- **Look:** glowing deep-sea 2D. Dark water, bioluminescent soft-bodied creatures that glow, trail light and pulse. It must be calm and gentle as a wallpaper.
- **Creature design:** both gene sliders and a part editor, editing the same genome.
- **Brains:** evolving neural networks encoded in the DNA. Inputs are senses; outputs are movement and actions. Behaviour, responses to stimuli and habits are all heritable and evolve.
- **Reproduction:** "genes decide". Asexual budding and sexual mating both exist, and which one a lineage uses is itself a gene. Sexual mating does crossover. The mutation rate is a gene. Species split automatically when genomes drift apart.
- **Ecosystem:**
  - Food chain: light-grown plankton and plants, herbivores, predators, scavengers, parasites, and nutrient cycling (corpses feed plankton).
  - Environment zones: light falls off with depth, warm and cold zones, currents, day and night, seasons.
  - Diseases and parasites that coevolve with their hosts.
  - Disasters and events, which William triggers himself as "god" to watch the ecosystem react (vents, algae blooms, plagues, cold snaps, meteors and more).
- **Scale:** zoom from microbes to leviathans (about 3 orders of magnitude, seamless zoom). Creatures must be able to evolve up to really big sizes.
- **Bodies:** a body must make sense for what it evolved to do (hunting, grazing, parasitism). Body structure is part of the DNA and changes naturally over time, like the brain and habits.
- **Physics:** grown bodies with real physics. The DNA is a growth recipe (segments, branching limbs and fins, mouth type, eyes, spikes, gut). Swimming comes from physics: fin area and stroke give thrust, drag scales with size and shape. A badly built body swims badly, so selection produces plausible forms.
- **Population:** as many as possible, using the 5090. Still gentle as a wallpaper: Lively pauses wallpapers when a fullscreen app runs.
- **One persistent world:**
  - A local simulation host runs on the PC.
  - Wallpaper, screensaver, TV and god window are all views into the same world.
  - God-mode events show everywhere.
  - The world saves to disk and resumes after a reboot.
- **Wallpaper:** pure ambience, no UI at all. Designing, stats and god powers live in the separate god-mode window.
- **Screensaver camera director:** the camera moves on its own, looking around and zooming through the finite habitat. It looks for interesting events (hunts, births, a new species emerging, mass deaths, giants, swarms, disasters) and frames them cinematically.
- **Audio:** generative ambience that reacts to the tank, denser when life booms and darker after disasters. Off by default as wallpaper, on for TV.
- **Name:** Phylotank. Repo: github.com/TengilOurLiberator/phylotank, which William creates; until then the design lives in claude-personal/designs/phylotank/.
- **Now:** design doc first. Building starts after William approves it.

## Default architecture assumption (so sections stay consistent; the architecture section may overturn it with reasons)
- **Sim core:** TypeScript, data-oriented (structure-of-arrays typed buffers), stepping on WebGPU compute shaders where available, with a CPU or worker fallback.
- **Sim host:** a local process on the PC (Node or Deno with a WebGPU binding, or a headless browser) that owns the world state, runs continuously, saves snapshots, and streams compact state to viewers over WebSocket on localhost or the LAN.
- **Views:** browser pages (wallpaper, screensaver, TV, god window). Each renders the streamed state with WebGL2 or WebGPU and applies its own level of detail for its zoom.
- **Determinism:** seeded randomness and a fixed-timestep sim, so runs can be replayed for debugging.

## Section writers: rules
- Write concrete, buildable design, not marketing: data structures, algorithms, equations, parameter ranges, complexity and performance budgets (with numbers for an RTX 5090 and for a weak laptop), failure modes, and how to test each part.
- Cite prior art where it helps, with URLs: Karl Sims 1994, Polyworld, Framsticks, NEAT and HyperNEAT, CPPNs, gene regulatory networks, Lenia, ALIEN, Avida, Tierra, The Bibites (as prior art only). Web search is scarce in this session: use at most 15 searches and mark anything unverified.
- Flag open questions for William at the end of your section, at most 5.
- Write only your own file in /home/user/claude-personal/designs/phylotank/sections/. Do not run git. British English, no em-dashes.
