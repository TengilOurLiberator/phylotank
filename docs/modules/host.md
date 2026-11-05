# Host module: design notes (phase 1)

`src/host` is the Node process that owns the one persistent world. It serves the views, streams the CONTRACT 12 protocol to every viewer, takes god commands into the journal, saves and recovers the world, and follows the throttle state. The CPU backend is the only sim backend; spike 2 ([host-2](../spikes/host-2.md)) says Dawn is viable but unmeasured on the target GPU.

## Files

| File | Role |
|---|---|
| `index.ts` | `startHost()`: HTTP (manifest, `/health`, `/pair/*`), WebSocket `/ws/v1`, clients, streaming pump, commands, timers |
| `world-host.ts` | `HostWorld`: the World, journalled `schedule`, `step` with hash records, `save`, `rewind`, recovery by replay |
| `snapshot.ts` | World to `.ptk` and back (core container), field-grid columns, EVTQ, verification |
| `store.ts` | World directory, atomic writes, retention, journal files with per-record CRC |
| `migrations.ts` | Chained schema migrations (empty chain at schema 1) |
| `interest.ts` | Interest rects, LOD classification, stable slot maps, BODY, DUST and GLOW frames |
| `security.ts` | Peer, Host and Origin checks, tokens, scopes, LAN pairing |
| `commands.ts` | God-command validation, rate limit, lead time, cast planning |
| `throttle.ts` | Throttle states with hysteresis, `OsProbe` interface, stub and shell-composed probes |
| `scheduler.ts` | Tick pacing by completion |
| `summary.ts` | 1 Hz tank summary: CENSUS and STATS |
| `frames.ts` | FIELDS and INSPECT encoders and decoders (core has none yet) |
| `detectors.ts` | Derived events (CONTRACT 11): giant, record, endangered, extinction, massDeath, hunt, migration, school, carcass, frenzy |
| `gpu.ts` | Optional Dawn loader and a device manager that applies spike 2's findings (not used by the sim) |
| `main.ts` | CLI: `serve` (default), `inspect`, `replay`, `gpu-probe`, `--headless` |
| `spikes/dawn-node.mjs` | Spike 2 bench (not built, not tested) |

## Decisions

1. **The host keeps its own session.** The phase-0 `SimSession` (sim) streams one whole-tank frame to everyone and creates its own world; the host needs per-client interest, a world loaded from disk and rewinds that swap the world. `SimSession` stays as the worker's session; the host reuses only `welcomeFor` and `envFrameFor`.
2. **Every snapshot starts a journal file.** File names carry the epoch, tick and journal sequence (`auto-e0000-t000000123456-j000007.ptk`, `j000007-e0000-t000000123456.jnl`). Recovery loads the newest snapshot that verifies (header CRC, every section's xxh64, then the state hash stored in META), queues its EVTQ, and replays every later journal file of the same epoch, checking each journalled hash. Replay stops at the first mismatch and lists the inputs it could not replay. After a replay the host writes a `recovery` snapshot so the next crash starts from a clean base. A different `simHash` (build) skips replay.
3. **Replay target.** A hash record at tick T describes the world when `g.tick == T`; an input at tick T is applied while stepping T, so replay runs to `max(hash ticks, input ticks + 1)`. At most 256 ticks (8.5 s at 1x) between the last hash and a crash are lost; inputs inside that window are still replayed because they are journalled when issued.
4. **The journal is flushed per record** (`fsync`), with records `u32 len, u32 crc32, CBOR`. A torn tail ends that file's records. Notes (speed leases, bookmarks, settings, rewinds) are journalled for audit and not replayed.
5. **A tick that throws** (phase-0 stubs such as `ecosystem.applyGodEvent`) is counted in `stepErrors` and retried; the consumed input is gone, which replay reproduces identically. Three failures in a row stop that batch.
6. **Sparse sections are stored raw** because readers refuse more than 50:1 (contract request H5).
7. **Interest and LOD.** Interest rect = viewport grown 25% per side, stretched along the camera velocity times the client's lead (at most 1 s). Projected size at least 4 px is a body, 0.5 to 4 px dust, smaller glow; over `caps.maxBodies` the lowest-ranked bodies drop to dust and over `caps.maxDust` dust drops to glow. Rank is `log2(px) + 2 * salience`; a selected creature (`select` command) gets salience 10 for that client. Slots are per client, stable, reused lowest-first; a freed dust slot is sent empty once before reuse. **A client that has not sent a VIEWPORT gets the whole tank as dust**, which is what the phase-0 renderer draws (the e2e smoke passes against this host).
8. **Rates** are wall-clock: body and dust 15 Hz, glow 2 Hz, ENV and CENSUS 1 Hz, FIELDS 0.5 Hz (shared encoding), STATS 1 Hz to god clients only, INSPECT 10 Hz for a client that has selected a creature; a stream is not resent while the tick has not moved. Notable events only (births, deaths and bites are dropped from EVENT), at most 20 per second per client.
9. **Slot compaction.** Stable slots never renumber, so a zoom-in would leave the dust frame as long as the old whole-tank one, mostly empty slots. When a client's slot range is more than twice its occupancy plus 64, the top entries move down: bodies by BODY_LEAVE and a fresh BODY_ENTER in the same batch, dust points by one empty frame and the lowest free slot in the next. Measured with a raw client: a screensaver zoomed onto a 12 x 6.75 m interest rect of a 3,000-mote Small tank fell from about 222 KB/s of dust to about 39 KB/s. GLOW_FIELD (37 KB at 2 Hz) and FIELDS (74 KB at 0.5 Hz) are sent uncompressed; the header's deflate flag would shrink both a lot once the renderer decodes it.
10. **Flow control.** More than 250 ms of queued bytes (or the client's `maxBytesPerSec`) halves the dust rate, then the body cap, then the body rate, at most every 250 ms; recovery is 10% per second in reverse order. LAN clients are capped at 1 MB/s (8 Mbps). Freeze detection (no ACK for 3 s) starts only after a client's first ACK, because phase-0 views send none; an ACK after a freeze resets that client's slots and keyframes everything.
11. **Security.** Bind `127.0.0.1` unless `--lan`. Off-loopback peers must be RFC 1918, link-local or ULA. Host header must be loopback (or a LAN address or `name.local` when LAN is on); Origin must be the host's own, `http://tauri.localhost`, or absent (non-browser). `/health` answers a `null` or `file:` origin with `{ok:true}` only. Loopback views get `view`; `god` needs the god token; LAN devices need a paired device token and get `view` only unless `--lan-god`. Device tokens are stored as SHA-256 hashes; `secrets.json` is written atomically with mode 0600. Pairing: 6-digit code, 2-minute expiry, 5 requests per minute per peer and 20 overall, token collected once by the requesting peer.
12. **Commands.** Validated field by field (contract shapes, bounds, lengths), 20 per second per client, epoch-checked. A cast fires after 3 s (major) or 1 s at the achieved speed (1x while paused, so the countdown starts on resume). Major casts write a `beforePower` snapshot first, so the undo point excludes the command. `rewind` saves `beforeRewind`, loads the snapshot in place, sets the epoch past every epoch seen, and sends every client a fresh WELCOME. `speed` is a lease: it lapses when its god window disconnects unless `unattended` with an `until`, and at its `until` tick or wall time; achieved speed is capped by the throttle state, except that an unattended lease (the overnight "run at max until ...", William's Q2) may exceed Background's 1x, still within the power budget and never in Yield, Evicted or Battery.
13. **Throttle.** Watching (god, TV or screensaver visible), Ambient (wallpaper only), Background (nothing visible, 1x by default), Yield (fullscreen, ComfyUI busy, a listed process, or another GPU user above 30% for 5 s; enter after 5 s, leave after 30 s clear), Evicted (Yield over 10 minutes or free VRAM under 3 GB), Battery (0.25x). A screensaver during Yield trickles at 0.1x and 2%. An optional power budget scales speed by `budget / (avg W - idle W)`. The OS probes are Windows-only and live in the shell: `ShellProbe` composes `FullscreenProbe`, `NvmlProbe` and `ComfyUiProbe`; on other platforms `StubProbe` reports idle, and `--shell` lets the shell push samples as `{"probe":{...}}` lines.
14. **A worker thread for hashes and saves.** The checkpoint hash every 256 ticks costs about 0.4 s on Small with the core xxh64 (contract request H9), and a snapshot about 0.9 s. `dist/host.mjs` re-runs itself as a worker thread (`workerData.ptkRole = 'worker'`); the main thread only copies the bytes (a few milliseconds). Hash results are tagged with a world generation so a late hash of a world replaced by a rewind is dropped; if the worker falls two checkpoints behind, a checkpoint is skipped. Autosaves, daily, manual, `beforePower` and eviction snapshots are finished and written atomically on the worker after the journal has already rotated, so a write that never lands only means recovery starts from the previous snapshot and replays one more journal file. Boot, recovery, `beforeRewind` and shutdown snapshots stay synchronous. Tests and in-process callers without the bundle run everything inline. A crash test against the built host (kill -9 after about 450 ticks, then `replay`) verified a worker-made hash and a journalled governor decision.
15. **Governor.** On ticks with `tick % 300 == 0`, from tick durations measured before that tick, the host may schedule a journalled `brainDiv` change (p95 over 15 ms gives 2, over 25 ms gives 3). Replay applies the journalled decision and never re-measures (CONTRACT 4.4).
16. **Detectors** run once per second of sim time on the host timer and on every batch of primitive events. They read the World and never write it (a test checks the state hash). Windows are in ticks: mass death is the deaths in the last 10 s against the mean and spread of earlier windows (z at least 3, at least 10 deaths); a hunt starts at the first bite of a pair and ends with the prey's death by that killer or after 10 s of quiet; a giant is at least 0.6 L_ceiling or above the 99.5th percentile of at least 200 adults, once per entity; records need a 5% improvement and are at most one per kind per sim minute; endangered fires below 5 after a peak of at least 10; migration is a mean-depth shift of 15% of the tank height over 60 s; a school is a species' largest group of at least 8 within 1.5 m with polarisation at least 0.7 (start, an update every 10 s, end); a carcass of at least 0.25 L_ceiling is reported once, and a frenzy when at least 5 live creatures are within max(0.2 m, 5 lengths) of it, at most every 30 s. Detector events use host ids above 2^50.
17. **GPU path.** `gpu-probe --webgpu <dir>` loads Dawn from a directory the user installed it in and prints the adapter; on lavapipe here it reports `llvmpipe` with `timestamp-query`. `GpuDeviceManager` re-requests the adapter on every acquire, recovers from losses other than its own `destroy()`, and gives up after 3 losses in 10 minutes (the host would fall back to the CPU backend).
18. **Persistence defaults.** `npm run host` keeps the world in `$XDG_DATA_HOME/phylotank/worlds/default` (`%LOCALAPPDATA%\Phylotank\worlds\default` on Windows); `--memory` keeps it in RAM. Autosave every 10 minutes of host time (2 to 60), the first after local midnight as `daily`; a shutdown snapshot on SIGINT or SIGTERM. Retention: 6 auto, 7 daily, 20 each of `beforePower` and `beforeRewind` within 7 days, manual forever, 10 GB total.

## Measured costs (this container, shared and loaded)

| Preset, motes | Snapshot size | Encode | Decode |
|---|---|---|---|
| Small, 4,096 | 4.4 MB | 0.87 s | 0.57 s |
| Default, 8,192 | 17.2 MB | 3.2 s | 2.0 s |
| Large, 8,192 | 67.8 MB | 8.6 s | 8.2 s |

Most of it is the pure-JS xxh64 (H9) and sparse field grids stored raw (H5). In the built host these run on the worker thread (decision 13); only boot, recovery, rewind and shutdown saves block the main thread.

### 10-minute soak (`src/host/spikes/soak.mjs`)

The built host, Small preset, 3,000 motes, autosave every 2 minutes, three viewers (whole-tank wallpaper, a zoomed screensaver, a god window with STATS), ACKs at 2 Hz. This run used the build before slot compaction, so the screensaver still received a whole-tank-sized dust frame.

| Measure | Value |
|---|---|
| Ticks in 600 s | 18,037 (30.0 per second; every 10 s sample between 28.8 and 31.3 after the first) |
| Throttle state | Watching throughout |
| Bytes per viewer | 313 to 341 KB/s each |
| Autosaves | 5, at ticks 3,626, 7,242, 10,857, 14,480 and 18,037 (shutdown), all on the worker thread; ticking never paused |
| Host RSS | 148.7 MB at 20 s, 229 MB at 600 s |

RSS did not climb steadily: it rose in steps at autosaves (the worker's buffers) and stayed flat between them (222.3 MB for 70 s, 231.1 MB for 110 s), ending slightly lower than its peak. Ten minutes cannot tell a leak from a heap growing to its plateau; the 24-hour soak is still to do.

## HTTP endpoints (contract request H7)

| Route | Who | Body / reply |
|---|---|---|
| `GET /health` | any allowed origin; `null` origin gets `{ok}` only | `{ok, tick, epoch, state, clients, achievedHz}` |
| `POST /pair/request` | LAN peer, LAN on | `{name}` gives `{pairId, code}` |
| `GET /pair/status?pairId=` | the requesting peer | `{state: pending, approved (with token, once), denied, unknown}` |
| `GET /pair/pending`, `GET /pair/devices` | loopback with `Authorization: Bearer <god token>` | lists |
| `POST /pair/approve`, `/pair/deny`, `/pair/revoke` | same | `{pairId, code}`, `{pairId}`, `{deviceId}` |

## Not done yet

- Releases and sim settings (contract request H2), the detectors that need missing systems (outbreak, epidemicFront, bloomFront, newRole, novelty, speciation), lite snapshots, the GENO, SPEC and LINE sections (no genome store or species registry exists yet), predictive deltas (protocol 1.1), NEAR_POSE, GENOME_REQ and GENOME.
- The Windows probes themselves, EcoQoS, mDNS, the GPU backend and its duty-cap controller.
- A 24-hour soak. The 3 MB/s wallpaper budget is measured only for the phase-0 skeleton: a wallpaper watching the whole Default tank with 8,192 motes received 526 KB/s (`tests/host-recovery.test.ts`, this container). Real creatures, bodies and events will change that.

## Notes for the integrator

- `tests/e2e/smoke.cjs` starts `dist/host.mjs --port 0`, which now keeps a persistent world in the user's data directory. Add `--memory` there (or set `XDG_DATA_HOME`) so CI and local runs do not leave worlds behind. The smoke test passes against this host either way.
- The god page must read `#token=` from its URL (printed by `npm run host`) and send it as `token` in HELLO; without it a god page gets the `view` scope only. A paired TV sends its device token the same way.
- Phase-0 views send neither VIEWPORT nor ACK. They get the whole tank as dust, and freeze detection stays off until a client's first ACK.
- While `ecosystem.applyGodEvent` is a throwing stub, every cast costs one retried tick (`stepErrors` in STATS). Replay reproduces it exactly.
- The host never writes World state outside the journal, except when it loads a snapshot (boot, recovery, rewind). Detectors and the summary only read.
- On this shared machine the full suite sometimes exceeds the default 30 s test timeout (`tests/sim.test.ts` took 32 to 34 s while other jobs ran); the host tests set 120 s.
