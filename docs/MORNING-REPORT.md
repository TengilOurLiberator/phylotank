# Morning report (2026-11-05)

The overnight build stopped at about 03:40 CET, when the account hit its weekly usage limit (resets 22:00 UTC). Everything is pushed: main, plus unmerged branches mod/gpu, mod/physics2, integrate/physics2, mod/docs, mod/events and mod/perf (the last two hold unreviewed WIP commits saved after their agents stopped).

## Done and on main
- Contract (docs/CONTRACT.md), design, review and per-module notes and spikes.
- Real modules merged and swapped into the sim: genome (develop, mutation, crossover, species, the 7 templates), physics (exact tree solve, drag, contacts, swimmer cards), brain (CTRNN, senses, gaits), ecosystem (habitat, fields, plankton and mats, exact ledger, pathogens, 22 god powers, nature mode), sim (tick pipeline, births, journal, pacer, detectors), host (server, streaming, .ptk persistence, crash recovery, LAN pairing), render (WebGL2 glow look), director plus audio, ui plus ui2 (god window, designer, onboarding, TV overlay, accessibility), packaging (Lively zip, Rust .scr, tray, CI), site (landing, demo, share page), evolab.

## Not working yet
- The live wallpaper shows water, light and dust but no creature bodies: the e2e smoke fails ("too few live motes", "no bright pixels"; bodyFrames 0, genomeTemplates 0). The real genome to render template hookup (render's setTemplateSource) was the integrator's next step. The creatures do render on web/render-test.html.
- Not merged: gpu (WebGPU backend, 15 lavapipe tests), physics2 (Strouhal fix, severing, 1.55x speed), docs, events, perf.
- Never run on Windows: the .scr, the tray, Lively itself, the 5090 GPU path.

## Next session
1. Wire genome.develop into render via setTemplateSource; get e2e green.
2. Merge physics2, gpu, perf, events, docs; rerun the full suite.
3. Run evolab on the real SimCore (balance: filter-feeder collapse, jet blobs).
4. On the PC: Lively test, `.scr` install, GPU bench (docs/spikes/gpu-1.md section 2).
