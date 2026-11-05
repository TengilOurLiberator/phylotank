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
| `main.ts` | CLI: `serve` (default), `inspect`, `replay`, `--headless` |
| `spikes/dawn-node.mjs` | Spike 2 bench (not built, not tested) |

## Decisions

1. **The host keeps its own session.** The phase-0 `SimSession` (sim) streams one whole-tank frame to everyone and creates its own world; the host needs per-client interest, a world loaded from disk and rewinds that swap the world. `SimSession` stays as the worker's session; the host reuses only `welcomeFor` and `envFrameFor`.
2. **Every snapshot starts a journal file.** File names carry the epoch, tick and journal sequence (`auto-e0000-t000000123456-j000007.ptk`, `j000007-e0000-t000000123456.jnl`). Recovery loads the newest snapshot that verifies (header CRC, every section's xxh64, then the state hash stored in META), queues its EVTQ, and replays every later journal file of the same epoch, checking each journalled hash. Replay stops at the first mismatch and lists the inputs it could not replay. After a replay the host writes a `recovery` snapshot so the next crash starts from a clean base. A different `simHash` (build) skips replay.
3. **Replay target.** A hash record at tick T describes the world when `g.tick == T`; an input at tick T is applied while stepping T, so replay runs to `max(hash ticks, input ticks + 1)`. At most 256 ticks (8.5 s at 1x) between the last hash and a crash are lost; inputs inside that window are still replayed because they are journalled when issued.
4. **The journal is flushed per record** (`fsync`), with records `u32 len, u32 crc32, CBOR`. A torn tail ends that file's records. Notes (speed leases, bookmarks, settings, rewinds) are journalled for audit and not replayed.
5. **A tick that throws** (phase-0 stubs such as `ecosystem.applyGodEvent`) is counted in `stepErrors` and retried; the consumed input is gone, which replay reproduces identically. Three failures in a row stop that batch.
6. **Sparse sections are stored raw** because readers refuse more than 50:1 (contract request H5).
7. **Interest and LOD.** Interest rect = viewport grown 25% per side, stretched along the camera velocity times the client's lead (at most 1 s). Projected size at least 4 px is a body, 0.5 to 4 px dust, smaller glow; over `caps.maxBodies` the lowest-ranked bodies drop to dust and over `caps.maxDust` dust drops to glow. Rank is `log2(px) + 2 * salience`; a selected creature (`select` command) gets salience 10 for that client. Slots are per client, stable, reused lowest-first; a freed dust slot is sent empty once before reuse. **A client that has not sent a VIEWPORT gets the whole tank as dust**, which is what the phase-0 renderer draws (the e2e smoke passes against this host).
8. **Rates** are wall-clock: body and dust 15 Hz, glow 2 Hz, ENV and CENSUS 1 Hz, STATS 1 Hz to god clients only; a stream is not resent while the tick has not moved. Notable events only (births, deaths and bites are dropped from EVENT), at most 20 per second per client.
9. **Flow control.** More than 250 ms of queued bytes (or the client's `maxBytesPerSec`) halves the dust rate, then the body cap, then the body rate, at most every 250 ms; recovery is 10% per second in reverse order. LAN clients are capped at 1 MB/s (8 Mbps). Freeze detection (no ACK for 3 s) starts only after a client's first ACK, because phase-0 views send none; an ACK after a freeze resets that client's slots and keyframes everything.
10. **Security.** Bind `127.0.0.1` unless `--lan`. Off-loopback peers must be RFC 1918, link-local or ULA. Host header must be loopback (or a LAN address or `name.local` when LAN is on); Origin must be the host's own, `http://tauri.localhost`, or absent (non-browser). `/health` answers a `null` or `file:` origin with `{ok:true}` only. Loopback views get `view`; `god` needs the god token; LAN devices need a paired device token and get `view` only unless `--lan-god`. Device tokens are stored as SHA-256 hashes; `secrets.json` is written atomically with mode 0600. Pairing: 6-digit code, 2-minute expiry, 5 requests per minute per peer and 20 overall, token collected once by the requesting peer.
11. **Commands.** Validated field by field (contract shapes, bounds, lengths), 20 per second per client, epoch-checked. A cast fires after 3 s (major) or 1 s at the achieved speed (1x while paused, so the countdown starts on resume). Major casts write a `beforePower` snapshot first, so the undo point excludes the command. `rewind` saves `beforeRewind`, loads the snapshot in place, sets the epoch past every epoch seen, and sends every client a fresh WELCOME. `speed` is a lease: it lapses when its god window disconnects unless `unattended` with an `until`; achieved speed is capped by the throttle state.
12. **Throttle.** Watching (god, TV or screensaver visible), Ambient (wallpaper only), Background (nothing visible, 1x by default), Yield (fullscreen, ComfyUI busy, a listed process, or another GPU user above 30% for 5 s; enter after 5 s, leave after 30 s clear), Evicted (Yield over 10 minutes or free VRAM under 3 GB), Battery (0.25x). A screensaver during Yield trickles at 0.1x and 2%. An optional power budget scales speed by `budget / (avg W - idle W)`. The OS probes are Windows-only and live in the shell: `ShellProbe` composes `FullscreenProbe`, `NvmlProbe` and `ComfyUiProbe`; on other platforms `StubProbe` reports idle, and `--shell` lets the shell push samples as `{"probe":{...}}` lines.
13. **Governor.** On ticks with `tick % 300 == 0`, from tick durations measured before that tick, the host may schedule a journalled `brainDiv` change (p95 over 15 ms gives 2, over 25 ms gives 3). Replay applies the journalled decision and never re-measures (CONTRACT 4.4).
14. **Persistence defaults.** `npm run host` keeps the world in `$XDG_DATA_HOME/phylotank/worlds/default` (`%LOCALAPPDATA%\Phylotank\worlds\default` on Windows); `--memory` keeps it in RAM. Autosave every 10 minutes of host time (2 to 60), the first after local midnight as `daily`; a shutdown snapshot on SIGINT or SIGTERM. Retention: 6 auto, 7 daily, 20 each of `beforePower` and `beforeRewind` within 7 days, manual forever, 10 GB total.

## HTTP endpoints (contract request H7)

| Route | Who | Body / reply |
|---|---|---|
| `GET /health` | any allowed origin; `null` origin gets `{ok}` only | `{ok, tick, epoch, state, clients, achievedHz}` |
| `POST /pair/request` | LAN peer, LAN on | `{name}` gives `{pairId, code}` |
| `GET /pair/status?pairId=` | the requesting peer | `{state: pending, approved (with token, once), denied, unknown}` |
| `GET /pair/pending`, `GET /pair/devices` | loopback with `Authorization: Bearer <god token>` | lists |
| `POST /pair/approve`, `/pair/deny`, `/pair/revoke` | same | `{pairId, code}`, `{pairId}`, `{deviceId}` |

## Not done yet

- Releases and sim settings (contract request H2), detectors (CONTRACT 11 derived events), lite snapshots, the GENO, SPEC and LINE sections (no genome store or species registry exists yet), predictive deltas (protocol 1.1), NEAR_POSE, INSPECT, FIELDS, GENOME_REQ.
- The Windows probes themselves, EcoQoS, mDNS, the GPU backend and its duty-cap controller.
- A 24-hour soak. The 3 MB/s wallpaper budget is not measured against a Default-preset world with creatures; by arithmetic, 3,000 motes as whole-tank dust are 18 KB per frame (270 KB/s at 15 Hz) plus a 37 KB glow field at 2 Hz (74 KB/s).
