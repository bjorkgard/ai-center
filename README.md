# Synapse Horizon

[![Release](https://img.shields.io/github/v/release/bjorkgard/ai-center)](https://github.com/bjorkgard/ai-center/releases)

![Synapse Horizon: the campus at night with halls A and B](docs/img/08-campus.png)

A live 3D AI data-centre dashboard that tracks Claude and Codex agents and subagents, styled like a strategy game.

## World

The campus, built in code from pure layouts and closed-form fake signals, chunk by chunk:

![One data hall with the roof cut away](docs/img/06-hall.png)
![One data hall with 16 racks and pulsing status LEDs](docs/img/07-racks.png)
![The campus at night: halls A and B, pads, roads, gate, parking and trees](docs/img/08-campus.png)
![The cooling plant at night: three towers with vapour and two chillers](docs/img/09-cooling.png)
![The power yard and the fibre with packets leaving the vault](docs/img/10-power-network.png)

## Quick start

```sh
vp install
vp dev          # development: http://localhost:5173
vp run serve    # the built app: builds, then serves it on 127.0.0.1
```

The log server runs under `vp dev`, `vp preview` (what Playwright uses) and the release binary alike, so the page counts the lines of your real Claude Code and Codex log files from the first load. Without logs the page shows a first-run card with the folders it is watching and a "Try the demo" button, which opens the seeded mock (`?source=mock&scenario=steady`). Where to look and how to change it: [Configuration](#configuration).

The page connects the live source by default. `?source=mock` selects the mock instead, and `?freeze=1` without a `source` connects nothing, which is what the screenshot baselines use. The top bar's connection pill reads Connecting, Catching up n/N files, Connected, Reconnecting or Off; an amber banner under it appears when the log server cannot be reached.

## Development setup

Install Vite+ (`vp`); it installs the Node version pinned in `.node-version`. Then:

```sh
vp install
vp dev
```

`vp dev` serves the app on `http://localhost:5173`.

## Testing and screenshots

```sh
vp exec playwright install chromium firefox webkit   # once per machine
vp run e2e         # smoke tests in Chromium and Firefox (what CI runs)
vp run e2e:local   # all three engines, then regenerates the screenshots
vp run shots       # builds, then writes docs/img/*.png (1280x720, under 200 KB)
```

The `logserver` Playwright project starts a second preview on port 4174 that watches only `e2e/.tmp/logs` (never your home folder) and checks the live source against it: the first-run card, appended lines in the `?dev=1` Data section, the banner texts, reconnecting and the token refresh.

The smoke spec waits for the scene's ready signal, then checks the page title, the canvas, the `app-version` meta tag and that
the console stays clean. A repeat-run spec captures the same view twice and asserts the two
images agree within a 0.5% pixel diff. The scene specs cover the draw-call bar, the 30 fps
calm mode, reduced motion, the projection toggle, the WebGL card, context loss and restore,
and the scene-error card. `vp run shots` waits on the ready signal for every image and fails
with `ShotFailed` (exit 1) if a page logs a console error or an image is over 200 KB.

## Scene core (chunk 04a)

One persistent 3D canvas fills the viewport behind the DOM overlay layer. It shows the campus (chunk 08), drawn through an orthographic isometric camera that the perf HUD can switch to perspective. Add `?dev=1` to show the perf HUD (fps, scene and post-processing draw calls, triangles, `renderer.info` counts, frame cap and mode, quality tier, WebGL state) and the `window.__sceneDev` hooks. `?webgl=0` forces the WebGL card, `?calm=0` keeps the 60 fps cap and `?freeze=1` renders one fixed frame.

![Test cube with the perf HUD](docs/img/04a-core.png)

## UI shell (chunk 04b)

The empty dashboard frame sits above the scene: top bar, KPI tiles, job tracker, tab strip and a right panel that `?dev=1` toggles from the HUD, all on `GlassPanel` (8% white tint over an adaptive dark layer, 16 px blur, solid fallback under slow frames). The store `safeArea` is the canvas minus the visible panels. A loader covers the 3D area until the first frame, and a toast host announces "Restoring 3D view" and "3D view restored".

![Empty UI shell over the test scene](docs/img/04b-shell.png)

## Look (chunk 04c)

A low-poly isometric campus in dark slate and concrete, lit by cool moonlight with warm window and LED points and glowing cyan fibre under bloom, matching the approved mockup ([docs/designs/variant-B-2.png](docs/designs/variant-B-2.png)). One shared material library and one light rig serve every view; `?view=lookdev` draws the fixed vignette that a committed baseline guards in `vp run e2e:local`.

![Test cube on the ground under the final rig](docs/img/04c-scene.png)

![Look-dev view: hall, rack row with six status LEDs, fibre, vendor trim](docs/img/04c-lookdev.png)

## Hall (chunk 06)

One data hall built in code: floor slab, walls, a cutaway roof, cold and hot aisle tiles, a door as one merged mesh on a shared vertex-coloured material, and the windows as a second mesh on the shared window glow, with a sign panel above the door that reads the hall letter and project name from one shared canvas atlas. The roof is one clipping plane, cut away in every view; the sign fades out over 200 ms when it faces away or its project name drops under 12 px. `?view=hall` frames one hall; `?dev=1` adds a collapsed Hall section with the roof toggle (`__sceneDev.setRoofCut(on)`). The hall costs 4 scene draw calls (3 main pass, 1 shadow).

![One data hall with the roof cut away](docs/img/06-hall.png)

## Racks (chunk 07)

Each hall owns one rack InstancedMesh (16 bodies) and one LED InstancedMesh (208 LEDs: a status strip and 12 blades per rack), allocated once, so changing the rack count writes only the instance count and colour buffers and never adds a draw call or a geometry. LED colours are the D17 status colours; they pulse between 0.6 and 1.0 of their level over 1.2-3.0 s, and hold a steady 0.8 under reduced motion. Racks take slots through a pure allocator (a key keeps its slot, a new key takes the lowest free one, a 17th is counted). The seeded fake load (`src/scene/fake.ts`, read only through `SceneSignals`) gives the strips a 60/25/10/5 tool, thinking, idle, waiting mix and 0-6 lit blades. `?view=racks` shows the hall with a fixed 16 racks; `?dev=1` adds a collapsed Racks section (hall picker, count slider 0-16, fake load toggle) with `__sceneDev.setRackCount(hall, n)` and `__sceneDev.setFakeLoad(on)`.

![One data hall with 16 racks and pulsing status LEDs](docs/img/07-racks.png)

## Campus (chunk 08)

The static campus around the halls, from a pure layout (`src/scene/campus/layout.ts`): 12 hall slots on a 4 x 3 grid (A and B in the front row nearest the gate, filling toward the back), the road grid, and zones for the cooling plant, power yard, gate, parking and loading dock. Halls A and B stand with the seeded fake racks; every other slot shows an empty pad with its number `01`-`12`, which appears once it measures 12 px. The site has roads, a parking lot with instanced parked cars (three dark greys, lights off), a security gate with a barrier boom, a loading dock with bay doors, instanced road lamps on the warm glow, trees, a perimeter fence open at the gate and a gate monument reading SYNAPSE HORIZON. The camera bounds, the ground, its grid and the shadow camera all come from the campus extent, and the first view and `0` frame the placed halls plus the plant, power and gate zones. The whole home view costs 38 scene draw calls with shadows on (27 for the campus, 6 for the cooling plant of chunk 09, 5 for the power yard and fibre of chunk 10). `?dev=1` adds a collapsed Campus section (placed halls 2-12, waypoint graph toggle) with `__sceneDev.setPlacedHalls(n)` and `__sceneDev.setWaypoints(on)`.

![The campus at night: halls A and B, pads, roads, gate, parking and trees](docs/img/08-campus.png)

## Cooling (chunk 09)

The cooling plant stands in the plant zone at the top left of the home view: three low-poly cooling towers with an open fan stack each, two chillers, and a fan turning in every stack. Towers and chillers cast shadows. The vapour is up to 60 soft billboards per tower in one InstancedMesh (one draw call for the tower group), `#8090A8` at opacity 0.35 under normal alpha blending with no depth write, ordered back to front against the camera each frame. Each billboard grows from 1.2 to 2.4 units over a 6 s life and rises 0.6 units a second; it fades in over 0.5 s and out over the last 1.5 s through the per-instance fade, so a rebirth never pops. Vapour is a closed form of scene time and seed (particle `i` has age `(t + offset) mod 6 s` and shows while `i < 60 x duty`), so every frozen shot has full plumes and a duty change reaches them as particles are reborn. Fans turn 0.5 times a second at duty 1 and a tenth of that at duty 0; with reduced motion the vapour is 30% and the fans a quarter of their speed. The duty, each particle's age and each fan's angle come from `SceneSignals` (`duty()`, `vapourPhase(i)`, `fanAngle(i)`), seeded in `src/scene/fake.ts`. `?view=cooling` frames the plant zone; `?dev=1` adds a collapsed Cooling section with a duty slider (it follows the live duty until you drag it) and `__sceneDev.setDuty(value)`.

![The cooling plant at night: three towers with vapour and two chillers](docs/img/09-cooling.png)

## Power and network (chunk 10)

The power yard stands in the power zone, left of the gate: a fenced substation with three transformers, three generators with exhaust stacks, three fuel tanks lying on saddles and the fibre entry vault at the zone's east edge, on the axis of the road in front of the first hall row. Transformers, generators and tanks cast shadows; the whole yard is one merged mesh (2 scene draw calls). The fibre runs from the vault along the road grid (the first road row, then a column road, then the road in front of a hall's row) to each placed hall's door side, with rounded right-angle bends of radius 0.6, 0.4 in from the kerb and 0.03 above the road; the last 0.6 units climb the wall beside the door to a small entry box. Lines that start the same way share their tubes, with a grey junction box where they part. Only placed halls get a line (A and B always); the lines are rebuilt when the placed set changes and the old geometry is disposed. The fibre costs 3 draw calls: the tubes, the junction and entry boxes, and one InstancedMesh for every line's packets. Packets are pale cyan spheres (`#A5F3FC`, emissive 3.2, the top of the glow ladder) that move at 2.5 units a second, one a second per line by default and at most 12 on a line (never closer than 1.2): a line of length `L` holds `n` packets (`ceil(rate L / 2.5)`, capped at 12 and at `L / 1.2`) and packet `j` has travelled `2.5 t + j L / n` units, wrapped to the line, so they sit evenly over the whole line and every frozen shot has populated lines; with reduced motion they move at 25% of that and the spacing stays. The rate and the lines' travelled distance come from `SceneSignals` (`packetRate()`, `packetPhase(line, i, length, count)`, which places packet `i`), computed from scene time (plus an offset that keeps packets in place when reduced motion toggles) in `src/scene/fake.ts`. `?view=power` frames the power zone and the start of the road beyond its vault; `?dev=1` adds a collapsed Network section with a packet-rate slider and `__sceneDev.setPacketRate(perSecond)`, and the read-only `__sceneDev.fibreLines()` and `__sceneDev.packetSpeed()`.

![The power yard at night: substation, generators, tanks, the vault and the fibre with packets](docs/img/10-power-network.png)

## Data sources (chunks 11 and 12)

Agent activity lands in one store (`src/app/store/data.ts`) as batches of normalised events (`src/data/schema.ts`, zod 4 `zod/mini`). Every source implements `{ start, stop, onEvents, onStatus }`, delivers at most 500 events a batch and reports `catching_up`, `live`, `closed` or `error`. Each event is validated; invalid ones are dropped and counted, repeats are skipped by id, and per-session `lastSeen` and status follow the newest `ts`. Totals per project, session and subagent are authoritative; a 50,000-event ring buffer keeps only the recent timeline. Only the mock exists for now: `?source=mock&scenario=steady&seed=1` streams a seeded scenario (fictional projects under `/work/`, Claude and Codex) on a sim clock: the first 10 sim minutes arrive as catch-up, then it runs in real time; with `freeze=1` only the catch-up is sent and the clock is paused and locked. `speed=1`, `10` or `60` sets the clock speed. `?dev=1` adds a collapsed Data section with a scenario select, play/pause and 1x/10x/60x buttons (disabled under `freeze=1`), a health row (applied, batches, last batch, invalid, duplicates, source time as +HH:MM:SS since the sim start, speed, paused), the 50 newest sessions and, under a clicked session, its last 20 events.

Scenarios (`src/data/scenarios.ts`) select what the mock shows. Add `&speed=10` to see a scenario unfold ten times faster.

| Scenario     | What it shows                                                                                                      | Example URL                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `steady`     | Three projects, seven sessions and three subagents at an even pace                                                 | `?source=mock&scenario=steady&speed=10`     |
| `burst`      | One parent session spawns 10 subagents together, every 2 sim minutes                                               | `?source=mock&scenario=burst&speed=10`      |
| `churn`      | Six projects swap in and out every 20 sim seconds, three at a time; two more idle long enough to retire and return | `?source=mock&scenario=churn&speed=10`      |
| `overflow`   | One project grows to 40 sessions by 18 sim minutes, then shrinks to 8                                              | `?source=mock&scenario=overflow&speed=10`   |
| `errors`     | An error storm across six sessions every 5 sim minutes, then recovery                                              | `?source=mock&scenario=errors&speed=10`     |
| `codex-only` | Every session is a Codex session                                                                                   | `?source=mock&scenario=codex-only&speed=10` |
| `waiting`    | Three sessions end a turn and wait on the user                                                                     | `?source=mock&scenario=waiting&speed=10`    |

`vp run mock:dump -- --seed 1 --scenario burst --minutes 10 --out events.jsonl` writes any scenario's events as JSONL, one per line.

![The Data section open over the frozen mock catch-up](docs/img/11-store-debug.png)

## Provenance legend (chunk 13)

Every number is a `Metric` (`src/data/metrics.ts`): a value (or `null`, shown as "unknown", never 0), a unit, a provenance and a `basis` string. A raw `number` does not compile where a metric is expected. `?dev=1` lists the metrics in the Data section, each with its badge; hover or focus a badge for its provenance and basis.

| Badge       | Meaning                                      | Example                            |
| ----------- | -------------------------------------------- | ---------------------------------- |
| Solid dot   | `real`: read from the logs as is             | token totals                       |
| Ring        | `derived`: computed from real data by a rule | tokens/min, active sessions        |
| Dashed ring | `estimated`: built from invented constants   | rack kW, inlet, cooling duty, cost |

A composite takes the highest provenance of its inputs (real < derived < estimated). All constants live in `src/config/estimation.ts` and are labelled `[estimated]`:

- tokens/min of a session = its in + out tokens in the trailing 60 sim s, in one-second buckets; a rack's figure adds its subagents'.
- rack kW = 0.8 + 0.004 x tokens/min, at most 40; rack load = kW / 40. A rack is a main session that is not done; a hall is a project.
- hall heat = sum of its racks' kW; inlet = 22 + 0.25 x kW with a first-order lag (tau 30 s), integrated exactly in sim time; hot aisle = hall inlet + 12 x mean rack load.
- cooling duty = min(1, total hall heat / (400 kW x placed halls)), at least 2 halls; its basis says "over capacity" past 100%.
- cost = tokens x the model's price per token class (`src/config/prices.ts`, `asOf` in the basis): an API-equivalent figure, not a subscription bill. Sessions with an unknown model are left out and counted in the basis; if all are unknown the cost is "unknown". In live mode totals name their window ("last 24 h, backfill window").
- a session with no event for 30 sim min ends at exactly its last activity + 30 min, on the one store clock; `waiting_user` holds until then. Derived values freeze while the clock is paused, so a frozen frame shows each rack's inlet at its idle baseline.

Done sessions leave the store once the 50,000-event ring no longer holds them; project and global totals stay exact. Limits: a session that returns after eviction restarts its per-session counters at 0, and an id dropped from the full 100,000-id tombstone set counts as a new session.

![The Data section's metrics with their provenance badges, the tokens tooltip open](docs/img/13-provenance.png)

## Data sources and privacy

What is read: only the log files under the folders listed in [Configuration](#configuration), only those modified in the last 24 h at startup and everything appended to them afterwards. Everything stays on your machine: the log server binds to `127.0.0.1` (`localhost` under `vp dev`) and the page talks to it over a local WebSocket.

What reaches the browser in this version: per-file line counts and the folder paths with their file counts. No log content leaves the files. Chunk 15 adds session ids, model names, token counts, tool names and a `currentTask` truncated to 120 characters and redacted.

What the token is for: the page carries a random per-run token, and the server also checks the Origin header (a page on another origin cannot open the socket) and the Host header (which stops DNS rebinding). That protects against other web pages. It does not protect against other programs on your machine: any local process can fetch the page or `/api/session` and read the token, and could read the log files directly anyway.

## Configuration

The dev server (`vp dev`), the preview server (`vp preview`) and the release binary tail Claude Code and Codex log folders and stream per-file line counts to the app over a WebSocket at `/api/stream`. Nothing leaves your machine: the server binds to `127.0.0.1` (`localhost` under `vp dev`), refuses other Host and Origin headers, and the page needs a per-run token. In this version the stream carries counts and folder paths only.

Which folders are watched is decided by the first of these that names any; sources never merge, so to add a folder you must list the defaults too.

1. `--log-root <dir>` (repeatable): binary only, `synapse-horizon --log-root ~/a --log-root ~/b`.
2. `SYNAPSE_LOG_ROOTS`: folders separated by `:` (`;` on Windows). `SYNAPSE_LOG_ROOTS=none` watches nothing, so a folder literally named `none` needs `--log-root`.
3. `logRoots` in the config file (a missing file is normal):
   - macOS and Linux: `$XDG_CONFIG_HOME/synapse-horizon/config.json`, else `~/.config/synapse-horizon/config.json`
   - Windows: `%APPDATA%\synapse-horizon\config.json`
4. The defaults: `$CLAUDE_CONFIG_DIR/projects` (else `~/.claude/projects`) and `$CODEX_HOME/sessions` (else `~/.codex/sessions`).

A config file that exists but cannot be read or parsed never falls back to the defaults: the binary exits with the path, the error and a valid example, and the dev and preview servers watch nothing and show the error as the folder's status. `--no-logs` watches nothing as well. [`config.example.json`](config.example.json) is a valid file:

```json
{ "logRoots": ["/home/you/.claude/projects", "/home/you/.codex/sessions"] }
```

```bash
# the defaults plus a second Claude Code folder, for one run
synapse-horizon --log-root ~/.claude/projects --log-root ~/.codex/sessions --log-root /work/other/.claude/projects
SYNAPSE_LOG_ROOTS="$HOME/.claude/projects:$HOME/.codex/sessions:/mnt/other/logs" vp dev
synapse-horizon --no-logs            # serve the app, watch nothing
```

On start the binary prints the version, `listening on http://127.0.0.1:<port>/` and one `[logs]` line per folder: its resolved path and how many files changed in the last 24 h, or why it is missing or unreadable. Only files modified in the last 24 h are read at startup, in 64 KiB chunks.

If a `[logs]` line says the inotify watch limit was reached (`ENOSPC`, Linux), the folder is polled every 5 s instead; raise the limit with `sudo sysctl fs.inotify.max_user_watches=524288`. A `permission denied (EACCES)` line names a file the server could not read; check its owner. What reaches the browser is described in [Data sources and privacy](#data-sources-and-privacy).

## Controls

Left-drag pans, right-drag rotates, the scroll wheel zooms towards the cursor, and a double-click on empty ground (a road, a pad or open ground, not a hall) flies home; the camera stays inside the campus. With the 3D view focused (Tab, right after the top bar) the keys work too: arrows pan, `+`/`=` and `-` zoom, `Q`/`E` rotate 45 degrees, `0` or `Home` frames the placed campus, `P` switches orthographic and perspective. `?dev=1` adds a Camera section under the perf HUD with a glide test, the projection switch and the right-panel toggle.

## Known limits

- **"Your browser could not start 3D (WebGL)."** The browser could not create a WebGL2 context. Turn on hardware acceleration in the browser settings and reload; Safari has no such setting, so update the browser and system. The panels still work.
- **"The 3D view lost its graphics connection."** The graphics context was lost and did not come back within 10 s. Reload the page; if it comes back by itself later the card hides.
- **"The 3D view stopped after an error."** The scene threw an error. Reload to restart it, and report the `[scene]` lines in the browser console; "Copy error details" puts them on the clipboard with the app version.

## Architecture

How three.js is integrated into the app: React Three Fiber (R3F), chosen by ADR 0001 from 48 measured passes under a decision rule written before the runs. See [docs/adr/0001-render-integration.md](docs/adr/0001-render-integration.md).

![Render spike: 12 halls, 192 racks, 3,072 LEDs](docs/img/03-spike.png)

## Contributing

Branches are `chunk/NN-slug`, with one pull request per chunk and a Conventional Commit title. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Versioning and releases

`package.json` `version` is the single source of truth; the app exposes it as `<meta name="app-version">`. Every merge to `main` that changes behaviour (`feat:`, `fix:`) produces a tagged GitHub Release with generated notes and `CHANGELOG.md`; `docs:` and `chore:` do not. `feat:` bumps the minor version, `fix:` the patch, and only `feat!:` reaches 1.0.0. Preview the next release with `GITHUB_TOKEN=$(gh auth token) vp run release:dry`. Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## Status

Chunk 10 (power yard, fibre and packets) built; the world gallery above shows chunks 06 to 10. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/PLAN.md](docs/PLAN.md) for the build plan.
