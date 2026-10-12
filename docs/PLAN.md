# Synapse Horizon: Build Plan

A live 3D AI data-centre dashboard that tracks Claude and Codex agents and subagents, styled like a strategy game.
This file is the ordered build plan. Each chunk is small enough for one sitting, ends in something runnable, and has acceptance checks to pass before the next chunk starts.

Status legend per chunk: `[ ]` todo, `[~]` in progress, `[x]` accepted.

---

## 1. Settled decisions

| # | Decision | Source |
|---|---|---|
| D1 | All modern desktop browsers: Chrome, Safari, Firefox. WebGL perf budget applies to all three. Mobile out of scope. | Brief |
| D2 | Vite+ (`vp`) + React + TypeScript (strict) + Tailwind CSS + Three.js. pnpm, Node 22 LTS. Vite+ bundled lint/format. | Brief, F1, F5 |
| D3 | Data source: raw Claude Code and Codex CLI JSONL logs, read by a local log server that runs as a Vite plugin inside `vp dev` (same origin as the app, one command). It tails files, parses them in Node, and streams normalised events over WebSocket. Drag-and-drop import uploads files to the same server for replay. A thin CLI entry serves the built app with the same plugin logic. Mock source for every chunk before logs connect. | Brief, A2, eng review D1 |
| D4 | Live tail and replay (1x / 10x / 60x). Backfill last 24 h. Session ends after 30 min idle. | A3, A4 |
| D5 | Project key = working directory path. Claude and Codex sessions in the same repo share one hall. | A5 |
| D6 | Three provenance levels: `real`, `derived`, `estimated`. Every displayed metric carries one. | A10 |
| D7 | 1 rack = 1 main-agent session. Subagents = lit blades inside the parent rack, plus avatars at the loading dock. | B2 |
| D8 | 16 racks per hall (2 rows x 8, hot/cold aisle between). Overflow halls `A2`, `A3`... take the lowest free slot in the fixed grid and are linked to the parent by a cyan conduit and matching sign colour; halls never move once placed (eng review D3). Each project is capped at 3 halls (48 racks); extra sessions show as "+N" on its last rack but stay fully counted in panels (eng review D4). Halls A and B always exist (dormant when empty). Hall removed after 10 min with no active session (configurable). | B3-B5 |
| D9 | Orthographic isometric camera by default, perspective toggle. Free rotation. | B1, C1 |
| D10 | Look follows the approved mockup (design D14): low-poly isometric campus in realistic dark materials, glowing cyan `#22D3EE` fibre lines with bloom, built entirely in code (no external models). This supersedes the brief's "toy-like clay" wording. Status and vendor colours allowed (Claude amber, Codex neutral white/green, error red). Bloom on, auto-disabled below 45 fps. | B6, B7 |
| D11 | Zustand store. Incrementally updated aggregates (sessions, tokens, jobs) are the source of truth; a capped ring buffer holds only the recent event timeline (eng review Q1). Dashboard uses React selectors. Scene uses transient (non-React) subscriptions for per-frame updates. | F2 |
| D12 | Scene life is driven by real events: truck = rack/hall created, technician cart = agent error, node swap = error cleared. | E1 |
| D13 | Weather is visual and panel only. Manual selection plus optional auto-cycle. Clear is baseline. | Brief, E4 |
| D14 | Day/night follows local clock, with force-day/force-night and a fast-cycle demo mode. | E3 |
| D15 | English UI, °C, kW, 24 h clock, local timezone. | D5 |
| D16 | Privacy: current task truncated to 120 chars, paths outside the project redacted, secret patterns redacted at parse time, nothing leaves localhost (WebSocket origin + token check). | A12, eng review A1, D2 |
| D17 | Cost = tokens x per-model price table in config, labelled `estimated`. | A7 |
| D18 | Tests: Vitest (parsers, store, reconciler) and Playwright. GitHub Actions (ubuntu) from chunk 01 runs `vp check`, `vp test`, and Chromium + Firefox smoke. On the Mac, `vp run e2e:local` runs WebKit smoke, leak test, perf scenario and screenshots, and must pass before a chunk is ticked. One PR per chunk, squash-merged with a Conventional Commit title (checked in CI). | F3, F6, eng review D6, D19 |
| D19 | Versioning and releases: semver in `package.json` is the single source of truth. Every PR merged to main runs semantic-release: the version is bumped from Conventional Commit types (fix = patch, feat = minor, `!`/BREAKING = major), CHANGELOG.md is updated, a `vX.Y.Z` tag is pushed and a GitHub Release is created. Merges with only docs/chore/test changes make no release. Each release attaches single-executable builds (Node SEA: log server + built web app in one binary) for macOS arm64, macOS x64, Linux x64 and Windows x64. Users download, run and get the app at localhost with no Node or dev setup. | Added 2026-10-12 (user request) |

**Open decision (gates chunk 04 onward):** React Three Fiber vs direct Three.js. Settled by the spike in chunk 03.

Provisional recommendation, to be confirmed or overturned by the spike: **React Three Fiber + drei, with all hot paths imperative** (InstancedMesh matrices and colour buffers written in `useFrame` from refs, fed by transient Zustand subscriptions, never by React re-renders). Reasoning: hall add/remove is a natural fit for declarative mount/unmount and R3F disposes owned objects on unmount, drei gives `MapControls`, `Html`, `OrthographicCamera` and `Instances` for free, and the per-frame cost is the same as vanilla once updates bypass React. Vanilla wins only if the spike shows reconciliation overhead or leaks we cannot control.

---

## 2. Normalised event model

Shared TypeScript module `src/data/schema.ts` (validated with zod), used by the log server (Node), the browser store, and the mock source. Parsers run only in Node (eng review D1).

```text
AgentEvent {
  id            string     // stable hash of vendor + file + line offset
  vendor        "claude" | "codex"
  projectKey    string     // normalised cwd
  sessionId     string
  parentSessionId?  string // subagent parent; absent = main agent
  parentKnown   boolean    // false when a subagent's parent cannot be recovered
  agentKind     "main" | "sub"
  model?        string
  ts            ISO string
  type          session_start | session_end | turn_start | turn_end | tool_call | tool_result | usage | status | error
  status?       idle | thinking | tool | waiting_user | error | done
  currentTask?  string     // truncated, redacted
  toolName?     string
  filesTouched? string[]   // project-relative
  tokens?       { in, out, cacheRead, cacheWrite }
  raw?          { file, offset }  // pointer back to source line, never the content
  provenance    Record<fieldName, "real" | "derived" | "estimated">
}

Metric { value: number, unit: string, provenance: "real"|"derived"|"estimated", basis: string }
```

`basis` is a short human string shown in tooltips, e.g. "idle 0.8 kW + 0.004 kW per token/min".

### Field feasibility from raw logs

Log formats below are from knowledge of current Claude Code and Codex CLI versions and are **unverified until chunks 15 and 16 run against your real files**. Vendors change these formats without notice, so parsers must tolerate unknown fields and versions.

| Field | Claude Code | Codex CLI | Provenance |
|---|---|---|---|
| sessionId | Yes (`sessionId`, file name) | Yes (rollout file / session meta) | real |
| projectKey | Yes (`cwd` per line) | Yes (`cwd` in session meta) | real |
| model | Yes (assistant message) | Yes (session/turn context) | real |
| tokens in/out/cache | Yes (`message.usage`) | Yes (`token_count` events, cumulative) | real |
| tool calls + names | Yes (`tool_use` blocks) | Yes (function call items) | real |
| files touched | Partial (Edit/Write tool inputs) | Partial (patch/shell items) | derived |
| subagent parent | Yes when sidechain or subagent transcript links exist | Often missing: `parentKnown=false` | real / unknown |
| session_start | Yes (first line ts) | Yes (session meta) | real |
| session_end | No explicit event: 30 min idle | No explicit event: 30 min idle | derived |
| status | Inferred from last event kind | Inferred from last event kind | derived |
| waiting_user | Inferred: assistant turn ended, no new user line; holds until the 30 min idle end (eng review Q3) | Same | derived |
| currentTask | Heuristic: active TodoWrite item, else last user prompt | Last user prompt | derived |
| cost | Not in logs | Not in logs | estimated |
| job stages | Not in logs | Not in logs | derived |
| rack kW, °C | Synthetic | Synthetic | estimated |

### Job model (derived)

Job = one active TodoWrite item when present, otherwise one user-prompt turn.
Stage mapping: Queued = todo pending; Scheduled = turn received, no tool call yet; Running = tool loop active; Checkpoint = file edit or git commit seen; Evaluating = test or lint command detected in a shell tool call; Done = turn end or todo completed. All stages labelled `derived`.

### Estimation model (estimated)

Constants in `src/config/estimation.ts`, one place:
- Rack kW = 0.8 idle + k x tokens/min of that session (and its subagents), clamped to 40 kW.
- Rack inlet temp = 22 °C + a x kW, smoothed with a first-order lag (tau 30 s). Hot aisle = inlet + 12 °C x load.
- Cooling tower duty = hall heat / capacity. Weather heatwave shows duty at 100% visually only (D13).
- Cost = token counts x per-model price table.

---

## 3. Architecture in one picture

```text
~/.claude/projects/**.jsonl  ~/.codex/sessions/**.jsonl
            │                          │
            └── log server = Vite plugin in `vp dev` (Node: chokidar tail, parsers, redaction)
 drag-drop file ── POST /api/import ──┘   │ WebSocket (same origin): AgentEvent[]
 mock generator ──► (same AgentEvent stream, in browser)
                          ▼
          Zustand store: events → sessions, projects, jobs, metrics
             │ selectors (React)            │ transient subscribe (per frame)
             ▼                              ▼
      dashboard panels               scene: reconcileHalls() → hall/rack/agent instances
```

One source switch (`mock | live | replay`) in a dev menu; the rest of the app cannot tell which source is active.

---

## 4. README and screenshot protocol (applies to every chunk)

- Images live in `docs/img/NN-<slug>.png` (NN = chunk number), 1280x720 PNG, compressed under 200 KB.
- Captured by `vp run shots` (Playwright, Chromium), which opens the app with `?source=mock&scenario=steady&seed=1&freeze=1&view=<name>`. `freeze=1` stops the animation clock at a fixed time so images are reproducible.
- Each chunk adds its view name(s) to `scripts/shots.config.ts`, so old images regenerate when the look changes.
- The README is rebuilt section by section. Every chunk's README step lists exactly what to add.

README skeleton, grown over time:
1. Title, one-line pitch, hero image (latest full-campus shot).
2. Status: which chunks are done, link to this plan.
3. Download and run: pick the build for your OS from GitHub Releases, run it, and the browser opens at `http://localhost:4317`. Includes first-run notes for unsigned binaries (macOS Gatekeeper, Windows SmartScreen) and the `--port`, `--no-open` and `--version` flags.
4. Development setup (`vp install`, `vp dev`; the log server starts with the dev server; Node version pin; `vp run e2e:local` on a Mac).
5. Contributing: link to CONTRIBUTING.md (branch and PR flow, Conventional Commit PR titles, what CI runs, chunk acceptance and screenshots, how releases happen).
6. Data sources and privacy (where logs are read, what is redacted).
7. Provenance legend (real / derived / estimated badges).
8. Feature gallery: one small image + one line per built part.
9. Architecture diagram.
10. Configuration (log paths, estimation constants, price table, grace periods).
11. Testing and screenshots.
12. Known limits (unrecoverable fields, browser caveats).
13. Versioning and releases (how versions are bumped, where builds come from).

---

## 4b. Screen and design spec (design review, 2026-10-12)

Visual reference: approved mockup `/Users/nathanael/.gstack/projects/bjorkgard-ai-center/designs/main-dashboard-20261012/variant-B-2.png` for both layout and look (design D5, D14, D28). Where the image differs from this text, the text wins: no glyphs on cooling towers, and provenance marks sit top-right of the number (D19). Every decision below cites its design-review question.

### Screen layout (design D5)

Minimum supported window 1280x720. All gutters 16px.

```
+--------------------------------------------------------------------------------+
| TOP BAR 56px: wordmark | search | Halls Cooling Power Network | ... | clock | user|
+--------------------------------------------------------------------------------+
| [KPI Claude][KPI Codex][KPI Agents]                       +-------------------+ |
|                                                           | RIGHT DETAIL      | |
|                                                           | PANEL 360px       | |
|              3D CAMPUS (hero, full viewport behind UI)    | full height below | |
|                    safe area = canvas minus panels        | top bar; hidden   | |
|                                                           | when nothing is   | |
| +--------------------------------+                        | selected          | |
| | JOB TRACKER (6 stages)         |                        |                   | |
| +--------------------------------+                        +-------------------+ |
| TAB STRIP 48px collapsed: Sessions Subagents Tool calls Tokens Errors Projects  |
+--------------------------------------------------------------------------------+
```

- Tab strip expands upward to at most 40vh; while expanded it hides the job tracker.
- The store keeps a `safeArea` rect (canvas minus visible panels). Area presets and `cameraRig.glideTo` frame targets inside it, so a selected object is never behind a panel (chunks 05, 25).

### Visual hierarchy (design D6)

1. First: the attention chip in the top bar, left of the clock: "<n> waiting · <m> error" plus a muted "+k" for other alerts. It is the only alert entry point; the bell is removed (design D26). It shows a quiet "All clear" at zero, turns amber when anything waits and red when any error. Click opens one alert panel with tabs "Needs you" (waiting/error queue, flies to the oldest item) and "All alerts" (acknowledge).
2. Second: the 3D campus. In the scene, `waiting_user` racks show a slow amber-white beacon above the rack; it is the strongest scene signal, above load pulses and packets.
3. Third: KPI tiles, then the job tracker, then the tab strip.

### Semantic zoom (design D7)

- Zoomed out (below the threshold): each hall shows a billboard label with project name, session count and a worst-status dot. Per-rack labels are hidden.
- Zoomed in: billboards fade out (200 ms) and rack detail and LEDs show.
- Label text is never smaller than 12 CSS px on screen.

### Data mode and replay (design D8)

- Mode chip right of the clock: `LIVE` (cyan dot), `REPLAY 10x` (amber), `MOCK <scenario>` (grey). Click opens the source menu (live / replay file / mock scenario).
- In replay a 40 px bar appears above the tab strip: play/pause, 1x/10x/60x, a scrubber showing sim time.
- Unassigned board: a small glass list at the campus edge, shown only when it has items.
- "+N" badge: 12 px neutral-grey pill on top of the project's last rack.

### Empty and first-run states (design D9)

- Dormant hall: LEDs off, desaturated materials, grey floor sign reading "No sessions".
- KPI tiles at zero show "0" and a flat sparkline, never a dash.
- No log files found: a centred glass card reads "Watching ~/.claude/projects and ~/.codex/sessions. No sessions in the last 24 h." with two buttons, "Drop a .jsonl to replay" and "Try the demo" (starts mock `steady`).

### Loading and catch-up (design D10)

- Scene loader: centred wordmark with a thin cyan progress line until the first frame renders.
- The server sends backfill progress `{done, total}` in files; the connection pill reads "Catching up 120/480 files".
- KPI tiles, job tracker and table show shimmer skeletons until backfill completes, then show the real values. They never count up from 0 during catch-up.

### Failure states (design D11)

- WebGL unavailable: a full-viewport glass card reads "Your browser could not start 3D (WebGL)." with a link to browser help. Panels and the table still render from the store.
- WebGL context lost: restore automatically and show a toast, "Restoring 3D view".
- Log server down (at load or later): a persistent amber banner under the top bar reads "Log server not running. Start it with `vp dev`". It hides itself on reconnect.

### Toasts and search (design D12)

- Toasts sit bottom-right above the tab strip, at most 3 visible, newest on top.
  - Normal toasts auto-dismiss after 6 s; error toasts stay until acknowledged.
  - Overflow collapses into "+N more alerts", which opens the alert list.
- Search opens a dropdown under the field; it also opens on Cmd+K / Ctrl+K and `/`.
  - Up to 8 results, grouped by kind (project, session, rack, agent, tool).
  - Arrow keys plus Enter fly to the result.
  - Empty state: "No match for 'xyz'. Try a project, rack ID like A-R07, or tool name."

### Interaction state table (from design D9-D12)

```
FEATURE         | LOADING                 | EMPTY                       | ERROR                          | SUCCESS             | PARTIAL
----------------|-------------------------|-----------------------------|--------------------------------|---------------------|---------------------------
3D scene        | wordmark + cyan line    | halls A/B dormant           | WebGL card / restore toast     | live campus         | low quality tier
KPI tiles       | shimmer until backfill  | "0" + flat sparkline        | stale: amber banner above      | value + badge       | unknown cost shows "unknown"
Connection pill | "Catching up n/N files" | "No logs found" + card      | "Reconnecting" + banner        | "Connected"         | "Catching up"
Detail panel    | skeleton rows           | hidden (nothing selected)   | entity removed: panel closes   | live stats          | parent unknown: grey "?"
Job tracker     | shimmer                 | all stages 0                | n/a                            | counts + rows       | Done capped at last 20
Table tabs      | shimmer rows            | "No <kind> yet" + hint      | parse failures in Errors tab   | virtual rows        | ring-buffer cap noted
Search          | n/a (local)             | "No match for 'xyz'" + hint | n/a                            | grouped 8 results   | n/a
Toasts/alerts   | n/a                     | chip "All clear"           | error toasts stay              | auto-dismiss 6 s    | "+N more alerts"
Import drop     | progress in pill        | n/a                         | size/format error message      | REPLAY mode + bar   | malformed lines counted
```

### Legend and actions (design D13)

- Legend: a small glass card bottom-left, above the job tracker.
  - Shown once automatically on first visit; the dismissal is remembered in localStorage, wrapped in try/catch.
  - Reopen with `?`, which also shows the shortcut list.
  - Rows: rack = session, lit blade = subagent, beacon = waiting on you, amber/mint trim = Claude/Codex, plus the three provenance badges.
- Agent and rack panels get "Copy session ID" and "Copy project path" buttons that confirm with "Copied".

### User journey storyboard (design D6-D13)

```
STEP | USER DOES                          | USER FEELS                | PLAN SPECIFIES
-----|------------------------------------|---------------------------|--------------------------------------------
1    | Runs `vp dev`, opens the page      | curious, a bit impatient  | loader, then "Catching up n/N" (D10)
2    | Sees the campus (5 s)              | delight: "my agents live" | mockup-style campus hero (D14), semantic zoom labels (D7)
3    | Legend pops once                   | oriented, not lectured    | 4-row legend, dismissible (D13)
4    | Notices "1 waiting" chip           | alert, in control         | top-bar attention chip (D6)
5    | Clicks chip, camera glides         | satisfied, fast           | glide into safe area, beacon rack (D5, D6)
6    | Reads panel, copies session ID     | ready to act              | detail panel + copy actions (D13)
7    | Weeks later: glances while working | calm, ambient trust       | provenance badges, mode chip (D8), no fake surges (D10)
```
Time horizons: 5 s visceral (step 2), 5 min behavioural (steps 3-6), long-term reflective (step 7).

### Material and glow (design D14)

The approved mockup sets the look, not only the layout. The look is a low-poly isometric campus in realistic dark slate/concrete materials, warm window and LED points, and glowing cyan `#22D3EE` fibre lines with bloom. Everything is still built in code, with no external models. This replaces the brief's "toy-like clay" wording. Chunks 04 and 08 compare a frozen screenshot against variant-B-2.

### Tool-call rows (design D15)

The tool-call timeline in agent and rack panels uses plain rows, not boxed cards, even though the mockup shows boxes.
- 32 px rows: 16 px icon, then tool and target (truncated in the middle), then right-aligned time in tabular numerals.
- 1 px divider at 8% white between rows, and a highlight on hover.
- Clicking a row expands that call's details inline.

### Type, spacing and radius tokens (design D16)

Defined in chunk 01 as CSS variables in `src/styles/tokens.css` and mapped into the Tailwind theme.
- Fonts: Geist Sans for UI text; Geist Mono for IDs, timestamps and tool names. Self-hosted through the npm `geist` package.
- Type scale (px): 12 caption, 13 label, 14 body, 16 body-strong, 20 title, 28 kpi-small, 40 kpi. Panel body text is never below 14 px.
- Every live number uses `font-variant-numeric: tabular-nums`.
- Spacing: 4 px base (4/8/12/16/24/32).
- Radius: 6 px controls, 10 px panels.

### Status palette (design D17)

| Status | Colour | Shape |
|---|---|---|
| idle | `#6B7385` | hollow circle |
| thinking | `#A5B4FC` | soft-pulse dot |
| tool | `#34D399` | solid dot |
| waiting_user | `#FBBF24` | beacon / triangle |
| error | `#F87171` | square |
| done | `#475066` | check |

- Vendor colours (Claude `#F59E0B`, Codex `#D1FAE5`) are used only for trim and avatars, never for status.
- Cyan never means a status.
- The same table drives status dots, rack LEDs, table cells and KPI sparkline stacks.

### Provenance badge (design D19)

- An 8 px glyph at the top-right of each value (superscript position):
  - real: solid dot `#6B7385`
  - derived: 1.5 px ring `#8A93A6`
  - estimated: dashed ring `#C9A86A`
- Hover or focus shows a tooltip with the provenance and the `basis` string.
- The "(est.)" suffix appears only on panel row labels, never next to the number.
- The same badge is used in KPI tiles, panels and table cells, replacing the mockup's dashed circles.

### Motion (design D20)

| Token | Duration | Used for |
|---|---|---|
| `--dur-fast` | 150 ms | hover, chips |
| `--dur-ui` | 250 ms | panel open/close, tab strip, toasts |
| `--dur-scene` | 600 ms | camera glide |
| hall enter / retire | 1.5 s / 3 s | hall lifecycle |

- One easing for everything: `cubic-bezier(0.22, 1, 0.36, 1)`.
- Numbers swap without count-up tweens.
- When `prefers-reduced-motion` is set, a `reducedMotion` store flag:
  - turns glides into instant cuts and panel transitions into fades only;
  - slows packets to 25% speed and cuts vapour and rain density to 30%;
  - removes the lightning flash.
- Chunk 04 adds the tokens and the flag. Every animated chunk checks both modes in its acceptance.

### Contrast and browser surfaces (design D21)

- Panel text is at least 4.5:1; large numerals (28 px and up) are at least 3:1. Both are measured against the rendered pixels behind the panel.
- Glass fill steps from 8% up to 72% dark when the scene is bright. The level comes from a lookup on the known day/night phase and weather (night 8%, dusk 30%, day 60%, day + heatwave 72%), with no GPU pixel readback (eng re-review D2).
- A Playwright check in forced-day and forced-night samples text against its backdrop on KPI tiles, panels and the table.
- Browser surfaces are themed from the palette: 2 px cyan focus ring with 2 px offset, `::selection` cyan at 30%, thin dark scrollbars, cyan caret.

### Keyboard and screen-reader access (design D22)

- Tab order: top bar, KPI tiles, right panel, job tracker, tab strip and table.
- Table rows and search results are the keyboard path into the scene:
  - Up/Down moves between rows; Enter selects the object in the scene and glides to it.
  - Esc deselects and returns focus to the canvas.
- The canvas has `role="application"` and an `aria-label` that summarises the campus ("6 halls, 12 sessions, 1 waiting").
- Landmarks: top bar = banner, campus = main, right panel = complementary with a heading.
- Alerts are announced: `aria-live="polite"` for info and waiting, `assertive` for errors.

### Job tracker (design D23)

The tracker shows the six stage counts with dot rows, as in the mockup. A stage opens a popover of up to 10 jobs; "View all" goes to the Sessions tab filtered by that stage.

### Full session view (design D24)

"View full session" in the agent and rack panels expands the tab strip (at most 40vh) to the Sessions tab, filtered to that session. The filter chip can be cleared, and the URL hash records it.

### Ambience menu (design D25)

Weather and day/night share one top-bar button that shows the current weather icon and sun/moon state. The dropdown holds:
- weather: Clear, Heatwave, Monsoon, Storm;
- auto-cycle on/off and its interval;
- time: Day, Night, Auto (local clock), Fast cycle.

Shortcuts D and W are unchanged.

## 5. Chunks

Each chunk: Goal, Depends on, Tasks, Acceptance, README step.
"Commit" means one Conventional Commit at the end of the chunk.

### Phase 0: Tooling

#### [ ] 01. Scaffold
- **Goal:** Empty app runs, lints, tests, builds.
- **Depends on:** none.
- **Tasks:** Create the Vite+ React-TS project with pnpm. Enable TS strict. Add Tailwind CSS v4 with tokens for dark background, glass panel, cyan `#22D3EE`, Claude amber, Codex neutral, error red, plus the section 4b type/spacing/radius tokens and Geist Sans/Mono fonts (design D16), and the status colour/shape tokens (design D17). Add Vitest with one sample test. Folder layout: `src/{app,scene,dashboard,data,sim,config}`, `sidecar/`, `scripts/`, `docs/`. Add `.editorconfig`, `.nvmrc`. GitHub Actions: install, lint, typecheck, test, build.
- **Acceptance:** `vp dev` shows a dark page titled "Synapse Horizon" in cyan. `vp lint`, `vp test`, `vp build` pass locally and in CI.
- **README:** Title, pitch, quick start, status line "Chunk 01 done". Image: `01-scaffold.png` (blank branded page).

#### [ ] 02. Browser matrix and screenshot pipeline
- **Goal:** Every later chunk can be smoke-tested in three browsers and photographed automatically.
- **Depends on:** 01.
- **Tasks:** Playwright with Chromium, WebKit, Firefox projects. Smoke test: page loads, no console errors. `scripts/shots.ts` + `shots.config.ts` with the URL contract above (`freeze`, `seed`, `view`). Add `shots` and `e2e` scripts, run with `vp run shots` / `vp run e2e`. CI job runs smoke in Chromium and Firefox. Add `e2e:local` (all three engines, plus later leak/perf/shots) for the Mac (eng review D6).
- **Acceptance:** `vp run e2e` green in Chromium and Firefox in CI; `vp run e2e:local` green in all three engines on the Mac. `vp run shots` writes `docs/img/02-pipeline.png` under 200 KB. Running it twice gives images within a 0.5% pixel-diff threshold (eng review T2).
- **README:** "Testing and screenshots" section explaining `vp run e2e` and `vp run shots`.

#### [ ] 02b. Versioning, release pipeline and downloadable build
- **Goal:** Every merged PR that changes behaviour produces a versioned GitHub Release with builds a user can download and start without any dev setup (D19).
- **Depends on:** 02.
- **Tasks:**
  - **Version handling.** `package.json` `version` is the single source of truth. Vite injects it as `__APP_VERSION__`; the app shows it in the user menu, and the binary prints it with `--version`. `CHANGELOG.md` is generated.
  - **PR discipline.** CI checks that the PR title is a Conventional Commit (`feat:`, `fix:`, `docs:`, ...), since squash-merge uses it as the commit message. Add a PR template with the chunk's acceptance checklist.
  - **Release workflow** (`.github/workflows/release.yml`, on push to `main`):
    1. Run `vp check` and `vp test`.
    2. Run semantic-release with the commit-analyzer, release-notes, changelog, npm (version bump only, no publish), git and github plugins. It writes the release commit `chore(release): X.Y.Z [skip ci]`, tags `vX.Y.Z` and creates the GitHub Release.
    3. A build matrix runs only when a release was made.
    - Permissions: `contents: write`. If `main` is protected, allow the release bot to push the release commit.
  - **Local release script** `vp run release:dry`: runs semantic-release in `--dry-run` so you can see the next version and notes before merging.
  - **Server entry** `sidecar/cli.ts`: serves the built app from embedded assets on `127.0.0.1:4317` and opens the default browser.
    - Flags: `--port`, `--no-open`, `--version`, `--help`.
    - If the port is busy, try the next 10 ports and print the chosen URL.
    - In Phase 0 it serves the app only; chunk 14 adds the log watcher and WebSocket to this same entry.
  - **Single executable build** `vp run build:bin`:
    1. `vp build` builds the web app.
    2. The CLI is bundled to one CommonJS file, with only pure-JS dependencies so nothing native has to be embedded. That means chokidar v4 (no fsevents) and `ws`.
    3. The `dist/` files are embedded as SEA assets (`sea-config.json`).
    4. The SEA blob is injected into a copy of the pinned Node binary with `postject`.
    5. On macOS: remove the signature, inject, then ad-hoc sign (`codesign --sign -`); Apple Silicon will not run the binary otherwise.
    - Output names: `synapse-horizon-<version>-<os>-<arch>` (`.exe` on Windows), plus `SHA256SUMS.txt`.
  - **Build matrix:** macos-14 (arm64), macos-13 (x64), ubuntu-latest (x64), windows-latest (x64). Each runner builds with its own Node binary (no cross-compiling) and uploads to the release.
  - **CONTRIBUTING.md:** branch naming, one PR per chunk, Conventional Commit PR titles, what CI runs vs `vp run e2e:local` on the Mac, updating README and screenshots per chunk, how releases and versions happen, and that only maintainers merge to `main`.
- **Acceptance:**
  - `vp run release:dry` prints the next version and release notes from the commits since the last tag.
  - A `docs:`-only PR merges with no release.
  - A `feat:` PR merges and produces a minor bump, a tag, a CHANGELOG entry and a GitHub Release with 4 binaries and `SHA256SUMS.txt`.
  - In each matrix job, a smoke step starts the binary with `--no-open --port 4400`. `curl http://127.0.0.1:4400/` returns 200 with the app HTML, and `--version` prints the tag version.
  - On your Mac, the downloaded arm64 binary starts after the Gatekeeper right-click > Open step and serves the app. A machine with no Node installed runs it (checked once on a clean VM or a user account without Node).
  - A PR with a non-conventional title fails the title check.
- **README:** Add the sections "Download and run" (per-OS steps, unsigned-binary first-run notes: macOS right-click > Open or `xattr -d com.apple.quarantine <file>`, Windows SmartScreen "More info > Run anyway", flags), "Development setup" and "Contributing" (short, linking CONTRIBUTING.md), plus "Versioning and releases". Add a release badge. Image: `02b-release.png` (screenshot of the first GitHub Release page with the 4 assets), captured manually and stored in `docs/img/`.

### Phase 1: Rendering spike (gate)

#### [ ] 03. R3F vs direct Three.js spike
- **Goal:** Pick the integration with numbers, not opinion.
- **Depends on:** 02.
- **Tasks:** Two throwaway routes, `/spike/r3f` and `/spike/vanilla`, each rendering the same thing: 12 hall boxes, 200 instanced racks, 3,200 instanced LEDs with per-frame colour updates driven by a fake store at 10 updates/s, MeshStandardMaterial flat-shaded, one shadow-casting light, bloom on/off toggle. A churn button adds and removes 6 halls 50 times. Record per browser: median fps, p95 frame time, `renderer.info.memory.geometries/textures` and `renderer.info.programs` before and after churn, JS heap where available (Chromium). Measure on the target machine (M1 Air class) in Chrome, Safari, Firefox.
- **Acceptance:** Results table committed to `docs/adr/0001-render-integration.md` with a decision and reasoning. Both routes hit 60 fps median with bloom off in all three browsers, or the ADR states which one fails and why. Geometry/texture counts return to baseline after churn for the chosen approach.
- **README:** Add "Architecture" stub noting the chosen integration and link to the ADR. Image: `03-spike.png` (spike scene).
- **Note:** Delete spike routes in chunk 04. Keep the ADR.

### Phase 2: Scene foundation

#### [ ] 04a. Scene foundation: canvas, camera, lights, materials
- **Goal:** One persistent 3D canvas with the final look language (split from 04, eng re-review D1).
- **Depends on:** 03 (decision).
- **Tasks:** Full-viewport canvas behind a DOM overlay layer. Orthographic isometric camera (true iso angles), perspective toggle that keeps framing. Lighting rig: hemisphere + one directional with soft shadow plus low night fill, tuned to match the approved mockup (design D14). Material library `scene/materials.ts`: dark concrete/slate building greys, warm window and rack-LED emissives, accent cyan emissive for fibre lines (bloom), vendor colours, shared instances only (no per-mesh materials). Ground plane with subtle grid. Dev perf HUD (fps, draw calls, triangles, `renderer.info`). Quality tier object (high/medium/low) controlling shadows, bloom, pixel ratio. Motion tokens and a `reducedMotion` store flag from `prefers-reduced-motion` (section 4b, design D20). WebGL-unavailable card and context-lost auto-restore with toast (section 4b, design D11).
- **Acceptance:** Test cube and ground render in all three browsers. Toggle switches ortho/perspective without jump. Perf HUD shows under 10 draw calls. Forcing WebGL off (test flag) shows the WebGL card; `WEBGL_lose_context` triggers restore and the toast (design D11). `reducedMotion` flag follows the OS setting. Smoke test checks canvas exists and no WebGL errors.
- **README:** Image `04a-scene.png`. One line on the art direction.

#### [ ] 04b. UI shell: tokens, glass panel, layout, loader
- **Goal:** The empty dashboard frame every later panel lives in (split from 04, eng re-review D1).
- **Depends on:** 04a.
- **Tasks:** Section 4b tokens wired in (type, spacing, radius, status palette from chunk 01) and themed focus ring, selection, scrollbars and caret, plus adaptive glass fill driven by day/night phase and weather, no GPU readback (section 4b, design D21, eng re-review D2). `GlassPanel` component (backdrop blur, 8% white fill, 1px 12% border, fps-aware fallback to a solid 85% dark panel under 45 fps). Empty layout shell with the section 4b slots (top bar, KPI row, right panel, job tracker, tab strip) that updates the store `safeArea` on panel open/close and on window resize via ResizeObserver (eng re-review E6); pointer events blocked by panels and passed through gaps (design D18, D5). Scene loader (wordmark plus thin cyan progress line) until the first frame (design D10).
- **Acceptance:** Empty layout shell matches the section 4b diagram at 1280x720 and 1920x1080; glass panels stay readable over bright and dark scene regions; the fallback triggers and recovers in Firefox (design D18). `safeArea` updates on resize and on panel toggle (unit test on the rect). Loader shows until first frame.
- **README:** Image `04b-shell.png`.

#### [ ] 05. Camera controls and camera rig
- **Goal:** Map-style navigation and a programmatic glide API.
- **Depends on:** 04b.
- **Tasks:** Left-drag pan, right-drag free rotate, scroll zoom (ortho zoom, not dolly), clamped to campus bounds and zoom range. `cameraRig.glideTo(target, zoom, ms=600)` using the D20 easing (instant cut when `reducedMotion`), interruptible by user input, framing the target inside the store `safeArea` rect (section 4b, design D5). Expose in a dev menu for manual testing.
- **Acceptance:** Pan, rotate, zoom work with mouse and trackpad in all three browsers. Camera cannot leave bounds. Dev-menu glide reaches target in about 600 ms and cancels on drag. Context menu suppressed on right-drag.
- **README:** "Controls" line.

### Phase 3: World building (static, no data)

#### [ ] 06. Parametric data hall
- **Goal:** One hall built in code from parameters.
- **Depends on:** 05.
- **Tasks:** `buildHall({ slots: 16, rows: 2 })`: floor slab, walls, cutaway roof (roof hidden or sliced above a height, toggleable), cold-aisle and hot-aisle floor tiles, door, floor sign plane for the hall letter and project name (canvas texture, shared atlas). Low poly, merged geometry for static parts.
- **Acceptance:** One hall renders, roof cutaway toggle works, hall sign text is at least 12 CSS px at default zoom (design D7). Static hall costs 3 or fewer draw calls.
- **README:** Image `06-hall.png`.

#### [ ] 07. Instanced racks and LEDs
- **Goal:** Racks and LEDs as instances with per-instance colour and intensity buffers.
- **Depends on:** 06.
- **Tasks:** One InstancedMesh for rack bodies, one for blade LEDs (e.g. 8 per rack), per-instance colour attribute. Slot allocator inside a hall (stable slot per key). Dev slider for rack count 0-16 and a fake load pulse per rack.
- **Acceptance:** Slider adds and removes racks without frame hitches. Draw calls do not grow with rack count. LEDs pulse with fake load.
- **README:** Image `07-racks.png`.

#### [ ] 08. Campus layout and site furniture
- **Goal:** Ground plan with hall slots and the static campus.
- **Depends on:** 07.
- **Tasks:** Campus grid with a hall-slot allocator (deterministic positions for up to 12 halls, A/B fixed first), roads, parking with instanced parked cars, security gate with barrier, loading dock with bay doors. Waypoint graph for vehicles (used later): gate, dock, each hall door.
- **Acceptance:** Two halls (A, B) plus site furniture render. Dev toggle shows the waypoint graph. Total draw calls under 40.
- **README:** Image `08-campus.png` as new hero image.

#### [ ] 09. Cooling plant
- **Goal:** Cooling towers, chillers, vapour.
- **Depends on:** 08.
- **Tasks:** Low-poly towers and chillers. Vapour as instanced billboards with a soft shader, rate controlled by a `duty` value 0-1 (dev slider). Fan rotation speed follows duty.
- **Acceptance:** Duty slider visibly ramps vapour and fans. Vapour costs one draw call per tower group. No transparency sorting artefacts in Safari or Firefox.
- **README:** Image `09-cooling.png`.

#### [ ] 10. Power and network infrastructure
- **Goal:** Substation, generators, fuel tanks, fibre vault, fibre lines.
- **Depends on:** 08.
- **Tasks:** Substation (transformers, fence), generators with exhaust stacks, fuel tanks. Fibre entry vault. Fibre lines as curved tubes from vault to each hall slot (rebuilt when hall set changes, geometry disposed). Packet layer stub: instanced glowing spheres moving along a curve at a dev-set rate.
- **Acceptance:** All parts render. Packets travel smoothly along lines. Removing a hall slot in the dev menu removes its fibre line and `renderer.info.memory.geometries` returns to the previous count.
- **README:** Image `10-power-network.png`. "World" gallery section with images 06-10.

### Phase 4: Data layer

#### [ ] 11. Schema, store, and steady mock source
- **Goal:** One store fed by a mock stream, visible in a debug panel.
- **Depends on:** 01 (can run in parallel with phases 2-3).
- **Tasks:** `schema.ts` with zod types from section 2. Zustand store: incremental reducers into `projects`, `sessions`, `subagents`, `jobs` (authoritative), plus a capped ring buffer for the recent timeline only (eng review Q1). Source interface `{ start, stop, onEvents }` delivering events in batches; reducers apply a whole batch in one store update so subscribers fire once per batch, not once per event (eng review P3). Seeded deterministic mock generator, scenario `steady` (3 projects, Claude + Codex mix, a few subagents). Dev menu source switch. Raw debug panel listing sessions.
- **Acceptance:** Unit tests: same seed gives same event sequence; reducers produce expected session counts and token totals for a fixed fixture. Debug panel updates live. No React re-render storm: React Profiler shows the debug panel re-rendering at most a few times per second.
- **README:** "Data sources" section (mock only for now). Image `11-store-debug.png`.

#### [ ] 12. Mock scenarios and replay clock
- **Goal:** Every later behaviour can be triggered on demand.
- **Depends on:** 11.
- **Tasks:** Scenarios: `steady`, `burst` (one parent spawns 10 subagents), `churn` (projects appear and vanish every 20 s), `overflow` (one project grows to 40 sessions), `errors` (error storm and recovery), `codex-only`, `waiting` (sessions waiting on user). Replay clock with 1x/10x/60x and pause, shared by mock and file replay. Scenario and speed in URL params. Switching source (live / replay / mock) clears aggregates, ring buffer and scene halls through the chunk 20 dispose path before the new source starts (eng re-review E3); test: live then mock then live gives totals equal to live alone (G12). Replay bar play/pause and 1x/10x/60x drive the store clock (G18). The top-bar mode chip and replay bar (section 4b, design D8) drive the same clock; the dev menu only adds seed and debug toggles.
- **Acceptance:** Each scenario produces its expected store shape within 60 s at 10x (asserted by unit tests on the reducer output). Pause freezes all derived values.
- **README:** Table of scenarios and how to select them.

#### [ ] 13. Derived and estimated metrics with provenance
- **Goal:** Every metric is a `Metric` with value, unit, provenance, basis.
- **Depends on:** 12.
- **Tasks:** Session lifecycle inference (session end after 30 min idle, status, waiting_user) computed in the store from the single store clock, so live and replay behave the same (eng review A3). Selectors for tokens/min, cost (price table), rack kW, inlet/hot-aisle °C (lagged), hall heat, cooling duty, job stage derivation (section 2 job model). `ProvenanceBadge` component per section 4b (8 px top-right glyph: solid dot `#6B7385` = real, ring `#8A93A6` = derived, dashed ring `#C9A86A` = estimated; tooltip on hover and focus showing `basis`; "(est.)" only on panel labels) (design D19). Type-level enforcement: selectors return `Metric` only, and dashboard formatters and `<MetricValue metric=...>` accept only `Metric` (no `number` overload), so a raw number fails `vp check`. Every rendered metric carries `data-metric` (eng review D5).
- **Acceptance:** Unit tests for every formula with fixed inputs. A session idle-ends at the same sim time at 1x and 60x replay (G6). An unknown model shows cost "unknown", never 0 (G7). Debug panel shows each metric with the correct badge. A type test (`// @ts-expect-error` on passing a `number`) proves the formatter rejects raw numbers. A Playwright audit asserts every `[data-metric]` element contains a provenance badge.
- **README:** "Provenance legend" section with badge image `13-provenance.png` and the estimation formulas.

#### [ ] 14. Log server plugin: watcher and WebSocket stream
- **Goal:** The dev server itself tails real log folders and streams to the app (eng review D1).
- **Depends on:** 11.
- **Tasks:** `sidecar/plugin.ts` Vite plugin (`configureServer`) plus the existing `sidecar/cli.ts` from chunk 02b (the release binary entry), which gains the same watcher and WebSocket logic: config file with log roots (defaults `~/.claude/projects`, `~/.codex/sessions`), chokidar watch, per-file byte offset tailing (handles partial lines and file rotation), 24 h backfill, WebSocket endpoint on the dev-server origin, heartbeat. Reject WebSocket upgrades and `POST /api/import` whose `Origin` is not the app origin, and require a per-run random token injected into the served page (eng review A1). At this stage it streams raw line counts per file only (parsers come next). Backfilled events carry `backfill: true`; they update counts silently and never toast or announce (eng re-review E4); test: a backfill containing 20 errors raises 0 toasts and 0 live announcements (G13). Server sends backfill progress `{done, total}` files and the pill shows "Catching up n/N files" (design D10). Events are sent in batches (up to 500 per message) so a 24 h backfill does not flood the socket (eng review P3). Server keeps a per-file byte-offset cursor; on reconnect the client sends its last cursor and the server resumes from it (eng review Q1). App shows a connection pill (connected / reconnecting / off). When no log files are found, show the first-run card from section 4b (design D9). When the server is down, show the amber banner under the top bar (design D11).
- **Acceptance:** Appending a line to a watched file shows up in the app within 1 s. Restarting `vp dev` shows "reconnecting" in an open tab, then recovers without duplicates. A test page on another origin (e.g. `http://127.0.0.1:<other port>`) cannot open the WebSocket or call the import endpoint; a request without the token is refused. Server refuses non-localhost connections. Unit tests for the tailer with partial-line, truncated-file and rotated-file fixtures (G1). The release binary (chunk 02b) built from this chunk tails real logs too: the CI smoke test opens the WebSocket with the injected token and receives a heartbeat. Log roots resolve with `os.homedir()` on macOS, Linux and Windows. Backfill skips files with mtime older than 24 h without reading them (G2). Restarting `vp dev` with a tab open gives identical token totals (G4). A missing or unreadable log root shows its reason in the pill and does not crash (G5).
- **README:** Quick start notes that `vp dev` also starts the log watcher; `vp run serve` for the built app. "Data sources and privacy" section: what is read, localhost only.

#### [ ] 15. Claude Code parser
- **Goal:** Claude JSONL lines become AgentEvents.
- **Depends on:** 13, 14.
- **Tasks:** Inspect your real files first and record the observed format in `docs/log-formats/claude.md` (versions seen). Parser as a pure Node module in `sidecar/parsers/`. Map: session start, turns, tool calls/results, usage tokens, model, cwd, sidechain/subagent links to parent, TodoWrite to currentTask, Edit/Write paths to filesTouched. Parsers emit only facts from lines; session end, status and waiting inference live in the store and use the store clock (eng review A3). Redaction (120-char task, paths outside project, secret patterns from `sidecar/parsers/redact.ts`: key prefixes, bearer tokens, 32+ char high-entropy strings, eng review D2). Unknown line types counted, not fatal. Redacted fixtures committed.
- **Acceptance:** Fixture tests cover: plain session, session with subagents, tool error, malformed line, unknown type, each secret pattern redacted, and a long git SHA in task text that is NOT redacted. Pointing the log server at your real folder shows your actual sessions with correct projects and token totals that match a manual count on one file within 1%.
- **README:** "Supported logs" with Claude format notes and known gaps.

#### [ ] 16. Codex CLI parser
- **Goal:** Codex rollout JSONL becomes AgentEvents.
- **Depends on:** 15.
- **Tasks:** Same as 15 for Codex: record observed format in `docs/log-formats/codex.md`, map session meta, cumulative token counts to deltas, function/shell calls, model, cwd. Subagents with no recoverable parent get `parentKnown=false`. Update the feasibility table in this plan with what was actually found.
- **Acceptance:** Fixture tests as in 15, plus: restart mid-file gives the same token totals as one uninterrupted read (eng review Q4). Real Codex sessions appear in the same hall as Claude sessions for the same repo (D5).
- **README:** Codex notes, updated feasibility table.

#### [ ] 17. Drag-and-drop file import replay
- **Goal:** Drop log files on the page and replay them through the local log server (eng review D1).
- **Depends on:** 16.
- **Tasks:** Drop zone and file picker accepting `.jsonl` (multiple files). Drop switches the mode chip to `REPLAY` and shows the replay bar (design D8). Upload to `POST /api/import` (streamed, size-capped), parse in Node with the same parsers, return events to the replay clock from 12. When the server is not running, the drop zone says so instead of failing silently.
- **Acceptance:** Works in Chrome, Safari, Firefox (Playwright test drops a fixture). A 50 MB log imports without freezing the UI (main thread long tasks under 100 ms). Drop with the server stopped shows a clear message. Files over the size cap, malformed JSONL and binary files get a clear error and import nothing (G3).
- **README:** "Replay a log" instructions.

### Phase 5: Data-driven scene and hall lifecycle

#### [ ] 18. Store-to-scene binding for racks
- **Goal:** Racks reflect real sessions.
- **Depends on:** 10, 13.
- **Tasks:** Transient store subscription writes rack instance data each frame: one rack per main session in its project hall, blade LEDs lit per active subagent, LED pulse rate and brightness from tokens/min, vendor colour trim, status colours from the section 4b status palette (design D17), and a slow amber-white beacon above racks in `waiting_user` (design D6). Hall billboard labels (`aria-hidden`, eng re-review E7; project, session count, worst status) show below the zoom threshold and fade to rack detail above it (section 4b, design D7). Dormant halls use the section 4b style: LEDs off, desaturated materials, grey "No sessions" sign (design D9). Static halls A and B only for now (overflow next chunk).
- **Acceptance:** `steady` mock shows racks matching the debug panel counts. `burst` lights 10 blades in one rack. Zero React re-renders of scene components per frame, asserted by a render-count test hook in a Vitest test of the binding (G11).
- **README:** Image `18-live-racks.png`.

#### [ ] 19. Hall reconciler (pure logic)
- **Goal:** Deterministic mapping from projects to halls, tested without rendering.
- **Depends on:** 13.
- **Tasks:** `reconcileHalls(prevLayout, projects, now) → nextLayout` pure function. Rules: halls A and B always present; new project takes the next free letter in order of first appearance; more than 16 racks adds overflow `A2`, `A3` in the lowest free slot, with a parent link (eng review D3); shrinking back removes overflow halls last-in-first-out; a project with no active session for 10 min enters `retiring`, then `removed`; letters are stable while a hall exists; freed letters are reused only after removal. Output carries `entering | active | retiring` states for animation.
- **Acceptance:** Table-driven unit tests for: first project, two projects, 40 sessions (3 halls), shrink back, retire after grace, project returning during grace (cancels retire), letter reuse, 12-hall cap behaviour (defined: excess projects queue on an "Unassigned" board and raise an alert), per-project cap of 3 halls with a "+N" badge for sessions past 48 (60 sessions gives 3 halls + "+12"; badge clears when load drops) (eng review D4).
- **README:** "Hall lifecycle" section with the rules as a short list.

#### [ ] 20. Scene reconciliation, animations, and leak test
- **Goal:** Halls appear, overflow, and disappear at runtime with no leaks.
- **Depends on:** 18, 19.
- **Tasks:** Scene layer diffs layouts: `entering` halls rise from the ground (1.5 s), `retiring` halls power down LEDs then sink and fade (3 s), then all owned geometry, materials, and textures are disposed. Fibre lines, signs and overflow conduit lines (cyan, parent to overflow) rebuilt per change; existing halls never move. Delivery truck drives gate to dock to hall door on rack or hall creation (D12), queued if several at once. Automated leak test: Playwright runs `churn` at 60x for 5 min, reads `renderer.info` and heap (Chromium) via a debug hook.
- **Acceptance:** `overflow` scenario creates `A2` and `A3` and removes them when load drops. Leak test: geometry and texture counts return to baseline (plus or minus 0) after churn; Chromium heap growth under 10%. Runs in all three browsers via `vp run e2e:local` on the Mac (eng review D6). A project that returns while its hall is sinking cancels the retire and the hall rises again with no leaked objects (G10).
- **README:** Image `20-overflow.png` (hall with overflow). Short GIF optional, same folder.

#### [ ] 21. Agents and subagents
- **Goal:** Visible agents with clear parent links.
- **Depends on:** 20.
- **Tasks:** Instanced low-poly capsule avatars: main agents stand at their rack, vendor-coloured. Subagents spawn at the loading dock, ride a cart or walk to the parent's hall, and return to the dock and despawn when finished (loaded and unloaded). Each subagent wears its parent's colour-coded tag; selecting either shows a tether line. `parentKnown=false` subagents get a grey "?" tag and wait at the dock.
- **Acceptance:** `burst` shows 10 subagents leaving the dock for the right hall and returning. Instance count tracks store count exactly. 400 agents keep 60 fps in Chrome on the target machine.
- **README:** Image `21-agents.png`.

#### [ ] 22. Ambient life from real signals
- **Goal:** Packets, heat, cooling ramp, technician cart.
- **Depends on:** 21.
- **Tasks:** Packets along fibre lines with rate proportional to that hall's tokens/min. Heat wash: shader tint on aisle tiles from hot-aisle °C (amber to red). Cooling tower duty bound to total hall heat. Technician cart: on agent error, drives the waypoint graph to the rack, plays a node-swap animation, stays until the error clears (D12). Multiple errors queue with a cap of 3 carts.
- **Acceptance:** `errors` scenario dispatches carts to the right racks and they leave when errors clear. Heat wash and tower vapour visibly follow load in `burst`. Every animated effect reads only store values (no hidden randomness), so frozen screenshots are deterministic.
- **README:** Image `22-life.png`.

#### [ ] 23. Job flow
- **Goal:** Jobs visibly move from queue to racks and complete.
- **Depends on:** 22.
- **Tasks:** Queue board near the dock showing pending jobs as small tokens. A job entering Running flies to its rack; Checkpoint flashes the rack; Evaluating shows a scanning ring; Done pops a cyan pulse. Cap visible tokens (e.g. 60) and aggregate the rest.
- **Acceptance:** Job token transitions match the derived stages in the debug panel for a fixture session. No more than 60 tokens rendered at once.
- **README:** Image `23-jobs.png`.

### Phase 6: Interaction

#### [ ] 24. Picking, selection ring, labels, glide
- **Goal:** Click anything important and the camera goes there.
- **Depends on:** 23.
- **Tasks:** Raycasting with instance IDs for racks, agents, carts; object picking for halls, towers, generators. Selection model in the store (`{kind, id}`). Moving instanced meshes (agents, carts, job tokens) recompute their bounding sphere each frame they move, or picking uses store positions on the CPU, so raycasts never miss moved instances (eng review P2). Selection ring (cyan, animated) and HTML label above target. Click = select + glide, double-click = zoom close, Esc = deselect and return focus to the canvas. Canvas gets `role="application"` with a live campus summary `aria-label` (design D22). Hover highlight. URL hash sync for selection and camera area.
- **Acceptance:** Every entity kind is selectable in all three browsers. Reloading with a hash restores the selection. Picking a moving agent tracks it with the ring. Picking cost under 1 ms per click with 400 agents. Clicking an agent that has walked away from its spawn point still selects it (G8, perf P2). Removing the selected entity (hall retires) closes the panel cleanly (G9).
- **README:** "Interaction" section. Image `24-selection.png`.

#### [ ] 25. Area switcher and shortcuts
- **Goal:** Fly between Halls, Cooling, Power, Network.
- **Depends on:** 24.
- **Tasks:** Camera presets per area computed from current layout (Halls preset reframes as halls are added). Keyboard: 1-4 areas, `/` search focus, D day/night, W weather cycle, Esc deselect. Shortcut help overlay on `?`, combined with the scene legend; the legend auto-shows once on first visit (section 4b, design D13). With localStorage blocked, the legend still works and shows once per page load without errors (G19).
- **Acceptance:** Each preset frames its area fully inside the safe area (section 4b) at 1280x720 and 1920x1080, with the right panel open and closed. Shortcuts do not fire while typing in inputs.
- **README:** Shortcut table.

#### [ ] 26. Agent live presentation panel
- **Goal:** Clicking an agent shows what it is doing, live.
- **Depends on:** 24.
- **Tasks:** Agent view inside the right-panel slot, using `GlassPanel` from chunk 04 (design D18): "Copy session ID" and "Copy project path" buttons (design D13), vendor, model, status with duration, current task, tokens/min sparkline (30 min), token and cost totals, last 10 tool calls as a timeline of plain rows (section 4b, design D15), files touched list, subagent tree with parent link (clickable), and a "View full session" button that expands the tab strip to the Sessions tab filtered to this session, with a clearable filter chip recorded in the URL hash (design D24). All numbers through `MetricValue` with badges.
- **Acceptance:** Values update live without layout jumps. Clicking a subagent in the tree selects it in the scene. Panel handles `parentKnown=false`, no tokens yet, and ended sessions.
- **README:** Image `26-agent-panel.png`.

### Phase 7: Dashboard

#### [ ] 27. Top bar contents
- **Goal:** Fill the top bar slot from chunk 04 (design D18).
- **Depends on:** 25.
- **Tasks:** Landmarks and Tab order per section 4b (design D22). Top bar (inside the chunk 04 shell, using `GlassPanel`): logo, search box (wired in 32), area switcher, data-mode chip with replay bar (design D8), attention chip ("<n> waiting · <m> error", section 4b, design D6), Ambience menu (weather + day/night in one dropdown, wired in 34/35, design D25) and live clock, user avatar with local username. No separate alerts bell: the attention chip is the single alert entry point (design D26). 
- **Acceptance:** Every top-bar control works; nothing overflows at 1280 px wide. Canvas interaction still works around the top bar.
- **README:** Image `27-topbar.png`.

#### [ ] 28. KPI cards
- **Goal:** Three KPI cards.
- **Depends on:** 27.
- **Tasks:** Claude card and Codex card: active sessions, 30-min stacked sparkline by status, tokens/min, estimated cost today. Total card: running agents and subagents, split main/sub, unknown-parent count. All three tiles show a shimmer skeleton until backfill completes (design D10).
- **Acceptance:** Card numbers equal debug panel numbers for a fixed seed (unit test on selectors, e2e on DOM). Badges present on every number.
- **README:** Image `28-kpis.png`.

#### [ ] 29. Right-hand detail panel per entity
- **Goal:** One detail panel that adapts to the selected kind.
- **Depends on:** 26, 27.
- **Tasks:** Views for rack (ID like `A-R07`, session, kW, inlet/hot-aisle °C, blades), hall (project, racks used/16, heat, overflow chain), cooling tower (duty, approach temp), generator (state, fuel %, last test), cart (assigned rack, ETA), agent (reuse 26). All estimated values badged.
- **Acceptance:** Each kind renders with no empty fields in `steady`. Provenance badges correct per the feasibility table.
- **README:** Image `29-detail.png`.

#### [ ] 30. Job tracker
- **Goal:** Bottom-left tracker with six stages.
- **Depends on:** 27.
- **Tasks:** Columns Queued, Scheduled, Running, Checkpoint, Evaluating, Done, showing counts with dot rows as in the mockup. Click, or Enter when focused, on a stage opens a popover above it listing up to 10 jobs (project, agent, age, mono IDs); "View all" opens the Sessions tab filtered by stage; clicking a job selects its agent. Done list capped to last 20 (design D23).
- **Acceptance:** Counts match the store for a fixture. Stage labels marked `derived`. Popover lists the right jobs per stage and is keyboard reachable.
- **README:** Image `30-jobs.png`.

#### [ ] 31. Tabbed agent data table
- **Goal:** Dense data view.
- **Depends on:** 27.
- **Tasks:** Tabs: Sessions, Subagents, Tool calls, Token usage by model, Errors, Projects. Sortable, virtualised rows (TanStack Table + virtual or equivalent), row click selects in scene. Sessions tab supports a session filter chip set by "View full session" (design D24). Rows are focusable: Up/Down to move, Enter to select and glide (design D22). The tool-call tab reads the ring buffer, so its cap (default 50,000 events) must cover the 5,000-row target (eng review P4). Collapsible.
- **Acceptance:** 5,000 tool-call rows scroll at 60 fps. Sorting is stable. Row click flies the camera.
- **README:** Image `31-table.png`.

#### [ ] 32. Search and alerts
- **Goal:** Find anything; get told when something needs you.
- **Depends on:** 29, 31.
- **Tasks:** Fuzzy search over projects, session IDs, rack IDs, agents, tool names; dropdown and toast behaviour per section 4b (design D12); Enter flies to the result. Alert rules: agent error, waiting on user over 2 min, estimated rack temp over 35 °C, overflow hall created, log parse failure, hall cap reached. Only live (non-backfill) events raise toasts or announcements (E4); outside live mode toasts and alert rows carry a `REPLAY` or `MOCK` tag (E5); tests for both (G14). Keyboard-only e2e: Tab to the table, Down, Enter selects and glides to the entity (G16). Attention chip counts match the store and clicking it flies to the oldest waiting agent (G17). Alerts announced via `aria-live` (polite for info/waiting, assertive for errors) (design D22). Alert list with acknowledge, toasts capped at 3 with "+N more alerts" overflow (design D12), alert counts in the top-bar attention chip, the single alert entry point, with an alert panel tabbed "Needs you" / "All alerts" (design D6, D26).
- **Acceptance:** Each rule fires in the matching mock scenario (`errors`, `waiting`, `overflow`) and clears when the condition ends. Search returns a rack ID match in under 50 ms with 400 agents.
- **README:** Alerts list.

#### [ ] 33. Extra agent visualisations
- **Goal:** Surface more agent information where it adds value.
- **Depends on:** 31.
- **Tasks:** Pick from these proposals (each is a small panel or tab, each independently shippable):
  1. Session Gantt: one lane per session, coloured by status over the last hour.
  2. Subagent tree view: parent with children, durations, token share.
  3. Tool-call heat strip: tool name x time, intensity = call count.
  4. Model mix: share of tokens by model per vendor.
  5. Context fill gauge per session (from cumulative input + cache tokens vs model window, `estimated`).
  6. Cache efficiency: cache-read share of input tokens (`derived`).
  7. Files hotspot list: most-touched files per project.
  8. Waiting-on-you queue: sessions blocked on the user, oldest first. **Required** (design D6): the "Needs you" tab of the attention-chip alert panel (design D26); Enter or click flies to the agent.
- **Acceptance:** Each chosen view has a unit test on its selector and an e2e render check.
- **README:** Gallery images `33-*.png`.

### Phase 8: Extras and polish

#### [ ] 34. Day/night cycle
- **Goal:** Animated lighting cycle.
- **Depends on:** 27.
- **Tasks:** Sun angle and colour from local time, sky gradient, night mode raises emissive LEDs, hall lights, road lamps. Day / Night / Auto (local clock) / Fast cycle (1 day = 2 min) live in the top-bar Ambience menu (design D25); shortcut D still cycles.
- **Acceptance:** Smooth transition, no frame drops. Scene stays readable at night. Contrast check passes in forced-day and forced-night: panel text at least 4.5:1, large numerals at least 3:1 against the rendered backdrop (design D21). Screenshot views fixed at noon via `freeze`.
- **README:** Day and night images `34-day.png`, `34-night.png`.

#### [ ] 35. Weather states
- **Goal:** Clear, Heatwave, Monsoon, Storm, visual and panel only.
- **Depends on:** 34.
- **Tasks:** Weather section of the Ambience menu (design D25) with manual select and auto-cycle (configurable interval); shortcut W still cycles. Heatwave: heat shimmer, towers shown at max duty, warmer grade. Monsoon: instanced rain, wet ground tint. Storm: rain, lightning flashes, wind on vapour, generator test sequence (generators spin up, lights flicker 1 s, test log in panel). Weather panel with condition, outside temp (estimated), and generator test log. Assert simulation independence (D13).
- **Acceptance:** Unit test: switching weather changes no store value outside the `weather` slice. Rain costs one draw call. Each state looks distinct in screenshots.
- **README:** Image per state `35-<state>.png`.

#### [ ] 36. Cross-browser performance pass
- **Goal:** Meet the budget in all three browsers.
- **Depends on:** 35.
- **Tasks:** Perf scenario: 12 halls, 200 racks, 400 agents, storm, night. Measure fps and p95 frame time in Chrome, Safari, Firefox on the target machine. Auto quality tiering (shadows, bloom, pixel ratio, vapour density, glass fallback) driven by measured fps with hysteresis. Draw-call and triangle budgets enforced by a test that fails CI when exceeded.
- **Acceptance:** Measured on the Mac via `vp run e2e:local` (eng review D6). 60 fps median at high or auto-dropped tier in all three; never under 30 fps p95. Results table appended to `docs/adr/0002-perf.md`.
- **README:** "Performance" section with the results table.

#### [ ] 37. Provenance audit, accessibility, final README
- **Goal:** Ship-ready polish.
- **Depends on:** 36.
- **Tasks:** Walk every panel and confirm every number has the right badge versus the feasibility table. Keyboard focus order, visible focus rings, colour contrast on glass. Audit that every animated chunk honours the reduced-motion flag from chunk 04 (design D20). Error states: log server down, empty logs, parse failures. Final README pass: hero image, full gallery, architecture diagram, configuration, known limits.
- **Acceptance:** Audit checklist committed and fully ticked. axe-core e2e reports no serious issues on the dashboard. Fresh clone + README instructions reach a working app.
- **README:** Final version per section 4 skeleton.

---

## 6. Dependency summary

```text
01 → 02 → 02b (release) ; 02 → 03 (gate) → 04a → 04b → 05 → 06 → 07 → 08 → 09
                                         └→ 10
01 → 11 → 12 → 13 → 15 → 16 → 17        (data track, parallel to 04-10)
     11 → 14 ─────┘
10 + 13 → 18;  13 → 19;  18 + 19 → 20 → 21 → 22 → 23
23 → 24 → 25, 26;  25 → 27 → 28, 29(+26), 30, 31 → 32(+29), 33
27 → 34 → 35 → 36 → 37
```

The data track (11-17) can run alongside world building (04-10) in a separate branch or worktree, since they share no files after chunk 01.

---

## 7. Risks and early decisions

| Risk | Why it matters | Mitigation | Settled in |
|---|---|---|---|
| R3F vs vanilla | Gates every scene chunk | Measured spike with churn test, ADR | 03 |
| Unsigned binaries | macOS Gatekeeper and Windows SmartScreen warn or block on first run | README first-run steps; ad-hoc signing on macOS so arm64 runs; Apple Developer ID notarisation is a later option | 02b |
| Native modules in the single executable | SEA cannot load native addons such as fsevents | Pure-JS dependencies only (chokidar v4, `ws`), checked by the per-OS smoke test | 02b, 14 |
| Release bot vs protected `main` | The release commit push fails | Allow the release bot in branch protection, or skip committing the version and derive it from the tag | 02b |
| Instanced perf in Safari/Firefox | Safari WebGL and Firefox compositing are the slowest paths | InstancedMesh everywhere, shared materials, draw-call budget test, quality tiers | 03, 07, 36 |
| Bloom and `backdrop-filter` cost | Both expensive over a live WebGL canvas, worst in Firefox | Auto-disable below 45 fps, solid panel fallback | 04, 27, 36 |
| Look drifts from the approved mockup, or reads as generic neon | Art style is the identity | Lock lighting rig and material library to variant-B-2 early (design D14), compare screenshot to mockup at 04 and 08 | 04, 08 |
| Live data re-render storms | Per-frame React updates kill fps | Transient subscriptions for scene, throttled selectors for panels, Profiler checks in acceptance | 11, 18 |
| Hall teardown leaks | Hours of churn will exhaust GPU memory | Pure reconciler, explicit dispose, automated churn leak test in all browsers | 19, 20 |
| Log formats undocumented and changing | Parsers can silently break | Record observed formats, tolerant parsers, unknown-type counters, parse-failure alert, fixtures per version | 15, 16, 32 |
| Unrecoverable fields | Subagent parent (Codex), session end, task, cost | `parentKnown`, idle inference, derived/estimated badges, feasibility table kept current | 15, 16, 37 |
| Local folder access in Safari/Firefox | No File System Access API | Log server Vite plugin plus drag-and-drop upload | 14, 17 |
| Privacy of prompts and code | Logs contain sensitive content | Redaction at parse time, localhost-only server, no raw content in store | 14, 15 |
| Scale beyond 12 halls | Campus layout is finite | Defined cap with "Unassigned" board and alert | 19 |

---

## Eng review record (/plan-eng-review, 2026-10-12)

Target: `docs/PLAN.md` (Synapse Horizon build plan), branch `main`, commit `f4cb845`. Reviewer: Claude (in-host). This section holds the scope record, findings and decision ledger. The plan above is the working plan; accepted changes are applied in place.

### Scope record

feature answers: none proposed (no feature cuts); structure: A, Smaller arrangement (D1, answered 2026-10-12); accepted scope: all 37 chunks unchanged in feature list; log server runs as a Vite plugin inside `vp dev` with a thin CLI for the built app, parsers Node-only, drag-and-drop uploads to `POST /api/import`; browser Web Worker parser path removed (applied to D3, section 3 diagram, chunks 14, 15, 17, risk table); pending remedies: R2, R4, R6, R8, R10.

Scope Challenge result: scope accepted as-is (smaller arrangement preserves the feature list).

### Scope Challenge findings

- S1 [P3] (confidence: 9/10) docs/PLAN.md:128,163-165 (original) "Captured by `pnpm shots`", "`pnpm e2e` green". Vite+ runs package scripts with `vp run` (verified: `vp --help` lists `run    Run tasks`). Factual correction, applied: all `pnpm <script>` references now `vp run <script>`.
- S2 [P3] (confidence: 8/10) docs/PLAN.md:15 "pnpm, Node 22 LTS". Local runtime is `node v24.21.0` managed by Vite+ (`/Users/nathanael/.local/share/vite-plus/bin/node`). Kept as approved (F1); chunk 01 must pin the version explicitly (`.node-version` or `vp env`) so local and CI match.
- S3 [P3] (confidence: 9/10) Version constraint: `@react-three/fiber@9.8.1` peer `react: '>=19 <19.4'`; latest `react` is `19.3.0`. Compatible today; chunk 01 pins React to `~19.3` so an upgrade cannot silently break R3F if chunk 03 picks it.

Reality rows:
- REALITY: premise-table finding unverified=3 (Claude log fields, Codex log fields, R3F auto-dispose on unmount) docs/PLAN.md:62
- REALITY: already-done pass repo has only `f4cb845 Initial commit`; nothing built git log
- REALITY: surface-check finding `pnpm <script>` vs `vp run` (S1); `vp dev/check/lint/fmt/test/build` verified via `vp --help` docs/PLAN.md:128
- REALITY: binding-decisions pass no prior decisions logged; plan section 1 D1-D18 honoured docs/PLAN.md:11
- REALITY: numbers finding perf budgets and estimation constants are [estimated], none measured; chunk 03 and 36 must re-measure docs/PLAN.md:93
- REALITY: deferred-asks pass every brief item (life, interaction, dashboard, extras, README per chunk, extra visualisations) maps to a chunk docs/PLAN.md:146
- REALITY: pr-count n/a no ship policy; one commit per chunk on main docs/PLAN.md:30

### Section 1: Architecture findings

- A1 [P1] (confidence: 8/10) docs/PLAN.md:257 (original chunk 14) "Server refuses non-localhost connections." Any web page open in the same browser can open `ws://localhost:<port>` because the connection does originate from localhost; browsers do not apply same-origin policy to WebSockets. A malicious page would receive prompts, file paths and task text. This breaks the approved privacy contract (A12: "nothing leaves localhost"). Required work for an approved contract, no new decision: the WebSocket upgrade and `POST /api/import` reject any `Origin` header that is not the app's own origin, and require a per-run random token injected into the served page. Applied to chunk 14 tasks and acceptance.
- A5 [P2] (confidence: 7/10) docs/PLAN.md:62 "currentTask ... Heuristic: active TodoWrite item, else last user prompt". User prompts often contain pasted API keys or tokens; a 120-char truncation keeps them. Pending: R2.
- A2 [P2] (confidence: 7/10) docs/PLAN.md:22 "Overflow halls `A2`, `A3`..." and chunk 08 "deterministic positions for up to 12 halls, A/B fixed first" and chunk 19 "adds overflow `A2`, `A3` adjacent". Adjacent placement conflicts with a fixed slot grid: inserting A2 next to A shifts every later hall, so racks, fibre lines and camera presets jump while you watch. Pending: R4.
- A3 [P2] (confidence: 8/10) docs/PLAN.md:263 (chunk 15) "Idle-based session end and status inference" inside the Node parser. The parser only sees wall-clock time, so at 10x/60x replay sessions end at the wrong moment and tests depend on real time. Required work for the approved replay feature (A3): parsers emit only facts from log lines; session end, status and waiting inference move into the browser store and use the single store clock (live or replay). Applied to chunks 12, 13 and 15.
- A4 [P2] (confidence: 6/10) docs/PLAN.md:22 "16 racks per hall" with the chunk 19 12-hall cap. Medium confidence, verify this is actually an issue: one project with 177+ sessions takes every hall slot and pushes all other projects onto the Unassigned board. Pending: R6.

Section 1 dispositions: A1 accepted as required work for approved A12 (applied, chunk 14); A5 accepted, D2 A; A2 accepted, D3 A; A3 accepted as required work for approved A3 replay (applied, chunks 13, 15); A4 accepted, D4 A.

### Section 2: Code quality findings

- Q1 [P2] (confidence: 7/10) docs/PLAN.md:31 (D11) "normalised event log as source of truth" and chunk 11 "append-only event log (ring buffer, configurable cap)". If the ring buffer is the source of truth, evicted events take token totals and session history with them, and de-duplication after a reconnect has nothing to compare against. Required work for the approved real-token metrics and 24 h backfill (A4, A10): aggregates (sessions, tokens, jobs) are updated incrementally and are authoritative; the ring buffer holds only the recent timeline. The server keeps a per-file byte-offset cursor; the client sends its last cursor on reconnect and the server resumes from it, so nothing is replayed twice. Applied to D11 and chunks 11, 14.
- Q2 [P3] (confidence: 6/10) docs/PLAN.md chunk 13 "Lint rule or test that dashboard components only render numbers through `<MetricValue metric=...>`". Medium confidence, verify this is actually an issue: a custom lint rule or a DOM test is hard to make reliable (numbers inside strings, formatted dates). Pending: R8.
- Q3 [P3] (confidence: 8/10) docs/PLAN.md:62 waiting_user "assistant turn ended, no new user line" with D4 "Session ends after 30 min idle". In logs a finished conversation and one waiting on you look the same. Factual clarification, applied: a session shows `waiting_user` from turn end until the 30 min idle end; the "waiting > 2 min" alert covers that window only.
- Q4 [P2] (confidence: 7/10) docs/PLAN.md chunk 16 "cumulative token counts to deltas". Tailing from a saved offset mid-file loses the previous cumulative value, so the first delta after restart is the whole session total. Required work for approved real token metrics: the Codex parser stores the last cumulative value per session with the file cursor, or re-reads the file from the start on first open. Applied to chunk 16 acceptance.

Section 2 dispositions: Q1 accepted as required work (applied, D11, chunks 11, 14); Q2 accepted, D5 A; Q3 accepted as factual clarification (applied, section 2 table); Q4 accepted as required work (applied, chunk 16).

### Section 3: Test review

Framework: none in the repo yet (no package.json; `git ls-files` shows only README.md). Plan proposes Vitest via `vp test` plus Playwright (approved F3). No framework decision needed. No existing behaviour, so the regression rule does not apply yet; each chunk's acceptance becomes its regression suite.

```
CODE PATHS (proposed)                                   USER FLOWS (proposed)
[+] sidecar/ log server plugin (14)                     [+] Start app, see live sessions
  ├── tailer                                              ├── [★★ PLANNED] append line, visible < 1 s (14)
  │   ├── [★★★ PLANNED] partial line fixtures            ├── [GAP] [→E2E] restart vp dev with tab open,
  │   ├── [GAP]          file truncated / rotated         │          no duplicate tokens (14, Q1 cursor)
  │   └── [GAP]          24 h mtime filter skips old      └── [GAP]        log root missing or unreadable:
  │                      files (perf P1)                               pill shows reason, no crash
  ├── origin + token check (A1)                         [+] Drag-and-drop replay (17)
  │   └── [★★★ PLANNED] foreign origin and no token      ├── [★★ PLANNED] drop fixture, replay plays
  │                      refused (14)                     ├── [GAP]        file over size cap: clear error
  └── POST /api/import                                    ├── [GAP]        non-JSONL / binary file
      └── [GAP]          size cap + malformed body        └── [★★ PLANNED] server stopped: clear message
[+] parsers (15, 16)                                    [+] Select and inspect (24-26, 29)
  ├── [★★★ PLANNED] plain, subagents, tool error,         ├── [★★ PLANNED] select each entity kind
  │                  malformed, unknown type              ├── [GAP] [→E2E] click a moving agent hits it
  ├── [★★★ PLANNED] secret patterns + SHA kept (D2)       │          (instanced bounding sphere, perf P2)
  └── [★★ PLANNED]  Codex restart mid-file totals (Q4)    ├── [★★ PLANNED] URL hash restores selection
[+] store + clock (11-13)                                 └── [GAP]        selected entity removed (hall
  ├── [★★★ PLANNED] same seed = same events                          retires): panel closes, no crash
  ├── [★★ PLANNED]  scenario shapes at 10x              [+] Hall lifecycle (19, 20)
  ├── [★★ PLANNED]  pause freezes derived values          ├── [★★★ PLANNED] reconciler table (incl. D3, D4)
  ├── [GAP]          idle end at 60x replay ends at       ├── [★★ PLANNED] churn leak test
  │                  same sim time as 1x (A3)             └── [GAP]        project returns during grace
  ├── [GAP]          unknown model in price table:                         while hall is sinking (anim)
  │                  cost shows "unknown", never 0      [+] Weather/day-night (34, 35)
  └── [★★ PLANNED]  type test rejects raw number (D5)     └── [★★ PLANNED] weather changes no sim state
[+] scene binding (18, 21-23)
  ├── [★★ PLANNED]  instance count = store count
  └── [★ PLANNED]   "no React re-renders" via Profiler (manual; weak)

COVERAGE: 17/28 paths with a planned test (61%) | code paths 11/17 | user flows 6/11 (counted from this diagram)
QUALITY (planned): ★★★:6 ★★:10 ★:1 | GAPS: 11 (2 E2E)
```
Legend: ★★★ behaviour + edge + error | ★★ happy path | ★ smoke | [→E2E] needs integration test | PLANNED = proposed in the plan, not built.

Test gaps (required proof of approved behaviour, added to chunk acceptance; each with a value card in the test plan artifact):
- G1 tailer truncation/rotation (chunk 14): protects real token totals (A10). fails_when offset not reset on truncate.
- G2 24 h mtime filter (chunk 14): protects approved 24 h backfill (A4) and startup time. fails_when the whole history is parsed.
- G3 import size cap, malformed and binary files (chunk 17).
- G4 restart with tab open, no duplicates (chunk 14): protects Q1 cursor resume.
- G5 log root missing or unreadable shows reason in the pill (chunk 14).
- G6 idle end at 60x equals 1x in sim time (chunk 13): protects A3 replay.
- G7 unknown model shows cost "unknown" (chunk 13): protects A7 estimated cost labelling.
- G8 moving-agent pick (chunk 24): protects "every agent clickable".
- G9 selected entity removed closes the panel cleanly (chunk 24).
- G10 project returns while its hall is sinking (chunk 20).
- G11 the "no React re-renders" Profiler check is manual and weak; replace with a render-count assertion through a test hook in a Vitest + happy-dom test of the scene binding (chunk 18).

Tests made obsolete by this plan: none (no existing tests).

Findings:
- T1 [P2] (confidence: 6/10) docs/PLAN.md:30 (D18) "Playwright smoke + screenshots in Chromium, WebKit, Firefox. GitHub Actions from chunk 01." and chunk 20 "Runs in all three browsers" (leak test), chunk 36 perf. Medium confidence, verify this is actually an issue: Linux CI runners have no GPU. WebGL there is software-rendered, WebKit headless WebGL support on Linux is uncertain, fps numbers mean nothing, and screenshots will not match the ones made on your Mac. Pending: R10 (reopens approved F6 for this concrete risk).
- T2 [P3] (confidence: 8/10) docs/PLAN.md chunk 02 "Running it twice gives byte-identical or visually identical output". GPU output is not byte-stable. Factual correction, applied: compare with a pixel-diff threshold (under 0.5% of pixels differ).

Section 3 dispositions: T1 accepted, D6 A; T2 accepted as factual correction (applied, chunk 02); gaps G1-G11 accepted as required proof of approved behaviour (applied to chunks 13, 14, 17, 18, 20, 24).

### Section 4: Performance findings

- P1 [P2] (confidence: 8/10) docs/PLAN.md:17 (D4) "Backfill last 24 h". `~/.claude/projects` holds every past session (scale unknown here; easily thousands of files). Reading each file to find recent lines makes startup slow. Required work for approved A4: skip files by mtime before opening them; covered by G2 in chunk 14.
- P2 [P2] (confidence: 7/10) docs/PLAN.md chunk 24 "Raycasting with instance IDs for racks, agents, carts". Three.js computes an `InstancedMesh` bounding sphere once; agents that walk outside it are missed by the raycast. Required work for the approved "every agent clickable": recompute the bounding sphere when instances move, or pick from store positions. Applied to chunk 24 (plus G8).
- P3 [P2] (confidence: 7/10) docs/PLAN.md chunks 11, 14. A 24 h backfill can deliver tens of thousands of events at connect (scale unknown, not measured). One store update per event fires every subscriber that many times. Required work: batch on the wire (up to 500 per message) and apply each batch in one store update. Applied to chunks 11 and 14.
- P4 [P3] (confidence: 7/10) docs/PLAN.md chunk 31 "5,000 tool-call rows" reads from the capped ring buffer. Factual clarification, applied: the default cap is 50,000 events, above the 5,000-row target.

Section 4 dispositions: P1-P3 accepted as required work (applied); P4 accepted as clarification (applied).

## Decision ledger

### R2: Secret redaction in displayed task text
Finding: A5, P2, confidence 7/10, docs/PLAN.md:62, Claude (in-host)
Plan baseline: A12 approved "first 120 chars of the current task, never full prompts, redact paths outside the project, nothing leaves localhost". No secret-pattern redaction proposed.
Runtime evidence: unknown; no code exists. Logs are known to contain raw user prompts (approved A12 premise).
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R2 secret redaction | none | pattern redaction at parse time (key prefixes, bearer tokens, long high-entropy strings) replaced with `[redacted]`, fixture tests | none (120-char truncation only) |
| A12 truncation and path redaction | approved | unchanged | unchanged |
| R4 overflow placement | pending | pending | pending |
| R6 per-project hall cap | pending | pending | pending |
Question D2:
D2 — Redact secrets from task text?
Project/branch/task: Synapse Horizon plan review on main, chunk 15 parser redaction.
ELI10: The "current task" shown on panels comes from your last prompt. People paste API keys and tokens into prompts. Cutting the text to 120 characters does not remove a key that sits near the start. Adding pattern redaction swaps strings that look like secrets for `[redacted]` before they ever reach the browser.
Stakes if we pick wrong: Without it, a key can appear on screen and in every README screenshot made from real logs.
Recommendation: A because the parser already redacts paths, the extra work is small, and screenshots get shared.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Redact secret patterns (recommended)
  ✅ Keys, bearer tokens and long random strings never reach the store, the UI or screenshots
  ✅ One regex list plus fixtures in the parser tests, at the same layer as path redaction
  ❌ Can over-redact long hashes or IDs in task text, making a few tasks less readable
B) Truncation only
  ✅ Task text stays exactly as typed, with no false positives hiding useful words
  ✅ No extra pattern list to maintain as vendors change key formats
  ❌ A key pasted early in a prompt shows up on panels and in any shared screenshot
Net: a little readability lost on rare long IDs, against never showing a pasted secret.
Header: Secrets
Options:
A) Redact secret patterns (recommended)
Add pattern redaction in the Node parser (chunk 15/16): known key prefixes (sk-, ghp_, xox, AKIA...), bearer tokens, strings of 32+ high-entropy chars, replaced by [redacted] before events leave the server. Fixture tests for each pattern and a no-false-positive case. Effort: human ~2h / CC ~10 min. Low risk; pattern list maintained in one file.
B) Truncation only
Keep A12 as is: 120-char truncation and path redaction only. No extra work or maintenance. Risk: pasted secrets visible on screen and in screenshots.

State: approved
Actual answer: A) Redact secret patterns (recommended), answered D2 2026-10-12
Accepted scope: pattern redaction in the Node parsers (chunks 15/16): known key prefixes (sk-, ghp_, xox, AKIA...), bearer tokens, 32+ char high-entropy strings replaced by [redacted] before events leave the server; one pattern file; fixture tests per pattern plus a no-false-positive case.
History: none

### R4: Overflow hall placement
Finding: A2, P2, confidence 7/10, docs/PLAN.md:22 and chunks 08, 19, Claude (in-host)
Plan baseline: original proposal (not separately approved): overflow halls `A2`, `A3` placed adjacent to the parent hall; chunk 08 fixed slot grid "A/B fixed first".
Runtime evidence: unknown; no code exists.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| R4 overflow placement | adjacent insertion (proposal) | next free slot in the fixed grid, linked to the parent by a cyan conduit line and a matching sign colour | reserved overflow slot beside every hall (footprint doubles, 6 projects max on 12 slots) | adjacent insertion, later halls slide over with animation |
| R2 secret redaction | approved A (D2) | unchanged | unchanged | unchanged |
| R6 per-project hall cap | pending | pending | pending | pending |
| D8 16 racks per hall, A/B always present | approved | unchanged | unchanged | unchanged |
Question D3:
D3 — Where do overflow halls go?
Project/branch/task: Synapse Horizon plan review on main, chunks 08, 19, 20 hall layout.
ELI10: When a project fills its 16-rack hall, it gets an overflow hall. The plan puts that hall right next to the original, but the campus also uses a fixed grid of hall spots. Squeezing a new hall in next to A means every hall after it has to move, so racks, fibre lines and camera views jump while you watch. Other options are to drop overflow into the next empty spot and draw a link, or keep a spare spot next to every hall.
Stakes if we pick wrong: Moving halls at runtime makes the scene jumpy and makes the leak and layout tests much harder.
Recommendation: A because halls never move once placed, the reconciler stays simple, and the link line still shows which project the overflow belongs to.
Completeness: A=9/10, B=7/10, C=6/10
Pros / cons:
A) Next free slot + link (recommended)
  ✅ A hall never moves after it appears, so fibre lines, signs and camera presets stay stable
  ✅ Reconciler rule is one line: overflow takes the lowest free slot, tested like any new hall
  ❌ Overflow can sit across the campus from its parent; you rely on the link line and colour
B) Reserved adjacent slot
  ✅ Overflow always sits right beside its parent, readable at a glance with no link needed
  ✅ Halls still never move once placed, keeping teardown and leak tests simple
  ❌ Half the campus is empty reserved space; only 6 projects fit on 12 slots
C) Adjacent, halls slide
  ✅ Matches the original plan: overflow always beside its parent hall
  ✅ No wasted empty slots on the campus at any time
  ❌ Every overflow moves other halls, rebuilding fibre lines and camera presets mid-view
Net: stable positions with a visual link, versus always-adjacent halls paid for with empty space or moving geometry.
Header: Overflow
Options:
A) Next free slot + link (recommended)
Overflow hall takes the lowest free slot in the fixed 12-slot grid; a cyan conduit line plus matching sign colour links it to the parent hall. Halls never move once placed. Changes chunks 08, 19, 20 text and reconciler tests. Effort: human ~1h / CC ~5 min to amend plan; no extra build cost.
B) Reserved adjacent slot
Every hall slot is paired with a reserved overflow slot beside it. Halls never move; max 6 projects visible on 12 slots, second overflow (A3) still needs a free pair. Effort: human ~2h / CC ~10 min; campus layout chunk 08 gets larger.
C) Adjacent, halls slide
Keep original: overflow inserted beside the parent, later halls animate to new positions, fibre lines and presets rebuilt on every change. Effort: human ~1 day extra / CC ~1 h extra in chunk 20; higher leak and flicker risk.

State: approved
Actual answer: A) Next free slot + link (recommended), answered D3 2026-10-12
Accepted scope: overflow halls take the lowest free slot in the fixed 12-slot grid; a cyan conduit line plus matching sign colour links each overflow hall to its parent; halls never move once placed. Plan text amended in D8 and chunks 08, 19, 20; reconciler tests cover slot choice and link.
History: none

### R6: Per-project hall cap
Finding: A4, P2, confidence 6/10, docs/PLAN.md:22 and chunk 19 12-hall cap, Claude (in-host)
Plan baseline: original proposal: global cap of 12 halls; excess projects queue on an "Unassigned" board and raise an alert. No per-project cap.
Runtime evidence: unknown; no code exists.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R6 per-project hall cap | none (global 12 only) | max 3 halls (48 racks) per project; sessions beyond that shown as a "+N" badge on the project's last rack and counted in panels | none; one project may take all 12 slots |
| R4 overflow placement | approved A (D3) | unchanged | unchanged |
| R2 secret redaction | approved A (D2) | unchanged | unchanged |
| Global 12-hall cap + Unassigned board | proposal | unchanged | unchanged |
Question D4:
D4 — Cap halls per project?
Project/branch/task: Synapse Horizon plan review on main, chunk 19 hall reconciler.
ELI10: Each hall holds 16 racks and the campus has room for 12 halls. With no limit per project, one busy project with about 180 sessions fills every hall and pushes all your other projects off the map. A per-project cap of 3 halls keeps room for others; any sessions past 48 show as a "+N" badge on the last rack instead of new halls.
Stakes if we pick wrong: Without a cap, one runaway project or a mock stress test hides every other project from the 3D view.
Recommendation: A because it keeps every project visible and the panels still count every session exactly.
Completeness: A=9/10, B=7/10
Pros / cons:
A) Cap at 3 halls (recommended)
  ✅ No single project can crowd others off the campus, even during a big subagent burst
  ✅ Session counts and tokens stay exact in panels; only the 3D rack count is capped
  ❌ Past 48 sessions the 3D view no longer shows one rack per session for that project
B) No per-project cap
  ✅ One rack per session is always true in 3D until the global 12-hall limit is hit
  ✅ Fewer rules in the reconciler and fewer test rows to maintain
  ❌ A single large project can push every other project onto the Unassigned board
Net: a fair share of campus space per project, against exact one-rack-per-session for a single huge project.
Header: Hall cap
Options:
A) Cap at 3 halls (recommended)
Reconciler limits each project to 3 halls (48 racks). Extra sessions render as a "+N" badge on the project's last rack and stay fully counted in KPI cards, tables and the hall panel. Adds 2 rows to the chunk 19 table-driven tests. Effort: human ~1h / CC ~5 min.
B) No per-project cap
Keep the proposal: only the global 12-hall cap applies; one project can fill all halls and others go to the Unassigned board. No extra work.

State: approved
Actual answer: A) Cap at 3 halls (recommended), answered D4 2026-10-12
Accepted scope: reconciler caps each project at 3 halls (48 racks); sessions beyond that render as a "+N" badge on the project's last rack and remain fully counted in KPI cards, tables and the hall panel; 2 extra rows in chunk 19 table-driven tests (60 sessions gives 3 halls + "+12"; badge clears when load drops).
History: none

### R8: How to enforce provenance badges
Finding: Q2, P3, confidence 6/10, docs/PLAN.md chunk 13, Claude (in-host)
Plan baseline: original proposal: "Lint rule or test that dashboard components only render numbers through `<MetricValue metric=...>`".
Runtime evidence: unknown; no code exists.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R8 provenance enforcement | lint rule or DOM test (proposal) | type-level: selectors return only `Metric`; dashboard number formatters accept only `Metric`; plus one e2e audit that every element marked `data-metric` has a badge | keep custom lint rule / DOM scan as proposed |
| D6 three provenance levels | approved (A10) | unchanged | unchanged |
| R2, R4, R6 | approved | unchanged | unchanged |
Question D5:
D5 — How do we guarantee every number has a badge?
Project/branch/task: Synapse Horizon plan review on main, chunk 13 provenance.
ELI10: You asked that every number on screen says whether it is real, derived or estimated. The plan enforces that with a custom lint rule or a test that scans the page, both of which are easy to fool. The alternative uses TypeScript: the data layer only hands out values that carry their provenance, and the display helpers refuse plain numbers, so a missing badge fails at compile time.
Stakes if we pick wrong: A weak check lets unlabeled estimated temperatures or costs slip into panels, which breaks your core rule about provenance.
Recommendation: A because the compiler catches it on every change, with no custom lint plugin to maintain.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Type-level Metric only (recommended)
  ✅ A raw number passed to a panel fails `vp check`, before anything runs in a browser
  ✅ No custom lint plugin; one small e2e audit catches the rare string-built number
  ❌ Every selector and formatter must wrap values in `Metric`, a bit more typing up front
B) Lint rule or DOM scan
  ✅ Keeps components free to accept plain numbers, less wrapping in selectors
  ✅ DOM scan checks what the user actually sees on the rendered page
  ❌ Custom lint rules miss numbers built in strings; DOM scans miss untested panels
Net: compile-time guarantee with a little more typing, against looser checks that are easier to bypass.
Header: Provenance
Options:
A) Type-level Metric only (recommended)
Selectors return `Metric` objects only; dashboard formatters and `MetricValue` accept only `Metric` (no `number` overload). One Playwright audit asserts every `[data-metric]` element contains a provenance badge. Effort: human ~2h / CC ~10 min in chunk 13.
B) Lint rule or DOM scan
Keep the proposal: write a custom lint rule or a DOM test that searches dashboard output for numbers without a badge. Effort: human ~4h / CC ~20 min; ongoing false positives and misses.

State: approved
Actual answer: A) Type-level Metric only (recommended), answered D5 2026-10-12
Accepted scope: selectors return `Metric` only; dashboard formatters and `MetricValue` accept only `Metric` (no `number` overload), so a raw number fails `vp check`; one Playwright audit asserts every `[data-metric]` element contains a provenance badge. Replaces the lint-rule/DOM-scan proposal in chunk 13.
History: none

### R10: Where browser and GPU tests run
Finding: T1, P2, confidence 6/10, docs/PLAN.md:30 (D18), chunks 02, 20, 36, Claude (in-host)
Plan baseline: approved F6 "CI (GitHub Actions running tests + shots on 3 browsers) [yes, from chunk 1]", answered in the office-hours batch. Reopened because Linux CI has no GPU (concrete new risk).
Runtime evidence: unknown; no CI exists. GPU absence on standard Linux runners is general knowledge, not probed here.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| R10 test location | all browser tests + shots in Linux CI (approved F6) | CI: lint, types, unit, Chromium + Firefox smoke (software WebGL). Local on your Mac before closing a chunk: WebKit smoke, leak, perf, screenshots via `vp run e2e:local` | full 3-browser matrix on a macOS CI runner; perf and screenshots still local | keep F6 as approved |
| D18 Vitest + Playwright | approved | unchanged | unchanged | unchanged |
| R2, R4, R6, R8 | approved | unchanged | unchanged | unchanged |
Question D6:
D6 — Where do browser and GPU tests run?
Project/branch/task: Synapse Horizon plan review on main, chunks 02, 20, 36 test setup.
ELI10: You approved CI that runs browser tests and screenshots in all three browsers. Standard GitHub CI machines have no graphics card, so 3D runs through a slow software renderer. Frame rates there mean nothing, Safari's engine may not render WebGL at all, and screenshots will look different from your Mac's. The fix is to split the work: CI runs fast checks plus Chrome and Firefox smoke, while Safari, leak, performance and README screenshots run on your Mac before you close each chunk.
Stakes if we pick wrong: Keeping everything in Linux CI gives flaky red builds and README images that don't match what you see.
Recommendation: A because each test runs where its result means something, and CI stays fast and green.
Completeness: A=9/10, B=8/10, C=5/10
Pros / cons:
A) CI fast + Mac local GPU (recommended)
  ✅ CI stays quick and reliable: types, unit, Chrome and Firefox smoke on every push
  ✅ Leak, perf, Safari and screenshots run on real hardware with meaningful numbers
  ❌ Safari and perf checks depend on you running `vp run e2e:local` before closing a chunk
B) macOS CI runner
  ✅ All three engines, including WebKit, checked automatically on every push
  ✅ No reliance on remembering a local command for browser coverage
  ❌ macOS runner minutes cost about 10x Linux, and still no real GPU for perf or shots
C) Keep as approved
  ✅ No change to what you already approved; everything sits in one CI pipeline
  ✅ Screenshots generated automatically in CI artifacts on every run
  ❌ Software WebGL makes perf and leak results meaningless and WebKit tests likely flaky
Net: honest results split between CI and your Mac, versus a single pipeline that can't measure 3D well.
Header: Test setup
Options:
A) CI fast + Mac local GPU (recommended)
CI (ubuntu): `vp check`, `vp test`, Playwright smoke in Chromium + Firefox with software WebGL. Local on your Mac (`vp run e2e:local`, required before ticking a chunk): WebKit smoke, churn leak test, perf scenario, `vp run shots`. Amends D18 and chunks 01, 02, 20, 36. Effort: human ~1h / CC ~5 min to amend plan.
B) macOS CI runner
CI on macos-latest runs the full Chromium/WebKit/Firefox smoke and leak tests; perf and screenshots stay local because CI has no real GPU. Effort: human ~2h / CC ~10 min; ongoing macOS runner cost.
C) Keep as approved
Leave F6 unchanged: all browser tests, leak, perf and screenshots in Linux CI. No plan change; expect flaky WebKit and meaningless perf numbers.

State: approved
Actual answer: A) CI fast + Mac local GPU (recommended), answered D6 2026-10-12
Accepted scope: CI (ubuntu) runs `vp check`, `vp test`, Playwright smoke in Chromium + Firefox with software WebGL. Local on the Mac via `vp run e2e:local`, required before ticking a chunk: WebKit smoke, churn leak test, perf scenario, `vp run shots`. D18 and chunks 02, 20, 36 amended.
History: F6 approved "yes" in the office-hours batch (2026-10-12); reopened for the no-GPU risk.

Approval readiness: PASS. Checked R2 (D2 A), R4 (D3 A), R6 (D4 A), R8 (D5 A), R10 (D6 A), scope record (D1 A). Required work A1, A3, Q1, Q4, P1-P3 and gaps G1-G11 cite approved contracts A12, A3, A4, A10, A7 and the brief's "every agent is clickable"; factual corrections S1, Q3, T2, P4 change no approved behaviour.

### Outside voice

Disabled (`codex_reviews` = disabled). No outside or native second reviewer ran; this review has single-reviewer coverage.

### NOT in scope

- Node version change (S2): F6/F1 kept at Node 22 LTS as approved; chunk 01 only pins it. Revisit if you want Node 24 LTS.
- Real GPU in CI: deferred by D6; perf and screenshots stay on the Mac.
- Mobile, auth, multi-user: out of scope per brief.

### What already exists

Nothing in the repo (only `README.md`, commit `f4cb845`). Reuse targets are dependencies, not local code: `vp` (dev, check, test, build, run; verified via `vp --help`), Three.js 0.186.1, `@react-three/fiber` 9.8.1 and `@react-three/drei` 10.7.9 (if chunk 03 picks R3F), React 19.3.0, Tailwind 4.3.3 (versions from `npm view`, 2026-10-12). Chokidar, zod, Zustand, TanStack Table and Playwright are named in the plan but not yet installed.

### Diagrams

Hall lifecycle (chunk 19 reconciler, after D3/D4):

```
             first session in project
  (none) ─────────────────────────────► entering ──1.5 s──► active
                                                              │  ▲
           sessions > 16·n and n < 3: add overflow            │  │ session returns
           in lowest free slot + parent link (D3)             │  │ during grace
                                                              ▼  │
                         no active session for 10 min ──► retiring ──3 s──► removed
                                                         (LEDs off,       (dispose all,
                                                          sink + fade)     free slot)
  n = 3 halls and more sessions: "+N" badge on last rack, no new hall (D4)
  12 slots full: new project goes to Unassigned board + alert
```

Data path after D1, A1, A3 and Q1:

```
log files ─► tailer (mtime filter, per-file cursor) ─► parser (facts only, redaction D2)
           ─► batch ≤500 ─► WS (Origin + token, A1) ─► store: incremental aggregates
           ─► store clock (live|replay) drives idle end, status, waiting (A3) ─► scene + panels
```

### Failure modes

| Path | Realistic failure | Covered by | User sees |
|---|---|---|---|
| Tailer | Log rotated or truncated | G1 test, offset reset | Correct totals |
| Backfill | Huge history, slow start | G2 mtime filter | Fast start |
| WebSocket | Malicious page connects | A1 Origin + token, test | Nothing leaks |
| Parser | Vendor changes log format | Unknown-type counter, parse-failure alert (chunk 32) | Alert, not silence |
| Parser | Secret in prompt | D2 redaction, fixtures | `[redacted]` |
| Reconnect | Server restart | Q1 cursor, G4 | Pill "reconnecting", no duplicates |
| Import | Bad or huge file | G3 | Clear error |
| Replay | Wall-clock inference | A3, G6 | Correct timing |
| Hall teardown | Leaked GPU objects | Churn leak test (local) | Stable memory |
| Picking | Moving agent missed | P2, G8 | Click works |

Critical gaps (no test, no handling, silent): 0.

### Worktree parallelization strategy

| Step | Modules touched | Depends on |
|---|---|---|
| 01-02 tooling | root config, scripts/, .github/ | — |
| 03 spike | src/spike/ | 02 |
| 04-10 world | src/scene/ | 03 |
| 11-13 store | src/data/, src/sim/, src/config/ | 01 |
| 14-17 log server | sidecar/ | 11 |
| 18-23 data-driven scene | src/scene/, src/data/ | 10, 13, 19 |
| 24-37 interaction, dashboard, extras | src/dashboard/, src/scene/ | 23 |

Lane A: 03 → 04-10 (src/scene/). Lane B: 11-13 → 14-17 (src/data/, sidecar/). Lane C: 19 reconciler (src/data/hall/) once 13 lands.
Execution order: finish 01-02. Launch A + B. Merge both. Then 18-23 sequentially, then 24 onward.
Conflict flags: `src/data/schema.ts` is shared by lanes B and C; land 11 before starting 19.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship. Effort ratios assumed: features ~30x, tests ~50x human/CC.

- [ ] **T1 (P1, human: ~3h / CC: ~10min)** — sidecar — Reject foreign Origin and missing token on WebSocket and import
  - Surfaced by: Architecture — A1
  - Files: sidecar/plugin.ts, sidecar/cli.ts, tests under sidecar/
  - Verify: `vp test` origin/token tests; foreign-origin page cannot connect
- [ ] **T2 (P2, human: ~2h / CC: ~10min)** — parsers — Secret-pattern redaction
  - Surfaced by: Architecture — A5, D2
  - Files: sidecar/parsers/redact.ts, parser fixtures
  - Verify: `vp test` pattern fixtures plus SHA not redacted
- [ ] **T3 (P2, human: ~2h / CC: ~10min)** — reconciler — Overflow in lowest free slot with parent link
  - Surfaced by: Architecture — A2, D3
  - Files: src/data/hall/, src/scene/
  - Verify: reconciler table tests; existing hall positions unchanged
- [ ] **T4 (P2, human: ~1h / CC: ~5min)** — reconciler — 3-hall per-project cap with "+N" badge
  - Surfaced by: Architecture — A4, D4
  - Files: src/data/hall/
  - Verify: 60-session row gives 3 halls + "+12"
- [ ] **T5 (P2, human: ~3h / CC: ~10min)** — store — Lifecycle inference on the store clock
  - Surfaced by: Architecture — A3
  - Files: src/data/, src/sim/
  - Verify: G6 test, 1x vs 60x same sim time
- [ ] **T6 (P2, human: ~4h / CC: ~15min)** — store, sidecar — Incremental aggregates, cursor resume, batched events
  - Surfaced by: Code quality — Q1; Performance — P3
  - Files: src/data/, sidecar/
  - Verify: G4 restart test; batch apply fires subscribers once
- [ ] **T7 (P2, human: ~1h / CC: ~5min)** — parsers — Codex cumulative baseline across restart
  - Surfaced by: Code quality — Q4
  - Files: sidecar/parsers/codex.ts
  - Verify: restart mid-file gives same totals
- [ ] **T8 (P3, human: ~2h / CC: ~10min)** — dashboard — `Metric`-only formatters and data-metric audit
  - Surfaced by: Code quality — Q2, D5
  - Files: src/dashboard/, src/data/selectors
  - Verify: `@ts-expect-error` type test; Playwright audit
- [ ] **T9 (P2, human: ~1h / CC: ~5min)** — tooling — Split CI vs `e2e:local`
  - Surfaced by: Test review — T1, D6
  - Files: .github/workflows/, playwright config, package scripts
  - Verify: CI green on Chromium + Firefox; `vp run e2e:local` on the Mac
- [ ] **T10 (P2, human: ~2h / CC: ~10min)** — scene — Picking for moving instances
  - Surfaced by: Performance — P2
  - Files: src/scene/picking
  - Verify: G8 test
- [ ] **T11 (P2, human: ~1 day / CC: ~1h)** — tests — Gaps G1-G11 in their chunks
  - Surfaced by: Test review — coverage diagram
  - Files: per chunk
  - Verify: each chunk's acceptance list
- [ ] **T12 (P3, human: ~15min / CC: ~2min)** — tooling — Pin Node version and React ~19.3
  - Surfaced by: Scope Challenge — S2, S3
  - Files: package.json, .node-version
  - Verify: `vp check`; `node --version` matches pin in CI

### Unresolved decisions

None.

### Completion summary

- Step 0: Scope Challenge — scope accepted as-is (smaller arrangement, D1)
- Reality rows: 7/7 applicable rows emitted, 3 unverified premises
- Architecture Review: 5 issues found
- Code Quality Review: 4 issues found
- Test Review: diagram produced, 13 gaps identified (G1-G11, T1, T2)
- Performance Review: 4 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed to user
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, disabled (codex_reviews = disabled)
- Parallelization: 3 lanes, 2 parallel / 1 sequential after merge
- Lake Score: 0/5 (all five scored answers picked a 9/10 option; none offered 10/10)

Suppressed findings (appendix): none.

---

## Design review record (/plan-design-review, 2026-10-12)

Target: `docs/PLAN.md`, branch `main`, commit `f4cb845`. Reviewer: Claude (in-host), plus one independent Claude subagent (Codex disabled). All decisions are applied in section 4b and in the cited chunks. Design question numbers D5-D28 are this review's own sequence, separate from the eng review's D1-D7.

System audit: no DESIGN.md; UI scope is large (3D campus plus about eight overlay panels); no existing UI in the repo; no prior design reviews.

Step 0: initial rating 4/10. Focus: all 7 passes (design D1).

Outside voice: Claude subagent completed, 15 findings, all folded into passes 1-7 [single-model]. Codex disabled.

### Pass scores

| Pass | Before | After | Remaining gap |
|---|---|---|---|
| 1 Information architecture | 4 | 9 | panel content order inside the right panel is per-entity (chunk 29) |
| 2 Interaction states | 2 | 9 | Done-list and ring-buffer limits only noted, not designed |
| 3 Journey | 3 | 8 | long-term (reflective) stage relies on badges and mode chip only |
| 4 AI slop | 5 | 7 | user chose the mockup's dark neon-glow look (D14), a common AI look |
| 5 Design system | 2 | 8 | no DESIGN.md file; tokens live in section 4b |
| 6 Responsive and a11y | 3 | 8 | screen-reader testing limited to chunk 37 axe audit |
| 7 Decisions | - | 4 resolved, 0 deferred | none |

Decisions (each answered individually): D5 layout + safe area; D6 attention chip and beacon; D7 semantic zoom; D8 mode chip + replay bar; D9 empty/first-run; D10 loading/catch-up; D11 failure states; D12 toasts + search; D13 legend + copy actions; D14 follow the mockup look (B, against recommendation); D15 tool-call rows; D16 Geist type scale; D17 status palette; D18 GlassPanel moved to chunk 04; D19 provenance badge; D20 motion + reduced motion; D21 contrast rule; D22 keyboard/screen-reader path; D23 tracker popover; D24 full-session target; D25 Ambience menu; D26 bell merged into chip. Mockup approvals: D3 (round 1), D28 (round 2).

### NOT in scope

- Mobile and tablet layouts: desktop only per brief.
- A full DESIGN.md: tokens live in section 4b; `/design-consultation` can turn them into one later.
- Full-screen session page: rejected in favour of the filtered Sessions tab (D24).

### What already exists

Nothing in the repo yet. The approved mockup `variant-B-2.png` is the only visual asset. Reuse: the `geist` npm package for fonts, and TanStack Table rows as the keyboard path into the scene (D22).

### Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| Main dashboard | /Users/nathanael/.gstack/projects/bjorkgard-ai-center/designs/main-dashboard-20261012/variant-B-2.png | Dark isometric campus, cyan fibre glow, glass panels per section 4b | Text wins over image: no glyphs on cooling towers; badge marks top-right of numbers (D19); thinking dot `#A5B4FC` per D17 |

## Design Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific finding above. Effort ratio assumed: features ~30x human/CC.

- [ ] **DT1 (P2, human: ~3h / CC: ~10min)** — tokens — Type, spacing, radius, status, motion and focus tokens
  - Surfaced by: Pass 5 — D16, D17, D20, D21
  - Files: src/styles/tokens.css, tailwind config
  - Verify: `vp check`; token values match section 4b
- [ ] **DT2 (P2, human: ~4h / CC: ~15min)** — layout — GlassPanel, layout shell, safeArea, loader, WebGL failure card
  - Surfaced by: Pass 1, 2, 5 — D5, D10, D11, D18
  - Files: src/app/, src/dashboard/GlassPanel
  - Verify: chunk 04 acceptance; WebGL-off flag shows the card
- [ ] **DT3 (P2, human: ~3h / CC: ~15min)** — top bar — Attention chip, mode chip, Ambience menu, landmarks
  - Surfaced by: Pass 1, 7 — D6, D8, D25, D26, D22
  - Files: src/dashboard/topbar/
  - Verify: chunk 27 acceptance at 1280 px
- [ ] **DT4 (P2, human: ~4h / CC: ~20min)** — scene — Beacon, semantic zoom labels, dormant halls
  - Surfaced by: Pass 1, 2 — D6, D7, D9
  - Files: src/scene/
  - Verify: chunk 18 screenshots; label text at least 12 CSS px
- [ ] **DT5 (P2, human: ~3h / CC: ~15min)** — states — Empty card, catch-up progress, server-down banner, toasts, search dropdown
  - Surfaced by: Pass 2 — D9, D10, D11, D12
  - Files: src/dashboard/, sidecar/
  - Verify: each state reachable via mock scenario or flag
- [ ] **DT6 (P2, human: ~3h / CC: ~15min)** — panels — Legend, copy actions, tool-call rows, badge, tracker popover, View full session
  - Surfaced by: Pass 3, 4, 5, 7 — D13, D15, D19, D23, D24
  - Files: src/dashboard/panels/
  - Verify: chunk 26, 29, 30 acceptance
- [ ] **DT7 (P2, human: ~3h / CC: ~15min)** — a11y — Keyboard path through table, aria-live alerts, contrast test
  - Surfaced by: Pass 6 — D21, D22
  - Files: src/dashboard/table, tests/e2e
  - Verify: contrast check in forced day/night; keyboard-only selection e2e

### Unresolved Decisions

None.

### Completion Summary

```
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | no DESIGN.md, large UI scope                |
  | Step 0               | 4/10 initial, all 7 passes                  |
  | Pass 1  (Info Arch)  | 4/10 → 9/10 after fixes                     |
  | Pass 2  (States)     | 2/10 → 9/10 after fixes                     |
  | Pass 3  (Journey)    | 3/10 → 8/10 after fixes                     |
  | Pass 4  (AI Slop)    | 5/10 → 7/10 after fixes                     |
  | Pass 5  (Design Sys) | 2/10 → 8/10 after fixes                     |
  | Pass 6  (Responsive) | 3/10 → 8/10 after fixes                     |
  | Pass 7  (Decisions)  | 4 resolved, 0 deferred                      |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (3 items)                           |
  | What already exists  | written                                     |
  | TODOS.md updates     | 0 items proposed                            |
  | Approved Mockups     | 5 generated, 1 approved (variant-B-2)       |
  | Decisions made       | 22 added to plan                            |
  | Decisions deferred   | 0                                           |
  | Overall design score | 2/10 → 7/10                                 |
  +====================================================================+
```
Overall is below 8 because of Pass 4: you chose the mockup's neon-glow look (D14) over the clay spec. That is a deliberate choice, not an open decision.

## Eng re-review record (/plan-eng-review, 2026-10-12, after design review)

Target: `docs/PLAN.md`, branch `main`, commit `f4cb845`. Scope: the flows added by design decisions D5-D26 and the chunk 04 reorder (D18). The earlier eng review's decisions R1-R10 still stand. Question numbers D1-D2 here are this re-review's own sequence.

Scope record: no feature cuts proposed. The structure gate is resolved by the earlier exact answer (eng D1, smaller arrangement): the design changes add UI files inside the same modules and change no service arrangement. Scope Challenge result: scope accepted as-is.

### Findings

- E1 [P2] (confidence: 8/10) chunk 04 now holds canvas, camera, lights, materials, perf HUD, loader, WebGL card, context restore, quality tiers, motion tokens, reducedMotion, themed surfaces, adaptive glass, GlassPanel, layout shell and safeArea. That is 314 words of tasks against about 100 for a typical chunk, which breaks the brief's "one sitting" rule. Pending: R12.
- E2 [P2] (confidence: 7/10) section 4b D21 "Glass fill steps ... when scene luminance behind a panel is high". Reading rendered pixels back from the GPU every frame (`readPixels`) stalls the pipeline, worst in Safari. Pending: R13 (mechanism for the approved behaviour).
- E3 [P1] (confidence: 8/10) D8 source switch (live / replay / mock) with D11 incremental aggregates. Switching source mid-session without clearing the store mixes mock sessions into live totals and leaves the old halls standing. Required work for the approved D8 "always know what you see is real": a source switch tears down the store aggregates, ring buffer and scene halls (through the chunk 20 dispose path), then starts the new source. Applied to chunk 12.
- E4 [P2] (confidence: 8/10) D10 catch-up plus D12 toasts and D22 `aria-live`. Backfilled historical errors would fire a toast storm and screen-reader announcements at every launch. Required work for approved D10 (no fake surges): events flagged `backfill: true` update counts silently; only live events toast or announce. Applied to chunks 14 and 32.
- E5 [P3] (confidence: 7/10) D8 mode chip. Toasts raised during replay or mock look identical to live ones. Required for D8: toasts and alert rows carry a `REPLAY` or `MOCK` tag outside live mode. Applied to chunk 32.
- E6 [P3] (confidence: 7/10) D5 `safeArea` is recomputed only when panels open or close; a window resize leaves it stale. Required for D5: recompute on resize (ResizeObserver on the overlay root). Applied to chunk 04.
- E7 [P3] (confidence: 7/10) D7 billboard labels are DOM elements over the canvas, so screen readers read up to 12 floating labels on top of the D22 campus summary. Required for D22: billboards are `aria-hidden`. Applied to chunk 18.

## Re-review decision ledger

### R12: Split chunk 04
Finding: E1, P2, confidence 8/10, chunk 04, Claude (in-host)
Plan baseline: chunk 04 as amended by design D10, D11, D18, D20, D21 (all approved behaviours).
Runtime evidence: plan text only; chunk 04 tasks are 314 words (`wc -w`).
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| R12 chunk 04 shape | one chunk with scene and UI shell | 04a scene foundation (canvas, camera, lights, materials, HUD, quality tiers, motion tokens, reducedMotion, WebGL card, context restore); 04b UI shell (tokens and themed surfaces, GlassPanel, adaptive glass, layout shell, safeArea, loader) | keep one chunk 04 |
| Design D10, D11, D18, D20, D21 behaviours | approved | unchanged | unchanged |
| R13 luminance mechanism | pending | pending | pending |
Question D1:
D1 — Split chunk 04 into scene and UI shell?
Project/branch/task: Synapse Horizon plan re-review on main, chunk 04.
ELI10: The design review moved a lot into chunk 04: the glass panel, the screen layout, loading and error screens, motion and colour tokens, on top of the 3D canvas, camera and lighting it already had. It is now about three times the size of a normal chunk, so it won't fit in one sitting and has no clean checkpoint halfway. Splitting it gives 04a (3D scene foundation) and 04b (UI shell). Each one can be built and screenshotted on its own. Nothing is added or removed; it is only re-cut.
Stakes if we pick wrong: Chunk 04 runs over several sittings with half-finished work and no runnable checkpoint in between.
Recommendation: A because it restores the brief's one-sitting rule and both halves end in something you can run and test.
Completeness: A=9/10, B=6/10
Pros / cons:
A) Split into 04a + 04b (recommended)
  ✅ Each half fits one sitting and ends in a runnable, screenshot-able state
  ✅ 04b can start while 04a's lighting is tuned, since the two touch separate folders
  ❌ One more chunk number to track and one more README image step
B) Keep one chunk 04
  ✅ No renumbering; the scene and the UI frame land together in one commit
  ✅ One acceptance pass covers the whole foundation at once
  ❌ Breaks the one-sitting rule; no checkpoint between scene and UI work
Net: two clean checkpoints, against one oversized chunk.
Header: Chunk 04
Options:
A) Split into 04a + 04b (recommended)
04a Scene foundation: canvas, ortho/perspective camera, lights, materials (D14), perf HUD, quality tiers, motion tokens + reducedMotion (D20), WebGL card + context restore (D11). 04b UI shell: section 4b tokens and themed surfaces (D16, D17, D21), GlassPanel + adaptive glass, layout shell + safeArea (D5, D18), scene loader (D10). 04b depends on 04a; 05 depends on 04b. Each keeps its own acceptance and README image. Effort: human ~30 min / CC ~3 min to amend plan.
B) Keep one chunk 04
Leave chunk 04 as amended. No renumbering.

State: approved
Actual answer: A) Split into 04a + 04b (recommended), answered re-review D1 2026-10-12
Accepted scope: chunk 04 replaced by 04a (scene foundation) and 04b (UI shell) with the task split in the option; 04b depends on 04a; 05 depends on 04b; separate acceptance and README images 04a-scene.png and 04b-shell.png.
History: none

### R13: How adaptive glass knows the scene is bright
Finding: E2, P2, confidence 7/10, section 4b D21 and chunk 04b, Claude (in-host)
Plan baseline: design D21 approved "Glass fill steps from 8% up to 72% dark when scene luminance behind a panel is high (day mode, heatwave)" plus a pixel-measured contrast test. Mechanism unspecified.
Runtime evidence: unknown; no code. GPU readback stalls are general WebGL knowledge, not probed here.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| R13 luminance source | unspecified | lookup from known state: day/night phase and weather pick a fill level; no GPU readback | async GPU sample at 2 Hz from a 16x16 downsampled render target behind each panel | `readPixels` behind each panel every frame |
| D21 contrast rule + pixel-measured Playwright check | approved | unchanged | unchanged | unchanged |
| R12 chunk 04 split | approved A | unchanged | unchanged | unchanged |
Question D2:
D2 — How should the glass know the scene behind it is bright?
Project/branch/task: Synapse Horizon plan re-review on main, chunk 04b adaptive glass (design D21).
ELI10: You approved panels that turn darker when the scene behind them is bright, so text stays readable. To know "bright", the app could read pixels back from the graphics card. Doing that every frame makes the GPU wait and drops frame rate, worst in Safari. Option A skips pixel reading: the app already knows when it is daytime or a heatwave, so it picks the glass darkness from that. The existing contrast test still checks real pixels, so nothing slips through. Option B reads a tiny sample twice a second, which is cheaper but more complex.
Stakes if we pick wrong: Per-frame pixel reads cost frame rate on every browser; a state lookup could miss a bright spot the test does not cover.
Recommendation: A because it is explicit, costs nothing per frame, and the pixel-based contrast test from D21 still guards the result.
Completeness: A=8/10, B=9/10, C=6/10
Pros / cons:
A) State-driven lookup (recommended)
  ✅ Zero GPU cost; the fill level is a simple table from day/night and weather
  ✅ Deterministic, so frozen screenshots and the contrast test give stable results
  ❌ A bright area not caused by day or weather (e.g. a big glow) is not detected live
B) 2 Hz downsampled sample
  ✅ Reacts to any real brightness behind a panel, whatever caused it
  ✅ Small cost: one 16x16 read twice a second, done asynchronously in WebGL2
  ❌ Extra render target and async readback code to build and test in three browsers
C) Per-frame readPixels
  ✅ Exact brightness behind each panel on every single frame
  ✅ Simplest code to write for a first version, no extra render targets
  ❌ Stalls the GPU pipeline each frame and drops fps, worst in Safari
Net: zero-cost and predictable, against live-accurate at extra complexity or frame rate.
Header: Glass light
Options:
A) State-driven lookup (recommended)
Fill level from a table keyed by day/night phase (from chunk 34's sun angle) and weather (chunk 35): e.g. night 8%, dusk 30%, day 60%, day+heatwave 72%. No GPU readback. The D21 Playwright contrast check (forced day and night) keeps verifying real pixels. Effort: human ~1h / CC ~5 min.
B) 2 Hz downsampled sample
Render a 16x16 downsample of the scene behind each panel, read it back asynchronously twice a second (WebGL2 PBO/fence), map average luminance to fill. Effort: human ~4h / CC ~20 min; per-browser testing.
C) Per-frame readPixels
Synchronous `readPixels` under each panel every frame. Effort: human ~1h / CC ~5 min; known frame-rate cost.

State: approved
Actual answer: A) State-driven lookup (recommended), answered re-review D2 2026-10-12
Accepted scope: glass fill from a lookup table keyed by day/night phase (chunk 34 sun angle) and weather (chunk 35), e.g. night 8%, dusk 30%, day 60%, day+heatwave 72%; no GPU readback; the D21 Playwright contrast check keeps verifying real pixels.
History: none

Approval readiness (re-review): PASS. Checked R12 (re-review D1 A) and R13 (re-review D2 A). Required work E3-E7 and gaps G12-G19 cite approved design decisions D5, D6, D8, D10, D12, D13, D21, D22, D26.

### Re-review sections

- Architecture: E1 (chunk 04 size, resolved by R12), E3 (source switch reset, applied).
- Code quality: E5 mode tags, E6 safeArea resize, E7 `aria-hidden` billboards (all applied).
- Tests: new gaps G12-G19 (source switch, silent backfill, mode tags, keyboard path, attention chip, replay bar, blocked localStorage) added to chunks 12, 14, 25, 32; G15 is the safeArea resize check in 04b. Updated test plan: `~/.gstack/projects/bjorkgard-ai-center/nathanael-main-eng-review-test-plan-20261012-184333.md`.

```
NEW USER FLOWS (design D5-D26)                  COVERAGE (planned)
[+] Source switch live/mock/replay              [GAP→PLANNED] G12 totals equal live alone
[+] Startup catch-up                            [GAP→PLANNED] G13 0 toasts from backfill
[+] Toasts in replay/mock                       [GAP→PLANNED] G14 REPLAY/MOCK tag
[+] Resize with panel open                      [GAP→PLANNED] G15 safeArea rect unit test
[+] Keyboard path into scene     [→E2E]         [GAP→PLANNED] G16 Tab, Down, Enter, glide
[+] Attention chip click-through [→E2E]         [GAP→PLANNED] G17 counts + oldest waiting
[+] Replay bar                                  [GAP→PLANNED] G18 bar drives store clock
[+] Legend with storage blocked                 [GAP→PLANNED] G19 no storage errors
[+] Adaptive glass                              [★★ PLANNED] D21 pixel contrast check (day/night)
COVERAGE: 9/9 new flows have a planned test (all PLANNED, none built)
```

- Performance: E2 (no GPU readback, resolved by R13), E4 (silent backfill also avoids a render storm of toasts at launch).
- Outside voice: disabled (`codex_reviews` = disabled); no second reviewer for the re-review.
- Failure modes: no new silent failure without a test or handling. Critical gaps: 0.
- Parallelization: Lane A is now 03 → 04a → 04b → 05-10 (src/scene/, src/dashboard/ shell). Lanes B and C are unchanged.

### Re-review Implementation Tasks

- [ ] **RT1 (P1, human: ~2h / CC: ~10min)** — store — Clear store and halls on source switch
  - Surfaced by: Architecture — E3
  - Files: src/data/, src/scene/
  - Verify: G12
- [ ] **RT2 (P2, human: ~1h / CC: ~5min)** — store, alerts — Silent backfill, REPLAY/MOCK tags
  - Surfaced by: Performance — E4; Code quality — E5
  - Files: src/data/, src/dashboard/alerts
  - Verify: G13, G14
- [ ] **RT3 (P2, human: ~1h / CC: ~5min)** — layout — safeArea on resize; aria-hidden billboards
  - Surfaced by: Code quality — E6, E7
  - Files: src/dashboard/shell, src/scene/labels
  - Verify: G15; axe audit in chunk 37
- [ ] **RT4 (P2, human: ~1h / CC: ~5min)** — glass — State-driven glass fill lookup
  - Surfaced by: Performance — E2, R13
  - Files: src/dashboard/GlassPanel
  - Verify: D21 contrast check in forced day and heatwave
- [ ] **RT5 (P2, human: ~4h / CC: ~20min)** — tests — Gaps G12-G19
  - Surfaced by: Test review
  - Files: tests/
  - Verify: each gap's chunk acceptance

### Re-review Completion summary

- Step 0: Scope Challenge — scope accepted as-is
- Reality rows: 7/7 carried from the first eng review; 0 new unverified premises
- Architecture Review: 2 issues found
- Code Quality Review: 3 issues found
- Test Review: diagram produced, 8 gaps identified
- Performance Review: 2 issues found
- NOT in scope: unchanged
- What already exists: unchanged
- TODOS.md updates: 0 items proposed to user
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, disabled
- Parallelization: 3 lanes, 2 parallel / 1 sequential after merge
- Lake Score: 0/2 (picked 9/10 and 8/10 options)

### Post-review addition (2026-10-12)

Chunk 02b and decision D19 (versioning, semantic-release on every merge, single-executable builds for 4 platforms, README and CONTRIBUTING sections) were added after the reviews, at the user's request. Choices made by the user: single executable, macOS + Linux + Windows, auto release on every merge. No review has covered 02b yet; re-run `/plan-eng-review` to include it.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex via `/plan-eng-review`, `/plan-design-review` | Independent 2nd opinion | 3 | disabled | design phase used a native Claude subagent: 15 findings |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | ISSUES OPEN | 15 issues, 0 critical gaps (latest run); first run 26 issues |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | ISSUES OPEN | score: 2/10 → 7/10, 22 decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex disabled for every plan-review and design phase; only the design phase ran a native Claude subagent (in-host, not outside coverage).
- **VERDICT:** No review CLEAR. Every eng and design finding is accepted and mapped into the plan; issues_open means mapped work, not failure. Eng review required.

NO UNRESOLVED DECISIONS
