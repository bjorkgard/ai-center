# Synapse Horizon: Build Plan

A live 3D AI data-centre dashboard that tracks Claude and Codex agents and subagents, styled like a strategy game.
This file is the ordered build plan. Each chunk is small enough for one sitting, ends in something runnable, and has acceptance checks to pass before the next chunk starts.

Status legend per chunk: `[ ]` todo, `[~]` in progress, `[x]` accepted.

---

## 1. Settled decisions

| # | Decision | Source |
|---|---|---|
| D1 | All modern desktop browsers: Chrome, Safari, Firefox. WebGL perf budget applies to all three. Mobile out of scope. | Brief |
| D2 | Vite+ (`vp`) + React + TypeScript (strict) + Tailwind CSS + Three.js. pnpm, Node 24 LTS (CEO C9; was 22, whose end of life 2027-04-30 would reach shipped binaries). Vite+ bundled lint/format. | Brief, F1, F5 |
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
| D18 | Tests: Vitest (parsers, store, reconciler) and Playwright. GitHub Actions (ubuntu) runs `vp check` and `vp test` from chunk 01, Chromium + Firefox smoke from chunk 02, and the PR-title check from chunk 02b (CEO review). On the Mac, `vp run e2e:local` runs WebKit smoke, leak test, perf scenario and screenshots, and must pass before a chunk is ticked. One PR per chunk, squash-merged with a Conventional Commit title. | F3, F6, eng review D6, D19 |
| D19 | Versioning and releases: semver in `package.json` is the single source of truth. Every PR merged to main runs semantic-release: the version is bumped from Conventional Commit types (fix = patch, feat = minor, `!`/BREAKING = major), CHANGELOG.md is updated, a `vX.Y.Z` tag is pushed and a GitHub Release is created. Merges with only docs/chore/test changes make no release. From chunk 14b on (CEO C1), each release attaches single-executable builds (Node SEA: log server + built web app in one binary) for macOS arm64, macOS x64, Linux x64 and Windows x64. Users download, run and get the app at localhost with no Node or dev setup. | Added 2026-10-12 (user request) |

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

- Images live in `docs/img/NN-<slug>.png` (NN = chunk number), 1280x720 PNG, compressed under 200 KB: `scripts/shots.ts` quantizes each capture with `sharp(...).png({ palette: true, quality: 80, effort: 10 })` (`sharp` is a dev dependency, never in the SEA bundle; eng E2).
- Captured by `vp run shots` (Playwright, Chromium), which opens the app with `?source=mock&scenario=steady&seed=1&freeze=1&view=<name>`. `freeze=1` stops the animation clock at a fixed time so images are reproducible.
- Each chunk adds its view name(s) to `scripts/shots.config.ts`, so old images regenerate when the look changes.
- Exception: `14b-release.png` shows a GitHub Release page, so it is captured by hand, not by `vp run shots`.
- Exception: `03-spike.png` is captured by `vp run shots` in chunk 03, then kept as a static file when chunk 04a deletes the spike views and their shots entry (CEO RW7).
- The README is rebuilt section by section. Every chunk's README step lists exactly what to add.

README skeleton, grown over time:
1. Title, one-line pitch, hero image (latest full-campus shot).
2. Status: which chunks are done, link to this plan.
3. Download and run: pick the build for your OS from GitHub Releases, run it, and the browser opens at `http://127.0.0.1:7317` (CEO C2). Includes first-run notes for unsigned binaries (macOS Gatekeeper, Windows SmartScreen) and the `--port`, `--no-open` and `--version` flags.
4. Development setup (`vp install`, `vp dev`; Node version pin; `vp run e2e:local` on a Mac; chunk 14 adds that the log server starts with the dev server).
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

#### [x] 01. Scaffold
- **Goal:** Empty app runs, lints, tests, builds.
- **Depends on:** none.
- **Tasks:** Create the Vite+ React-TS project with pnpm: `vp create vite --no-interactive --package-manager pnpm --no-agent --hooks --no-git --directory . -- --template react-ts` (in a temp dir and copied over if `.` is refused). No generated agent files; the pre-commit `vp check` hook stays and CONTRIBUTING mentions it (eng E4). Enable TS strict. Add Tailwind CSS v4 with tokens for dark background, glass panel, cyan `#22D3EE`, Claude amber, Codex neutral, error red, plus the section 4b type/spacing/radius tokens and Geist Sans/Mono fonts (design D16), and the status colour/shape tokens (design D17). Add Vitest with one sample test. Folder layout: `src/{app,scene,dashboard,data,sim,config}`, `sidecar/`, `scripts/`, `docs/`. Add `.editorconfig`. Pin an exact Node version (`24.x.y`) with `vp env pin --target node-version 24.x.y` (without `--target`, Vite+ may write `devEngines` instead of `.node-version`); exact, so `build:bin` can look it up in nodejs.org `SHASUMS256.txt`. Set the Vite dev server host to `127.0.0.1` so `vp dev` serves the same origin the Origin check accepts (CEO C2, eng A1). GitHub Actions: `voidzero-dev/setup-vp` (Vite+ CI guide: the `v1` tag no longer updates), then install, lint, typecheck, test, build. Every `uses:` in `.github/workflows/` is a full 40-character commit SHA with a `# vX.Y.Z` comment; Dependabot updates them; a CI step fails if any `uses:` is not a SHA (CEO C7). Add `.github/dependabot.yml`: weekly `github-actions` and `npm` updates, grouped into one PR per ecosystem, `react`, `react-dom`, `@types/react` and `@types/react-dom` ignored for versions `>=19.4.0` (eng S3), titles pass the PR-title check: npm `dependencies` use `commit-message.prefix: "fix(deps)"` so shipped-library fixes cut a patch release; `prefix-development: "chore(deps)"` for devDependencies and `chore(deps)` for GitHub Actions cut none (CEO X2, C8).
- **Acceptance:** `vp dev` shows a dark page titled "Synapse Horizon" in cyan and prints a `http://127.0.0.1:` URL. `vp lint`, `vp test`, `vp build` pass locally and in CI. `.node-version` matches `24.<minor>.<patch>` exactly, and CI's `node --version` equals it. The repo's Insights > Dependency graph > Dependabot tab shows no config error for `.github/dependabot.yml`.
- **README:** Title, pitch, quick start, status line "Chunk 01 done". Image: `01-scaffold.png` (blank branded page).

#### [x] 02. Browser matrix and screenshot pipeline
- **Goal:** Every later chunk can be smoke-tested in three browsers and photographed automatically.
- **Depends on:** 01.
- **Tasks:** Playwright with Chromium, WebKit, Firefox projects. Smoke test: page loads, no console errors. `scripts/shots.ts` + `shots.config.ts` with the URL contract above (`freeze`, `seed`, `view`). Add `shots` and `e2e` scripts, run with `vp run shots` / `vp run e2e`. CI job runs smoke in Chromium and Firefox. Add `e2e:local` (all three engines, plus later leak/perf/shots) for the Mac (eng review D6).
- **Acceptance:** `vp run e2e` green in Chromium and Firefox in CI; `vp run e2e:local` green in all three engines on the Mac. `vp run shots` writes `docs/img/02-pipeline.png` under 200 KB. Running it twice gives images within a 0.5% pixel-diff threshold (eng review T2), checked with Playwright's built-in `toHaveScreenshot({ maxDiffPixelRatio: 0.005 })` rather than a custom diff.
- **README:** "Testing and screenshots" section explaining `vp run e2e` and `vp run shots`.

#### [~] 02b. Versioning, release pipeline and downloadable build
- **Goal:** Every merged PR that changes behaviour produces a versioned GitHub Release with notes and a tag, and the single-executable build is proven on the Mac (D19). The 4-OS build matrix and binary upload land in chunk 14b, once the binary tails real logs (CEO C1).
- **Depends on:** 02.
- **Tasks:**
  - **Version handling.** `package.json` `version` is the single source of truth. Vite injects it as `__APP_VERSION__`; until chunk 27 adds the user menu, the app renders it as `<meta name="app-version" content="X.Y.Z">` (the chunk 02 smoke spec asserts it equals `package.json`); chunk 27 shows it in the user menu. The binary prints it with `--version`. `CHANGELOG.md` is generated. Seed version (CEO C3): before the 02b PR merges, `package.json` is `0.1.0` and `main` carries the tag `v0.1.0`, so `feat:` gives 0.2.0, 0.3.0 and so on; 1.0.0 happens only through a deliberate `feat!:` or BREAKING commit (documented in CONTRIBUTING).
  - **PR discipline.** CI checks (on `pull_request` with types opened, edited, synchronize; never `pull_request_target`, CEO C7) that the PR title is a Conventional Commit (`feat:`, `fix:`, `docs:`, ...), since squash-merge uses it as the commit message. Add a PR template with the chunk's acceptance checklist.
  - **Release workflow** (`.github/workflows/release.yml`, on push to `main`):
    - Checkout with `fetch-depth: 0` (semantic-release needs full history and tags). `concurrency: { group: release, cancel-in-progress: false, queue: max }` so quick merges never race on the tag or the release commit and no waiting run is cancelled (the default queue holds one pending run). Merges that land while a release runs still ship together in the next version: each run checks out its own merge SHA, and semantic-release skips a run whose SHA is behind `main`, so the newest run releases every unreleased commit.
    1. Run `vp check` and `vp test`.
    2. Run semantic-release with the commit-analyzer, release-notes, changelog, exec, git and github plugins. The exec plugin's `prepareCmd` runs `node scripts/set-version.ts ${nextRelease.version}` to bump `package.json` (the npm plugin is not used: npm refuses under pnpm `devEngines`), and its `successCmd` writes `published=true` and `version=X.Y.Z` to `$GITHUB_OUTPUT`; the job exposes both as outputs (used by chunk 14b). It writes the release commit `chore(release): X.Y.Z [skip ci]`, tags `vX.Y.Z` and creates the GitHub Release.
    3. No binaries yet: the build matrix and upload are added in chunk 14b (CEO C1).
    - Permissions (eng E3): every workflow file opens with `permissions: {}`. In `release.yml`, steps 1 and 2 are two jobs: `verify` (`vp check`, `vp test`; `contents: read`) and `release` (`needs: verify`; semantic-release; `contents: write`, `issues: write`, `pull-requests: write`). In `ci.yml`, check/test/build/smoke jobs get `contents: read`; `pr-title.yml` gets `pull-requests: read`. The C7 guard step also fails when a workflow has no top-level `permissions:` key.
    - `main` protection (CEO C4): a repository ruleset on `main` requires a PR, the CI checks and the PR-title check, and blocks force pushes. The GitHub Actions app is on the bypass list so the `chore(release)` commit can push. Unverified: whether a personal-account repo can list the Actions app as a bypass actor; if not, use a deploy key that is on the bypass list and pass it to `actions/checkout` (`ssh-key`). Deploy-key fallback must also set semantic-release `repositoryUrl` to the SSH URL, or it pushes over HTTPS with `GITHUB_TOKEN` and the ruleset refuses it. Order: seed tag `v0.1.0` → merge 02b (first `release.yml` run, `main` still open) → create the ruleset naming the exact required check names from the CI and PR-title jobs of a PR run (the 02b PR itself; `release.yml` runs only on push to `main`, so its jobs must never be required) → run the ruleset acceptance check. Acceptance below proves whichever bypass is used.
  - **Serve script** `vp run serve`: runs `vp build`, then runs the bundled CLI (the same CommonJS bundle `build:bin` makes, step 2 below) with plain `node` against `dist/`, so no TypeScript runner is needed (same flags as the binary).
  - **Release config test (eng E5):** `scripts/releaserc.test.ts` in `vp test` asserts `branches: ["main"]`, plugin order (commit-analyzer, release-notes, changelog, exec, git, github), no `@semantic-release/npm` (npm refuses under pnpm `devEngines`), that the exec `prepareCmd` runs `scripts/set-version.ts` and sets the version, that each plugin `require.resolve`s, and that the exec `successCmd` writes `published` and `version`.
  - **Workflow guard (C7, E3 proof):** `scripts/check-workflows.ts` (run in `ci.yml`) with `scripts/check-workflows.test.ts` fixtures: a `uses:` tag ref fails, a workflow without top-level `permissions:` fails, a valid file passes.
  - **Local release script** `vp run release:dry`: runs semantic-release in `--dry-run` so you can see the next version and notes before merging.
  - **Server split (eng D1):** `sidecar/server.ts` exports `createServer({ port, assets })` with `checkHost()`, manifest lookup and the request handler, and has no argv, process or browser code; `sidecar/cli.ts` handles flags, listen-with-retry, opening the browser and signals. Chunk 14's plugin imports `checkHost` from `server.ts`, so the Host gate exists once. Tests: `sidecar/server.test.ts` (C6 gate, manifest, handler) and `sidecar/cli.test.ts` (flags, ports, open, signals).
  - **Server entry** `sidecar/cli.ts`: serves the built app from embedded assets on `127.0.0.1:7317` and opens the default browser at `http://127.0.0.1:<port>`; the same `127.0.0.1` string is used in the README and is the only host the Origin check accepts (CEO C2; 4317 is the OpenTelemetry collector port). Requests whose `Host` is `localhost:<port>` get a 308 redirect to `http://127.0.0.1:<port>` with the same path, so a hand-typed `localhost` URL still works. The Origin check accepts exactly `http://127.0.0.1:<port actually bound>`, including after the busy-port fallback. Host gate (CEO C6): only `Host: 127.0.0.1:<bound port>` is served; `localhost:<port>` gets the 308 above; any other Host gets 421 and one stderr line (method, path, Host). Files are served only from a manifest built at startup (the SEA asset list, or a walk of `dist/`); request paths are looked up in that manifest and never joined to a disk path. Chunk 14's WebSocket and import endpoints sit behind the same Host gate. Asset source: when `node:sea` `isSea()` is true, files come from embedded SEA assets; otherwise from `dist/` on disk.
    - Flags: `--port`, `--no-open`, `--version`, `--help`. `--version` comes from an esbuild `define` of `package.json`'s version at bundle time (a SEA binary has no `package.json` to read).
    - `sidecar/server.ts` stays loadable as ESM (Vite plugin) and as CJS (SEA bundle): no `import.meta`, no top-level await; a `no-restricted-syntax` lint rule on `MetaProperty` and top-level `await` in `sidecar/` makes `vp check` fail otherwise (eng review).
    - If the port is busy, try the next 10 ports and print the chosen URL. Busy is detected from the `listen` error (`EADDRINUSE`), never by probing first.
    - Failure behaviour: every row of the Section 2 error registry in the CEO review record is required (CEO C5), each with a Vitest case in `sidecar/server.test.ts`, `sidecar/cli.test.ts` or `scripts/build-bin.test.ts` (fetch and child processes mocked). Port tests bind ephemeral ports (`listen(0)`) and occupy them on purpose, never fixed ports, so parallel CI jobs cannot collide.
    - In Phase 0 it serves the app only; chunk 14 adds the log watcher and WebSocket to this same entry.
  - **Single executable build** `vp run build:bin`:
    1. `vp build` builds the web app.
    2. The CLI is bundled to one CommonJS file, with only pure-JS dependencies so nothing native has to be embedded. That means chokidar v4 (no fsevents) and `ws`.
    3. `build:bin` generates `sea-config.json` from the `dist/` listing on every run (SEA assets must be named one by one, and Vite file names carry content hashes), then embeds them.
    4. The SEA blob is injected with `postject` into a copy of the official nodejs.org binary for the pinned Node version, downloaded by the script and checked against nodejs.org `SHASUMS256.txt` (never the local `node`, which may be a Homebrew or shared-library build).
    5. On macOS: remove the signature, inject, then ad-hoc sign (`codesign --sign -`); Apple Silicon will not run the binary otherwise.
    - Output names: `synapse-horizon-<version>-<os>-<arch>` (`.exe` on Windows).
  - **Build matrix:** moved to chunk 14b (CEO C1). In 02b, `vp run build:bin` runs on the Mac only.
  - **CONTRIBUTING.md:** branch naming, one PR per chunk, Conventional Commit PR titles, what CI runs vs `vp run e2e:local` on the Mac, updating README and screenshots per chunk, how releases and versions happen, and that only maintainers merge to `main`. Release runbook section (Prime Directive 5, CEO Section 9): (1) bad release: revert the PR and merge it as `fix: revert <title>`, which ships a patch; never delete or move a published tag; (2) bad binaries (from 14b): `gh release edit vX.Y.Z --prerelease` and add a warning to the notes, then ship the fix; (3) tag pushed but GitHub Release missing: `gh release create vX.Y.Z --notes-file <notes from CHANGELOG>`; (4) release job red on push refusal: check the ruleset bypass (C4), re-run the job; (5) Dependabot PR fails CI: close it, pin the old version with an ignore rule, open an issue.
- **Acceptance:**
  - `vp run release:dry` prints the next version and release notes from the commits since the last tag.
  - With the `v0.1.0` seed tag in place, a `feat:` PR merges and produces a minor bump (0.2.0), a tag, a CHANGELOG entry and a GitHub Release with notes (no binaries until 14b).
  - After that release, a `docs:`-only PR merges with no release.
  - On your Mac, `vp run build:bin` produces an arm64 binary; started with `--no-open --port 4400`, `curl http://127.0.0.1:4400/` returns 200 with the app HTML and `--version` prints the `package.json` version.
  - Opening `http://localhost:4400/` on that binary redirects to `http://127.0.0.1:4400/`.
  - A PR with a non-conventional title fails the title check.
  - `vp test` covers all 14 rows of the Section 2 error registry (CEO C5).
  - Host gate and manifest tests (CEO C6): `Host: evil.example:7317` gets 421; `Host: localhost:7317` gets 308; `/../package.json`, `/%2e%2e/package.json` and `/assets/../../x` get 404; a known asset gets 200.
  - A direct push to `main` from your account is refused by the ruleset.
  - After the ruleset exists, a `fix:` PR merges and its `chore(release)` push and `vX.Y.Z` tag succeed (proves the bypass).
- **README:** Add the sections "Development setup" and "Contributing" (short, linking CONTRIBUTING.md), plus "Versioning and releases". Add a release badge. "Download and run" and image `02b-release.png` move to chunk 14b (CEO C1).

### Phase 1: Rendering spike (gate)

#### [ ] 03. R3F vs direct Three.js spike
- **Goal:** Pick the integration with numbers, not opinion.
- **Depends on:** 02.
- **Tasks:** Two throwaway views, `?view=spike-r3f` and `?view=spike-vanilla` (the shots URL contract; the app has no router, CEO RW4), each rendering the same thing: 12 hall boxes, 192 instanced racks (12 halls x 16, D8) and 3,072 instanced LEDs (16 per rack) with per-frame colour updates driven by a fake store at 10 updates/s, MeshStandardMaterial flat-shaded, one shadow-casting light, bloom on/off toggle (CEO RW5). Both views use identical renderer settings: pixel ratio `min(devicePixelRatio, 2)`, antialias on, ACES Filmic tone mapping, sRGB output, `PCFSoftShadowMap` at 2048, and the same bloom library, pmndrs `postprocessing` (R3F through `@react-three/postprocessing`); the ADR lists them (CEO RW1). Composer options are pinned in that shared constant and passed explicitly in both views, because the two entry points default differently (`@react-three/postprocessing` uses multisampling 8 and `HalfFloatType`; `postprocessing` uses multisampling 0 and `UnsignedByteType`): `multisampling: 4`, `frameBufferType: HalfFloatType`, and the bloom effect's intensity, luminance threshold and mipmap blur [values estimated; identical values in both views are the requirement] (eng E8). A churn button adds and removes 6 halls 50 times. Record per browser: CPU frame time (update + render, `performance.now()`) median, p95 and p99; the longest frame during churn, measured as the longest wall-clock interval between `requestAnimationFrame` callbacks, so React work that runs between frames counts (eng E15); GPU time where `EXT_disjoint_timer_query_webgl2` exists; fps for reference only, because on a ProMotion display Chrome and Firefox run `requestAnimationFrame` at up to 120 Hz while Safari stays near 60 by default (CEO RW2). Record `renderer.info.memory.geometries/textures` and `renderer.info.programs.length` before churn and after disposal settles (1 s after the last removal; R3F disposes unmounted objects on idle) (CEO RW3), and JS heap where available (Chromium). Measure in Chrome, Safari and Firefox on the dev Mac (M1 Max); the ADR names the machine, treats the CPU-time pick as valid (same CPU core design as the M1 Air), and labels the 1x 60 fps check "M1 Max, overstates M1 Air GPU" (CEO C11). Measuring runs use `vp build` then `vp preview --host 127.0.0.1`, never `vp run serve`: `preview.headers` in `vite.config.ts` sends COOP `same-origin` and COEP `require-corp`, so the page is cross-origin isolated and `performance.now()` steps 0.005-0.02 ms instead of 0.1-1 ms; each result records `crossOriginIsolated` and the measured timer step, and a pass whose step is coarser than 0.1 ms is `valid:false` with reason `coarse-timer`, covered by a unit test (eng E6). Each view takes `&load=1` or `&load=4` (4x instance counts: 768 racks and 12,288 LEDs at the same draw-call count) and `&bench=1`, which runs one scripted pass (warm-up, steady, churn, settle) and prints a single JSON result; the ADR's results table is built from those JSON files (CEO C10).
- **Acceptance:** Results table committed to `docs/adr/0001-render-integration.md` with a decision and reasoning. The ADR's decision rule is committed before the first measured run, and the decision follows from it; default rule: R3F unless, in any browser at 4x load, its p95 CPU frame time exceeds vanilla's by more than 1 ms or 15%, any count misses baseline after churn, or its longest churn frame (longest wall-clock frame interval during churn, eng E15) is more than 2x vanilla's [thresholds estimated] (CEO C10). Each 4x case (bloom on and off) runs three passes per browser, alternating R3F and vanilla; the rule uses the median p95 per case and counts a gap only when it is larger than both views' pass-to-pass range of p95; 1x cases run once (48 passes in all) (CEO C14). The ADR names the commit that added the rule; every result's start time is later than that commit's time, and the commit stays visible in the PR's commit list after squash-merge (CEO RW11). Both views keep a median frame interval of at most 16.7 ms (60 fps) and a p95 CPU frame time under 16.7 ms with bloom off at 1x load in all three browsers, or the ADR states which one fails and why. Geometry, texture and program counts return to baseline after disposal settles for the chosen approach. `vp test` covers every row of the bench failure registry (CEO C12) and the stats, scene and store tests; `vp run e2e:local` opens both spike views at load 1 and 4 in all three engines with no console errors (CEO C13), and the two views report equal instance counts, geometry count and draw calls per frame at each load (eng E17).
- **README:** Add "Architecture" stub noting the chosen integration and link to the ADR. Image: `03-spike.png` (spike scene).
- **Churn resources (CEO RW6):** in both views each hall owns its geometry, which is disposed when the hall is removed, and all halls share one set of materials, which must survive churn (chunk 04a: shared materials only). R3F disposes JSX-declared materials on unmount unless they are passed by prop or wrapped in `dispose={null}`; the ADR records which pattern kept shared materials alive. After churn, `renderer.info.programs.length` equals its pre-churn value and the shared materials have received 0 `dispose` events, counted through three's `dispose` event on each shared material (eng E9). Churn snapshots also record the fake store's listener count, which must return to baseline: a leaked per-hall subscription is a leak that Safari and Firefox cannot show through a heap number (CEO RW9).
- **Same work per frame (CEO RW8):** each hall owns its rack and LED InstancedMeshes (the chunk 07 pattern), so churn adds and removes them. Every frame, both views write all live LED colours from the latest store snapshot and flag one upload per mesh. Spike code allocates nothing per frame, including the bench's own sample storage, which uses typed arrays sized up front (eng P-E1). Each churn cycle waits until the view reports the added halls are in the scene (`addHalls` resolves on mount, which under React's scheduler can take more than one frame), renders one frame, then removes them, so React batching cannot skip work that the vanilla view does (eng E16).
- **Failure behaviour (CEO C12):** the Section 2 registry in the Phase 1 CEO review record is required. An interrupted pass (tab hidden or window blurred, window resized, WebGL context lost, hall component error during churn) stops and writes `valid:false` with the reason and the time; churn and bloom controls are disabled during a pass; a missing GPU timer or JS heap reads `null`, never 0; an unknown `view`, a `load` other than 1 or 4, or a malformed `bench` falls back to the home page or load 1 with a console warning naming the parameter. The shots contract parameters `source`, `scenario`, `seed` and `freeze` are accepted without warnings: the fake store is seeded from `seed`, `freeze=1` renders one fixed frame with no store ticks, and `bench=1` together with `freeze=1` is refused with a warning, since a frozen clock cannot be measured (eng E11). WebGL2 or bloom init failure shows its reason in the view and writes `valid:false`. The ADR table uses only `valid:true` passes. Unit tests on a fake clock cover one valid pass, each interruption, parameter parsing and the null cases.
- **Tests (CEO C13):** unit tests for `stats.ts` (nearest-rank median, p95 and p99; empty input gives null; the ADR names the method), the scene layout counts per load and per hall, and the seeded fake store (same seed gives the same sequence; values stay in [0,1]). Both spike views at load 1 and 4 join the `vp run e2e:local` smoke in Chromium, Firefox and WebKit (canvas present, no console errors); the spike spec is skipped when `CI` is set, so the CI Chromium and Firefox jobs do not run it. The smoke is a crash check only: headless Chromium renders on SwiftShader and Playwright's WebKit is not Safari, so no ADR number comes from a Playwright run (eng E12). The same smoke reads each view's `snapshot()` through `window.__spikeSnapshot` at load 1 and 4 and asserts equal instance counts, geometry count and draw calls per frame across the two views (eng E17).
- **Dependency guard (eng E7):** `.github/dependabot.yml` gains ignore rules for `three` and `@types/three` at `>=0.187.0` and `postprocessing` at `>=7.0.0`, with a comment naming the peer ranges they protect (`postprocessing` 6.39.5 needs `three <0.187.0`; `@react-three/postprocessing` 3.2.0 needs `postprocessing ^6.36.0`) and saying to lift each rule when that range widens.
- **Result records (CEO RW10):** each pass writes one JSON file with view, load, bloom, pass number, `valid` and reason, start time, browser name and version, `devicePixelRatio`, canvas size in pixels, measured refresh interval, GPU renderer string where exposed (else null), three and R3F versions, app version, frame statistics, counts before and after churn, and heap or null. Each result also records draw calls per frame, read with `renderer.info.autoReset = false` and one `renderer.info.reset()` per frame so every composer pass counts; the ADR shows equal counts at 1x and 4x (eng E10). Files are committed under `docs/adr/0001-results/`. The view shows a one-line status (current phase, then done or invalid with its reason), so the operator knows when a pass has ended.
- **ADR content (CEO RW12):** besides settings, method, rule, results and decision, the ADR's Consequences section lists the known follow-ons: R3F 10 is in alpha and WebGPU-first, so an R3F pick implies a later 9-to-10 migration; R3F 9's React peer range (`<19.4`, eng S3); WebGL2 only, WebGPU not measured; the 4x stress level is not the chunk 36 scene; the M1 Air-class check belongs to chunk 36 (C11).
- **Note:** Delete the spike views in chunk 04a, together with the `spike-*` entry in `scripts/shots.config.ts` (so `vp run shots` keeps passing) and any dependency the ADR rejected; `03-spike.png` stays as a static image, like `14b-release.png` (CEO RW7). Keep the ADR.

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
- **Depends on:** 11, 02b (extends `sidecar/cli.ts` and uses `vp run build:bin`).
- **Tasks:** `sidecar/plugin.ts` Vite plugin (`configureServer`) plus the existing `sidecar/cli.ts` from chunk 02b (the release binary entry), which gains the same watcher and WebSocket logic: config file with log roots (defaults `~/.claude/projects`, `~/.codex/sessions`), chokidar watch, per-file byte offset tailing (handles partial lines and file rotation), 24 h backfill, WebSocket endpoint on the dev-server origin, heartbeat. Reject WebSocket upgrades and `POST /api/import` whose `Origin` is not the app origin, and require a per-run random token injected into the served page (eng review A1). At this stage it streams raw line counts per file only (parsers come next). Backfilled events carry `backfill: true`; they update counts silently and never toast or announce (eng re-review E4); test: a backfill containing 20 errors raises 0 toasts and 0 live announcements (G13). Server sends backfill progress `{done, total}` files and the pill shows "Catching up n/N files" (design D10). Events are sent in batches (up to 500 per message) so a 24 h backfill does not flood the socket (eng review P3). Server keeps a per-file byte-offset cursor; on reconnect the client sends its last cursor and the server resumes from it (eng review Q1). App shows a connection pill (connected / reconnecting / off). When no log files are found, show the first-run card from section 4b (design D9). When the server is down, show the amber banner under the top bar (design D11).
- **Acceptance:** Appending a line to a watched file shows up in the app within 1 s. Restarting `vp dev` shows "reconnecting" in an open tab, then recovers without duplicates. A test page on another origin (e.g. `http://127.0.0.1:<other port>`) cannot open the WebSocket or call the import endpoint; a request without the token is refused. A WebSocket upgrade with `Host: evil.example:<port>` is refused by `checkHost` under both `vp dev` and the binary (eng review, C6 proof). Server refuses non-localhost connections. Unit tests for the tailer with partial-line, truncated-file and rotated-file fixtures (G1). The local `vp run build:bin` binary built from this chunk tails real logs too; the CI matrix smoke that opens the WebSocket with the injected token is added in chunk 14b. Log roots resolve with `os.homedir()` on macOS, Linux and Windows. Backfill skips files with mtime older than 24 h without reading them (G2). Restarting `vp dev` with a tab open gives identical token totals (G4). A missing or unreadable log root shows its reason in the pill and does not crash (G5).
- **README:** Quick start notes that `vp dev` also starts the log watcher; `vp run serve` for the built app. "Data sources and privacy" section: what is read, localhost only.

#### [ ] 14b. Downloadable builds for 4 platforms
- **Goal:** Every release attaches single-executable builds a user can download and run with no dev setup (D19, moved here from 02b by CEO C1).
- **Depends on:** 02b, 14.
- **Tasks:**
  - **Build matrix** in `release.yml`: `needs: release`, `if: needs.release.outputs.published == 'true'`, and checks out the new tag `v${{ needs.release.outputs.version }}` (not the merge SHA, whose `package.json` still has the old version). Runners: macos-15 (arm64; `macos-14` is removed on 2026-11-02), macos-15-intel (x64; `macos-13` was retired 2025-12-04, and GitHub drops x64 macOS when the macOS 15 image retires in fall 2027), ubuntu-latest (x64), windows-latest (x64). Each runner builds with its own official Node binary (no cross-compiling) via `vp run build:bin` and uploads to the release. Output names `synapse-horizon-<version>-<os>-<arch>` (`.exe` on Windows).
  - **Job order per OS:** build → smoke (acceptance below) → attest → upload. A failed smoke uploads nothing for that OS.
  - **Partial failure:** the matrix sets `fail-fast: false`, so one failed OS does not cancel the others. If any matrix job fails, the checksums job does not run, and a final step (`if: failure()`) builds the missing-OS list from `gh release view --json assets` and edits the release notes to start with "Incomplete: builds missing for <os list>". Re-running the failed job fills it in; the checksums job, once it runs with all 4 binaries present, removes that prefix.
  - **Checksums job** after the matrix: downloads all 4 binaries from the release, writes `SHA256SUMS.txt` and uploads it.
  - **Provenance (CEO X1):** each binary gets `actions/attest-build-provenance` (job-level permissions on the matrix jobs: `contents: write`, `id-token: write`, `attestations: write`; set per job, because workflow-level permissions would replace `contents: write` and the upload would fail with 403). Repo is public, so this is free.
- **Acceptance:**
  - A `feat:` PR merges and produces a GitHub Release with 4 binaries and `SHA256SUMS.txt`.
  - In each matrix job, a smoke step starts the binary with `--no-open --port 4400`. `curl http://127.0.0.1:4400/` returns 200 with the app HTML, `--version` prints the tag version, and the WebSocket accepts the injected token and sends a heartbeat.
  - `gh attestation verify <binary> --repo bjorkgard/ai-center` passes for every binary.
  - On your Mac, the downloaded arm64 binary starts after the Gatekeeper first-run step (macOS 15+: System Settings > Privacy & Security > Open Anyway, or `xattr -d com.apple.quarantine <file>`) and serves the app. A machine with no Node installed runs it (checked once on a clean VM or a user account without Node).
- **README:** Add "Download and run" (per-OS steps, unsigned-binary first-run notes: macOS 15 and later removed the right-click > Open bypass, so use System Settings > Privacy & Security > Open Anyway after the first blocked launch, or `xattr -d com.apple.quarantine <file>`; Windows SmartScreen "More info > Run anyway", flags, `gh attestation verify`). Image: `14b-release.png` (screenshot of the first GitHub Release page with the 4 assets), captured manually and stored in `docs/img/`.

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
- **Tasks:** Perf scenario: 12 halls, 200 racks, 400 agents, storm, night. Measure fps and p95 frame time in Chrome, Safari, Firefox on the target machine (an M1 Air-class Mac; required here because chunk 03 measured on an M1 Max, CEO C11). Auto quality tiering (shadows, bloom, pixel ratio, vapour density, glass fallback) driven by measured fps with hysteresis. Draw-call and triangle budgets enforced by a test that fails CI when exceeded.
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
     11 → 14 ─────┘ ; 02b → 14 ; 14 → 14b (downloads)
10 + 13 → 18;  13 → 19;  18 + 19 → 20 → 21 → 22 → 23
23 → 24 → 25, 26;  25 → 27 → 28, 29(+26), 30, 31 → 32(+29), 33
27 → 34 → 35 → 36 → 37
```

The data track (11-17) can run alongside world building (04-10) in a separate branch or worktree, since they share no files after chunk 01, except `sidecar/cli.ts` from 02b, which chunk 14 extends.

---

## 7. Risks and early decisions

| Risk | Why it matters | Mitigation | Settled in |
|---|---|---|---|
| R3F vs vanilla | Gates every scene chunk | Measured spike with churn test, ADR | 03 |
| Unsigned binaries | macOS Gatekeeper and Windows SmartScreen warn or block on first run | README first-run steps; ad-hoc signing on macOS so arm64 runs; Apple Developer ID notarisation is a later option | 02b, 14b |
| x64 macOS runners end (fall 2027, when the macOS 15 image retires) | No native x64 Mac build host | Before then, inject into the darwin-x64 Node binary on an arm64 runner and smoke-test under Rosetta (Rosetta on hosted runners unverified) | 14b, revisit 2027 |
| Native modules in the single executable | SEA cannot load native addons such as fsevents | Pure-JS dependencies only (chokidar v4, `ws`), checked by the per-OS smoke test | 02b, 14, 14b |
| Release bot vs protected `main` | The release commit push fails | `main` ruleset with the release bot on the bypass list (CEO C4); tag-only versioning rejected because it breaks D19 | 02b |
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

- Node version change (S2): F6/F1 kept at Node 22 LTS as approved; chunk 01 only pins it. Revisit if you want Node 24 LTS. (Superseded 2026-10-12 by CEO C9: Node 24 LTS.)
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
           ─► batch ≤500 ─► WS (Host gate C6 + Origin + token, A1) ─► store: incremental aggregates
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
- [x] **T9 (P2, human: ~1h / CC: ~5min)** — tooling — Split CI vs `e2e:local`
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
- [x] **T12 (P3, human: ~15min / CC: ~2min)** — tooling — Pin Node version and React ~19.3
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

Chunk 02b and decision D19 (versioning, semantic-release on every merge, single-executable builds for 4 platforms, README and CONTRIBUTING sections) were added after the reviews, at the user's request. Choices made by the user: single executable, macOS + Linux + Windows, auto release on every merge. No review had covered 02b before the Phase 0 CEO review below (2026-10-12); `/plan-eng-review` has still not covered it.

## CEO review record: Phase 0 (/plan-ceo-review, 2026-10-12)

Target: Phase 0 (chunks 01, 02, 02b) of `docs/PLAN.md`, branch `phase-0-tooling`, base `main` at `3432124`. Reviewer: Claude (in-host). Review depth: implementation-ready, Phase 0 only. Design doc `nathanael-main-design-20261012-synapse-horizon.md` is an earlier copy of this plan; this file supersedes it. First review to cover 02b.

### 0A. Premise

- Real problem: every later chunk needs a repeatable build, test and screenshot loop, and the user wants versioned downloadable builds (D19).
- Phase 0 ships no product. Its only user-visible output is a blank branded page. Chunk 03 (rendering spike) is the real gate, and it depends on 02, not on 02b (section 6: `01 → 02 → 02b ; 02 → 03`).
- 02b is the largest and riskiest chunk in Phase 0: semantic-release, a 4-OS CI matrix, Node SEA injection, macOS signing. Until chunk 14 the binary serves a static page with no data.
- Do-nothing cost of delaying the binary matrix: none for users (there are none yet). Cost of building it now: CI iteration on 4 runners before anything is worth downloading.

### 0B. Existing code leverage

Repo holds only `README.md` and `docs/` (`git log origin/main`: 4 commits, no code). Reuse is dependencies and tools: `vp create` (template scaffold, verified `vp create --help`), `vp env pin` (writes `.node-version`, `.nvmrc`, or `devEngines`; verified `vp env pin --help`), `voidzero-dev/setup-vp` action for CI (Vite+ CI guide), semantic-release, Playwright, Node SEA + postject.

Reality rows:
- REALITY: premise-table finding unverified=1 (Node 24 SEA asset API on all 4 OS, not probed) docs/PLAN.md:398
- REALITY: already-done pass `git log origin/main` shows docs only, no Phase 0 files docs/PLAN.md:367
- REALITY: surface-check finding runner label `macos-13` retired 2025-12-04 (GitHub changelog 2025-09-19), replacement `macos-15-intel`; `vp env pin` exists so `.nvmrc` should come from it; `setup-vp` needed in CI docs/PLAN.md:404
- REALITY: binding-decisions pass D18, D19, eng R10 (Q6 A) honoured; `gstack-decision-search` returned none for this branch docs/PLAN.md:31
- REALITY: numbers finding port 4317 is the OTLP/gRPC default and the port Claude Code's monitoring guide tells users to run a collector on; 200 KB image cap and 0.5% diff are [estimated] docs/PLAN.md:393
- REALITY: deferred-asks pass every D19 item maps to 02b docs/PLAN.md:32
- REALITY: pr-count pass no `.gstack/ship-policy.json`; plan rule is one PR per chunk, so Phase 0 is 3 PRs docs/PLAN.md:31

### 0C. Dream state

```text
  CURRENT STATE              PHASE 0                          12-MONTH IDEAL
  docs only, no code   --->  scaffold + CI + 3-browser  --->  one-click download that opens a live
                             smoke + screenshots +            campus of your real agents; every
                             versioned releases               merge ships a trusted build
```

Phase 0 moves toward the ideal. The open question is ordering, not direction.

### Decision ledger (CEO, Phase 0)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| C1 02b timing (Claude) | D19 (user, 2026-10-12); section 6 shows 02b off the 03 critical path; docs/PLAN.md:381-413 | B: 02b keeps versioning, PR checks, semantic-release, CONTRIBUTING, CLI, local `build:bin` on the Mac; 4-OS matrix and binary upload move to new chunk 14b | none | approved | Q1 answer "Split: release now, 4-OS matrix with log server (recommended)", 2026-10-12; scope: timing of the 4-OS matrix only, D19 otherwise unchanged; applied to D19, chunks 02b, 14, 14b, sections 6 and 7 |
| C2 default port (Claude) | README item 3 and 02b CLI use 4317, docs/PLAN.md:137,396; 4317 is the OTLP/gRPC default and Claude Code's monitoring guide sets collectors to `localhost:4317`; README opens `localhost` while CLI binds `127.0.0.1` (Origin check, eng A1) | 7317 on `127.0.0.1` everywhere | none (was 4317, mixed host strings) | approved | Q6 answer "7317 on 127.0.0.1 (recommended)", 2026-10-12; scope: default port and host string; applied to README item 3 and 02b CLI |
| C3 first release version (Claude) | D19; no tags exist (`git tag -l` empty); semantic-release starts at 1.0.0 with no tag; 02b acceptance expects "minor bump" | seed tag `v0.1.0` before 02b merges | none (was: first release 1.0.0) | approved | Q7 answer "Seed tag v0.1.0 (recommended)", 2026-10-12; scope: starting version and 02b acceptance order; applied to 02b |
| C4 release push to `main` (Claude) | 02b and risk table leave protected-main open, docs/PLAN.md:391; `main` is unprotected today (`gh api .../branches/main/protection` 404, rulesets `[]`); CONTRIBUTING says only maintainers merge | ruleset on `main` (PR, CI, title check, no force push) with GitHub Actions bypass; deploy-key fallback | none | approved | Q8 answer "Ruleset + Actions bypass (recommended)", 2026-10-12; scope: release push and `main` protection; applied to 02b and risk table |
| C5 Phase 0 error handling (Claude, Section 2) | Prime Directives 1-2; chunk 02b CLI, `build:bin`, shots have no failure behaviour; docs/PLAN.md chunk 02b | Section 2 registry required, 14 Vitest cases | none | approved | Q10 answer "Adopt registry + tests (recommended)", 2026-10-12; scope: Phase 0 CLI, build:bin, release, shots failure behaviour and their tests; applied to 02b |
| C6 CLI Host check + asset map (Claude, Section 3) | D16 "nothing leaves localhost"; eng A1 Origin/token only covers WebSocket and import (chunk 14); 02b CLI serves files with no Host check; `dist/` mode can join request paths to disk | Host allowlist (`127.0.0.1:<port>`; `localhost:<port>` 308; else 421) + manifest-only serving + 5 tests | none | approved | Q11 answer "Host allowlist + file manifest (recommended)", 2026-10-12; scope: CLI HTTP serving in 02b and the gate chunk 14 endpoints sit behind; applied to 02b |
| C7 CI action pinning (Claude, Section 3) | release.yml holds `contents: write`, 14b adds `id-token: write`; X2 Dependabot approved | full commit SHA pins with version comment + guard step; title check on `pull_request` | none (was: exact version tags) | approved | Q12 answer "SHA pins + pull_request (recommended)", 2026-10-12; scope: all workflow `uses:` lines and the title-check trigger; applied to 01 and 02b |
| C8 Dependabot commit prefix (Claude, Section 4) | X2 (Q4) approved `chore(deps):` for all updates; `chore` cuts no release (D19), so runtime dependency fixes (`ws`, chokidar, later) never reach a binary | runtime deps `fix(deps):`, dev deps and actions `chore(deps):` | none (was: all `chore(deps):`) | approved | Q13 answer "fix(deps) for runtime deps (recommended)", 2026-10-12; scope: Dependabot commit prefixes only, rest of X2 (Q4) unchanged; applied to 01 |
| C9 Node major for pin and binaries (Claude, Section 10) | D2 "Node 22 LTS" (F1), eng S2 deferred a Node 24 switch; new evidence: D19 binaries embed the Node runtime, so its EOL reaches users. Node 22 end of life 2027-04-30, Node 24 2028-04-30 [from Node release schedule, not re-checked live] | Node 24 LTS for pin, CI, `build:bin` and 14b | none (was: Node 22) | approved | Q14 answer "Node 24 LTS (recommended)", 2026-10-12; scope: Node major in D2 and chunk 01 pin, flowing to CI and binaries; supersedes eng S2 deferral; applied to D2, 01 |

### Answered decision C1 (Q1)
Answer: B, "Split: release now, 4-OS matrix with log server (recommended)", 2026-10-12.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Version source, `__APP_VERSION__`, `--version` | D19 approved | 02b | 02b | 02b | later chunk |
| PR-title check, PR template, CONTRIBUTING.md | D18, D19 approved | 02b | 02b | 02b | later chunk |
| semantic-release: tag, CHANGELOG, GitHub Release on merge | D19 approved | 02b | 02b | 02b | later chunk |
| `sidecar/cli.ts` serving built app | D19 approved | 02b | 02b | 02b (local) | later chunk |
| Local `vp run build:bin` on the Mac (proves SEA works) | D19 approved | 02b | 02b | 02b | later chunk |
| 4-OS CI build matrix attaching binaries to each release | D19 approved | 02b | 02b | new chunk 14b, after log server | later chunk |
| Releases before 14b carry binaries | D19 approved | yes | yes | no, notes and tag only | no releases |
| Factual fixes (runner label, Gatekeeper, port) | at Q1 time pending; since resolved (runner and Gatekeeper applied as corrections, port by C2) | - | - | - | - |

Question: Q1 — C1: When should the 4-platform downloadable build land?
Project/branch/task: Synapse Horizon, branch phase-0-tooling, Phase 0 chunk 02b.
ELI10: Chunk 02b sets up automatic version numbers and also builds a download for Mac, Linux and Windows on every release. Until chunk 14 that download only shows an empty page, because the log reader does not exist yet. The 4-platform build is the slowest, most fiddly part of Phase 0, and nothing else waits for it: the rendering spike (chunk 03) only needs chunk 02.
Stakes if we pick wrong: Build it now and days go into CI debugging for an empty download; push it all later and packaging surprises land when the log server is also new.
Recommendation: B because it proves the single-file build works on your Mac now and moves only the 4-runner matrix to when a download is worth having.
Note: options differ in kind, not coverage — no completeness score.
Net: early proof of packaging plus fast path to the spike, versus full release automation before any product exists.
Header: 02b timing
A) Keep 02b as written
Everything in 02b stays in Phase 0: versioning, release notes, CLI, local build and the 4-OS matrix on every release. Effort L (human ~2 days / CC ~1.5h, plus CI wait time), risk medium. ✅ D19 is delivered exactly as you asked it, with downloads from the first release ✅ Packaging problems on Windows and Intel Mac surface while the code is tiny ❌ Slowest chunk in Phase 0, debugged on 4 runners, for a binary that shows an empty page until chunk 14
B) Split: release now, 4-OS matrix with log server (recommended)
02b keeps versioning, PR checks, semantic-release, CONTRIBUTING, the CLI and a local `vp run build:bin` proven on your Mac. The 4-OS CI matrix and binary upload move to a new chunk 14b right after the log server. Effort M (human ~1 day / CC ~45 min), risk low. ✅ SEA packaging is still proven early on your Mac, so the pure-JS rule is tested from day one ✅ Spike chunk 03 starts sooner; the matrix is built once the binary does real work ❌ Releases before 14b have notes and tags but no downloads, a temporary change to D19
C) Move all of 02b after chunk 14
No versioning or releases until the log server exists; Phase 0 is only 01 and 02. Effort S now (zero implementation work in Phase 0), risk medium later. ✅ Shortest path to the rendering spike, Phase 0 shrinks to two chunks ✅ Release work happens once, against a binary that already tails real logs ❌ Conventional Commit discipline and changelog start late, so early history is unversioned

### Mode

SELECTIVE EXPANSION, chosen by the user over the recommended SCOPE REDUCTION (Q2, 2026-10-12). Applies to all later sections. Hold-scope checks: about 28 planned files [estimated], one new service (`sidecar/cli.ts`); no deferral proposed beyond C1. Invariants: D18 CI split (eng R10), D19 except the C1 timing change.

### Cherry-pick candidates (all answered)

| ID | Proposal | Effort | Risk | Status |
|---|---|---|---|---|
| X1 | Build provenance attestations on release binaries (`actions/attest-build-provenance`), README shows `gh attestation verify` | S | low | ACCEPTED (Q3, 2026-10-12) into chunk 14b |
| X2 | Dependabot for GitHub Actions and npm, so the exact-pinned `setup-vp` and dev tools stay current | S | low | ACCEPTED (Q4, 2026-10-12) into chunk 01 |
| X3 | `vp run doctor`: checks Node pin, Playwright browsers incl. WebKit, `gh` auth, and prints the fix for each miss | S | low | DEFERRED (Q5, 2026-10-12) to TODOS.md |

Rejected without asking (breaks an approved contract): update check in the binary that calls GitHub on start. D16 says nothing leaves localhost.

### Scope document approval

Q9 (2026-10-12): "Approve and continue (recommended)". Accepts the working plan and CEO summary as of this point; open unknowns stay listed as reviewer concerns.

Spec review loop: 3 refuter runs, scores 5, 7, 7. 39 issues found; 32 confirmed fixed by a later run; 7 from run 3 fixed and checked by Claude line by line (issues verified: 7 of 7); spec not re-verified after those fixes.

### 0I. Temporal interrogation (Phase 0)

```text
  HOUR 1 (foundations):  `vp create` React-TS template, `vp env pin 24.x.y`, Tailwind v4 + tokens,
                         dev host 127.0.0.1, CI with setup-vp exact pin, Dependabot.        [chunk 01]
  HOUR 2-3 (core logic): Playwright 3 projects, smoke spec, shots script + URL contract,
                         e2e vs e2e:local split (eng R10).                                   [chunk 02]
  HOUR 4-5 (integration): seed tag v0.1.0, semantic-release + exec outputs, PR-title check,
                         CLI server (port fallback, redirect, Host/Origin), build:bin with
                         official Node + postject + ad-hoc codesign, ruleset after merge.     [chunk 02b]
  HOUR 6+ (polish/tests): CLI unit tests, release:dry, CONTRIBUTING, README sections.         [chunk 02b]
```

What will surprise the implementer:
- `postject` on macOS needs the signature removed first (`codesign --remove-signature`), then `--macho-segment-name NODE_SEA`, then ad-hoc sign; on Windows no signing step.
- SEA bundles must be CommonJS: shared server code used by both the Vite plugin (ESM) and the CLI bundle must avoid `import.meta` and top-level await.
- The ruleset's required checks must come from PR-run job names, not `release.yml`.

Feasibility blockers: none found. Unverified: Actions app as ruleset bypass actor on a personal repo (deploy-key fallback written in); Node 24 SEA assets on all 4 OS (proved per OS in 14b).

Effort: 01 human ~4h / CC ~20 min; 02 human ~4h / CC ~20 min; 02b human ~1 day / CC ~45 min [estimated, scaffolding ratio ~100x, features ~30x].

### Section 1: Architecture

```text
 developer Mac                         GitHub
 vp dev (127.0.0.1) -> Vite app        PR -> ci.yml (check, test, build, Chromium+Firefox smoke), pr-title.yml
 vp run e2e:local (3 engines, shots)   merge -> release.yml (concurrency: release)
 vp run build:bin                         -> check, test -> semantic-release -> tag, CHANGELOG commit (ruleset bypass), Release
   vp build -> dist/                      -> outputs published/version -> [14b: matrix -> smoke -> attest -> upload -> SHA256SUMS]
   esbuild sidecar/cli.ts -> CJS
   gen sea-config.json from dist/
   official node + postject + codesign -> synapse-horizon-<v>-<os>-<arch>
 user -> binary -> 127.0.0.1:7317 (localhost:* -> 308) -> embedded assets (isSea) | dist/
```

- A-1 [P3] Shared server code must run in the ESM Vite plugin and the CJS SEA bundle (no `import.meta`, no top-level await). Factual constraint of the approved approach; recorded in 0I.
- A-2 [P3] (confidence 9/10) docs/PLAN.md chunk 02b "the app shows it in the user menu": the user menu arrives in chunk 27, so Phase 0 had no visible version. Sequencing correction, applied: `<meta name="app-version">` until 27, asserted by the 02 smoke spec.
- SPOF: semantic-release on `main` (blocks releases only). Rollback: revert PR, `fix:` release. Value test: CHANGELOG, Releases and attestations are user-requested (D19, Q3).

### Section 2: Error & Rescue Map (adopted, C5 / Q10)

The plan names happy paths for the CLI, `build:bin`, release and shots but no failure behaviour. Proposed registry:

```text
  CODEPATH                    | WHAT CAN GO WRONG                     | ERROR
  ----------------------------|---------------------------------------|---------------------------
  cli: parse flags            | unknown flag, --port not 1-65535      | UsageError
  cli: listen                 | port busy (incl. race with 2nd copy)  | EADDRINUSE
                              | all 11 ports busy                     | PortsExhausted
                              | port < 1024 without rights            | EACCES
  cli: startup self-check     | index.html missing (SEA or dist/)     | IncompleteBuild
  cli: open browser           | no opener (headless Linux, SSH)       | OpenFailed
  cli: request                | unknown /assets/* path                | NotFound
                              | handler throws                        | Error (uncaught in handler)
  cli: SIGINT/SIGTERM         | open sockets                          | -
  build:bin: fetch node       | network error / 5xx                   | FetchError
                              | SHASUMS256 mismatch                   | ChecksumMismatch
  build:bin: postject/codesign| tool missing or non-zero exit         | ToolFailed
  release: semantic-release   | push refused (ruleset), GitHub 5xx    | job failure
  shots                       | console error, image > 200 KB         | ShotFailed

  ERROR            | RESCUED | ACTION                                         | USER SEES
  -----------------|---------|------------------------------------------------|-----------------------------------
  UsageError       | Y       | print usage, exit 2                            | "unknown flag --x" + help
  EADDRINUSE       | Y       | listen on next port (detect on listen, no probe)| "7317 busy, using 7318" + URL
  PortsExhausted   | Y       | exit 1                                         | "ports 7317-7327 busy; use --port"
  EACCES           | Y       | exit 1                                         | "no permission for port N"
  IncompleteBuild  | Y       | exit 1 before listening                        | "build is incomplete: index.html missing"
  OpenFailed       | Y       | warn, keep serving                             | "open this URL: http://127.0.0.1:7317"
  NotFound         | Y       | 404; other non-asset paths get index.html      | 404 for bad asset only
  handler Error    | Y       | 500, log method+path+stack to stderr, serve on | 500 for that request only
  SIGINT/SIGTERM   | Y       | close server, exit 0                           | "stopped"
  FetchError       | Y       | retry 3x (1s, 2s, 4s), then exit 1             | URL tried + last error
  ChecksumMismatch | Y       | delete file, exit 1, no retry                  | expected vs actual hash
  ToolFailed       | Y       | exit 1 with tool stderr                        | which step failed
  release failure  | Y       | job fails, GitHub emails; runbook (Section 9)  | red run, no tag or partial tag
  ShotFailed       | Y       | exit 1 naming view and reason                  | "view home: 236 KB > 200 KB"
```
No catch-alls: the request handler catches per request only, never process-wide.

### Section 3: Security & threat model

| Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|
| S-1 DNS rebinding + path traversal on CLI reads local files incl. `~/.claude` | Low-Med | High | C6 (Q11): Host allowlist + manifest-only serving + tests |
| S-2 Mutable action tags in workflows with `contents: write` / `id-token: write`; `pull_request_target` title check | Low | High | C7 (Q12): SHA pins + guard step; `pull_request` trigger |
| Vite dev server rebinding | Low | Med | OK: dev host 127.0.0.1 and Vite's default `allowedHosts` |
| Unsigned binary tampering | Low | High | OK: X1 attestations (14b) |
| Secrets | - | - | OK: `GITHUB_TOKEN` only; deploy key (C4 fallback) as repo secret |

### Section 4: Data flow and interaction edge cases

Release flow under concurrent merges (invariant: every behaviour-changing merge lands in some release, none twice):

```text
  time   merge M1 run            merge M2 run              shared: main HEAD / tags
  t0     start, analyse M1                                 HEAD=M1, last tag v0.2.0
  t1                             queued (concurrency)       HEAD=M2
  t2     semantic-release sees local behind remote -> "won't publish", exits 0
  t3                             start, analyse M1+M2       
  t4                             tag v0.3.0, push commit    HEAD=release commit, tag v0.3.0
  alt    if M3 arrives at t1.5: with `queue: max` both wait; M2 run skips (behind main), M3 run analyses M1+M2+M3
```
Mechanism: `concurrency: release` with `queue: max` (one running, the rest queued FIFO, none cancelled; PR #1 review) plus semantic-release's behind-remote check. Order M2-before-M1 cannot happen: runs start in push order. Regression proof: the 02b acceptance merges are sequential; concurrent case is not automated (GitHub-side behaviour) and relies on the two documented mechanisms.

CLI request flow: `INPUT (Host, path) -> Host gate -> decodeURI once -> manifest lookup -> bytes`. Shadow paths: bad Host 421; malformed percent-encoding 400; `..`, `%2e%2e`, double-encoded 404 (not in manifest); missing manifest entry for non-asset path -> index.html; asset 404; handler throw 500 (Section 2). Tested by C5 and C6 cases.

| Interaction | Edge case | Handled | How |
|---|---|---|---|
| start binary twice | both pick 7317 | Y | `EADDRINUSE` on listen, second moves to 7318 (C5) |
| open `localhost:7317` | Origin mismatch later | Y | 308 to `127.0.0.1` (C2) |
| close browser tab | server keeps running | Y | by design; Ctrl+C stops (C5 SIGINT row) |
| headless/SSH start | no browser | Y | prints URL (C5 OpenFailed) |
| Dependabot runtime bump | no release | Y | `fix(deps)` prefix (C8) |

C8 (Q13) applied: runtime dependency updates cut a patch release.

### Section 5: Code quality

- Q-1 [P3] CLI request handler must stay at or under 5 branches: split into `checkHost()`, `resolveAsset()` and `serve()`. Implementation guidance within C5/C6, no behaviour change.
- Q-2 [P3] Shots URL contract (`source`, `scenario`, `seed`, `freeze`, `view`) exists before any of those features; the Phase 0 app must ignore unknown params rather than validate them, so 02 does not fake features. No decision.
- No duplicated behaviour (no code exists yet).

### Section 6: Test review

```text
  NEW ITEM                         TYPE         HAPPY                         FAILURE                         EDGE
  chunk 01 page + tokens           E2E smoke    title, cyan, meta version     console error fails smoke       -
  CLI flags                        unit         --version, --help             bad flag exit 2                 --port 0/65536
  CLI listen                       unit         binds 127.0.0.1:<port>        all 11 busy exit 1              race: 2 starts
  CLI Host gate + manifest (C6)    unit         asset 200                     foreign Host 421                %2e%2e, /../, double-encoded
  CLI localhost redirect (C2)      unit         308 same path                 -                               query string kept
  build:bin node fetch             unit(mock)   checksum ok                   mismatch, 3x 5xx                -
  build:bin output                 local manual curl 200, --version           -                               -
  release flow                     live (02b)   v0.2.0 tag + notes            docs-only no release            fix: after ruleset (bypass)
  PR title check                   live (02b)   feat: passes                  "Update stuff" fails            edited title re-runs
  action SHA guard (C7)            CI step      all SHAs pass                 tag ref fails                   -
  shots                            local        image < 200 KB                > 200 KB fails                  2 runs within 0.5% diff
```
Assertions (no_claim): CLI unit tests mock no network but run real `http`, no_claim=SEA asset path (proved by local build:bin and 14b smoke); build:bin fetch tests mock fetch, no_claim=real nodejs.org availability; release flow is proved only by live merges, no_claim=concurrent-merge behaviour (Section 4).
2am Friday test: the 14b clean-machine run of a downloaded binary. Hostile QA: rebinding request with `Host: attacker:7317` (C6 test). Chaos: kill the release job after tag push (runbook item 3).
Flakiness: shots pixel diff (approved 0.5% threshold); port tests use ephemeral ports (applied). Pyramid: unit-heavy, two live checks; fine.

### Section 7: Performance

- Binary size about 100-120 MB per OS [estimated: Node 24 runtime plus a few MB of assets], 4 per release from 14b. No decision; noted in README "Known limits" at 14b.
- CLI startup: manifest walk of `dist/` (tens of files) [estimated < 50 ms]. Release workflow re-runs `vp check`/`vp test` already run on the PR; accepted cost for a protected tag.
- No issues requiring a decision.

### Section 8: Observability

- CLI: one startup line (version, URL, `sea` or `dist` mode); one line per 421 and 500 (method, path, Host); port fallback line. All in C5/C6.
- Release: GitHub run log plus failure email; semantic-release prints "no release" reason in the log. No dashboard needed for a single-maintainer tool. No gaps requiring a decision.

### Section 9: Deployment and rollout

- Rollout order per chunk: PR CI green, `vp run e2e:local` on the Mac, squash-merge, release job, (14b) matrix.
- Rollback: release runbook added to CONTRIBUTING (Prime Directive 5, required launch scope, applied to 02b): revert as `fix:`, never move tags, prerelease-flag bad binaries, recreate a missing Release, ruleset push failures, failing Dependabot PRs.
- Post-release check: 02b acceptance (tag, notes, CHANGELOG); 14b smoke and attestation verify.
- Feature flags: none needed; no runtime behaviour to toggle in Phase 0.

### Section 10: Long-term trajectory

- Reversibility 4/5: semantic-release, Dependabot and the CLI are swappable; published tags and version numbers are permanent.
- Debt: x64 macOS runner end (fall 2027, risk row added); deploy-key fallback unverified; Node 26 move before 2028-04-30 for long-lived downloads.
- C9 (Q14) applied: Node 24 LTS replaces 22 (binaries embed the runtime; 22 ends 2027-04-30).
- Platform potential: the CLI's Host gate and manifest serving are the base chunk 14 builds on; the release pipeline serves every later chunk.
- Retrospective on cherry-picks: X1 and X2 fit; X2 needed the C8 refinement; X3 deferral blocks nothing.

### Section 11: Design and UX

Phase 0 UI is one blank branded page (chunk 01) plus a hidden version meta tag. Tokens, fonts and colours come from the design review (D16, D17). States: no loading, empty or error states exist yet. Findings: none. Full design coverage already exists (`/plan-design-review`, 2026-10-12).

### Approval readiness

Checked rows and answers: C1 (Q1), X1 (Q3), X2 (Q4), X3 deferred (Q5), C2 (Q6), C3 (Q7), C4 (Q8), scope documents (Q9), C5 (Q10), C6 (Q11), C7 (Q12), C8 (Q13), C9 (Q14). Mode: Q2 (SELECTIVE EXPANSION, user choice; not a remedy approval). Required work without a new choice, each citing its contract: spec-review corrections (D19 behaviour, runner retirement, Gatekeeper path), A-2 version meta (D19 `__APP_VERSION__`), release runbook (Prime Directive 5), ephemeral-port tests (C5), stale diagram fix (C6). Every plan edit maps to one of these; no unanswered remedy is in the plan.

Approval readiness: PASS

### NOT in scope

- Deferred: `vp run doctor` (X3, Q5); in TODOS.md, trigger is a second contributor or a fresh-machine setup.
- Rejected: binary update check against GitHub (breaks D16; not asked).
- Rejected by user choice: SCOPE REDUCTION mode (Q2); Node 22 (Q14); exact-tag action pins (Q12).
- Moved, not cut: 4-OS binary matrix and "Download and run" README to chunk 14b (C1, Q1).

### What already exists

Repo holds `README.md`, `docs/PLAN.md`, `.gitignore`; no code. Reused tools: `vp create`, `vp env pin` (verified by `--help`), `voidzero-dev/setup-vp`, semantic-release plugins, Playwright, Node SEA + `postject`, `actions/attest-build-provenance`, Dependabot. Nothing is rebuilt.

### Dream state delta

After Phase 0: scaffold, CI, 3-engine smoke, screenshots, versioned releases, a CLI that serves only its own files on its own address, and a SEA binary proven on the Mac. Still missing from the 12-month ideal: live data (chunks 11-17), downloads for all 4 platforms (14b), the campus itself (03-10).

### Error and rescue registry

See "Section 2: Error & Rescue Map (adopted, C5 / Q10)": 14 codepath rows, all rescued, all with a named user message and a test.

### Failure modes registry

```text
  CODEPATH                 | FAILURE MODE                  | RESCUED? | TEST?        | USER SEES?                  | LOGGED?
  -------------------------|-------------------------------|----------|--------------|-----------------------------|--------
  cli listen               | port busy / race / exhausted  | Y        | Y (unit)     | fallback line / exit msg    | Y
  cli Host gate (C6)       | rebinding Host                | Y        | Y (unit)     | 421                         | Y
  cli asset lookup (C6)    | traversal, unknown asset      | Y        | Y (unit)     | 404                         | N (by design)
  cli handler              | throw                         | Y        | Y (unit)     | 500 for that request        | Y
  cli startup              | incomplete build              | Y        | Y (unit)     | exit msg                    | Y
  cli open browser         | no opener                     | Y        | Y (unit)     | URL printed                 | Y
  build:bin fetch          | network / checksum            | Y        | Y (unit)     | URL + error / hashes        | Y
  build:bin tools          | postject/codesign fail        | Y        | Y (unit)     | failing step                | Y
  release.yml              | push refused, GitHub 5xx      | Y        | live only    | red run + email; runbook    | Y
  release.yml              | concurrent merges             | Y        | N (GitHub)   | none needed (Section 4)     | Y
  14b matrix               | one OS fails                  | Y        | live only    | "Incomplete: ..." notes     | Y
  shots                    | console error, size           | Y        | Y            | view + reason               | Y
```
CRITICAL GAPS: 0. (S-1 was one; closed by C6, pending implementation.)

### Scope expansion decisions

From `~/.gstack/projects/bjorkgard-ai-center/ceo-plans/2026-10-12-phase-0-tooling.md`:
- Accepted: X1 provenance attestations (14b), X2 Dependabot (01).
- Deferred: X3 `vp run doctor` (TODOS.md).
- Skipped: binary update check.

### Diagrams produced

System architecture (Section 1), data flow with shadow paths (Section 4 CLI request flow), concurrency schedule (Section 4), test map (Section 6), error flow (Section 2 registry), deployment sequence and rollback (Section 9 and CONTRIBUTING runbook), temporal sequence (0I). State machine: none new (CLI is stateless per request).

### Stale diagram audit

- Section 3 architecture picture: accurate (log server as Vite plugin).
- Section 6 dependency summary: updated (02b -> 14, 14 -> 14b).
- Eng review "Data path" diagram: was stale (no Host gate); fixed to show C6.
- Eng review hall lifecycle diagram: unaffected.

### Reality rows

- REALITY: premise-table finding unverified=3 (Node 24 SEA assets on 4 OS; Actions app as ruleset bypass on personal repo; Rosetta on hosted runners) docs/PLAN.md:528
- REALITY: already-done pass `git log origin/main` shows docs only; no Phase 0 files docs/PLAN.md:367
- REALITY: surface-check finding `macos-13` retired, `vp env pin` and `setup-vp` verified, port 4317 = OTLP; all applied docs/PLAN.md:397
- REALITY: binding-decisions finding D2 Node 22 reopened with new evidence and changed to 24 (Q14); D18, D19, eng R10 honoured docs/PLAN.md:15
- REALITY: numbers finding binary size, startup time and effort figures are [estimated]; Node EOL dates from third-party trackers, not schedule.json docs/PLAN.md:528
- REALITY: deferred-asks pass every D19 item maps to 02b or 14b; X3 in TODOS.md docs/PLAN.md:394
- REALITY: pr-count pass no ship policy; one PR per chunk gives 3 PRs for Phase 0 (01, 02, 02b) docs/PLAN.md:371

## Implementation Tasks (CEO review, Phase 0)

Synthesized from this review's findings. Each task derives from a specific finding above. Effort ratios assumed: scaffolding ~100x, features ~30x, tests ~50x human/CC.

- [x] **T1 (P1, human: ~2h / CC: ~10min)** — sidecar/cli — Host gate and manifest-only serving with 5 tests
  - Surfaced by: Section 3 — S-1, C6 (Q11)
  - Files: sidecar/cli.ts, sidecar/cli.test.ts
  - Verify: `vp test` Host 421/308, traversal 404, asset 200
- [x] **T2 (P2, human: ~4h / CC: ~30min)** — sidecar/cli, scripts — Error registry behaviour with 14 tests
  - Surfaced by: Section 2 — C5 (Q10)
  - Files: sidecar/cli.ts, sidecar/cli.test.ts, scripts/build-bin.ts, scripts/build-bin.test.ts, scripts/shots.ts
  - Verify: `vp test` covers all 14 rows
- [x] **T3 (P2, human: ~1h / CC: ~5min)** — tooling — Node 24 exact pin, dev host 127.0.0.1, SHA-pinned actions with guard, Dependabot with prefixes
  - Surfaced by: C7 (Q12), C8 (Q13), C9 (Q14), X2 (Q4)
  - Files: .node-version, vite.config.ts, .github/workflows/ci.yml, .github/dependabot.yml
  - Verify: chunk 01 acceptance; guard step fails on a tag ref
- [x] **T4 (P2, human: ~2h / CC: ~15min)** — release — Seed tag, fetch-depth, concurrency, exec outputs, `pull_request` title check
  - Surfaced by: C3 (Q7), C7 (Q12), spec review run 1
  - Files: .github/workflows/release.yml, .github/workflows/pr-title.yml, .releaserc.json, package.json
  - Verify: `vp run release:dry`; 02b acceptance merges
- [ ] **T5 (P2, human: ~30min / CC: ~5min)** — repo settings — `main` ruleset after 02b merge, bypass proof
  - Surfaced by: C4 (Q8), spec review run 3
  - Files: none (GitHub ruleset); CONTRIBUTING.md
  - Verify: direct push refused; `fix:` release after ruleset succeeds
- [x] **T6 (P2, human: ~3h / CC: ~20min)** — build — `build:bin` with official Node 24, checksum check, generated sea-config, ad-hoc sign
  - Surfaced by: spec review runs 1-2, C9 (Q14)
  - Files: scripts/build-bin.ts, package.json
  - Verify: local binary curl 200, `--version`, localhost 308
- [x] **T7 (P3, human: ~30min / CC: ~5min)** — app — `app-version` meta tag asserted by smoke spec
  - Surfaced by: Section 1 — A-2
  - Files: index.html or src/app, e2e/smoke.spec.ts
  - Verify: `vp run e2e`
- [x] **T8 (P3, human: ~30min / CC: ~5min)** — docs — Release runbook in CONTRIBUTING
  - Surfaced by: Section 9 (Prime Directive 5)
  - Files: CONTRIBUTING.md
  - Verify: five runbook cases present
- [ ] **T9 (P2, human: ~1 day / CC: ~1h)** — release (chunk 14b) — Gated 4-OS matrix, tag checkout, fail-fast off, checksums job, job-level permissions, attestations, Gatekeeper README
  - Surfaced by: C1 (Q1), X1 (Q3), spec review runs 1-3
  - Files: .github/workflows/release.yml, README.md
  - Verify: chunk 14b acceptance

### Completion summary

```text
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | docs-only repo; 02b never reviewed; macos-13|
  |                      | retired; 4317 = OTLP port; main unprotected |
  | Step 0               | C1 split 02b/14b; X1, X2 in; X3 deferred;   |
  |                      | C2 port, C3 seed tag, C4 ruleset            |
  | Section 1  (Arch)    | 2 issues found (A-1, A-2)                   |
  | Section 2  (Errors)  | 14 error paths mapped, 0 GAPS after C5      |
  | Section 3  (Security)| 2 issues found, 2 High impact (C6, C7)      |
  | Section 4  (Data/UX) | 5 edge cases mapped, 0 unhandled (C8)       |
  | Section 5  (Quality) | 2 issues found (P3 guidance)                |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 0 issues found                              |
  | Section 8  (Observ)  | 0 gaps found                                |
  | Section 9  (Deploy)  | 1 risk flagged (runbook, applied)           |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 3 (+C9)     |
  | Section 11 (Design)  | 0 issues                                    |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (5 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 14 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 12 total, 0 CRITICAL GAPS                   |
  | TODOS.md updates     | 1 item (X3)                                 |
  | Scope proposals      | 3 proposed, 2 accepted (EXP + SEL)          |
  | CEO plan             | written                                     |
  | Outside voice        | codex disabled (config); none ran           |
  | Lake Score           | 4/4 recommendations chose complete option   |
  | Diagrams produced    | 7 (arch, flow, schedule, tests, errors,     |
  |                      | deploy/rollback, temporal)                  |
  | Stale diagrams found | 1 (eng data path; fixed)                    |
  | Unresolved decisions | 0                                           |
  | Reality rows         | 7/7 rows, 3 unverified                      |
  +====================================================================+
```

### Unresolved decisions

None. Open verifications (not decisions): ruleset bypass actor on a personal repo, Node 24 SEA on 4 OS, Rosetta on hosted runners.

## Eng review record: Phase 0 (/plan-eng-review, 2026-10-12)

Target: `docs/PLAN.md` Phase 0 (chunks 01, 02, 02b) and chunk 14b, branch `phase-0-tooling`, base commit `3432124` plus uncommitted CEO review edits. Reviewer: Claude (in-host). Settled input: CEO decisions C1-C9 and X1-X3 (Q1-Q14). Design doc: `docs/designs/phase-0-tooling.md` (the promoted CEO summary; consistent with this plan). Question numbers D1+ below are this review's own sequence.

### Scope Challenge

- Existing solutions: `vp create` (template), `vp env pin`, `setup-vp`, semantic-release + `@semantic-release/exec` 7.1.0, Playwright `toHaveScreenshot` (built-in pixel diff with `maxDiffPixelRatio`), Node SEA with `--experimental-sea-config` + `postject` 1.0.0-alpha.6 on Node 24 (`--build-sea` exists only from Node 25.5; CJS entry is the safe choice on 24), esbuild via Vite's toolchain for the CJS bundle.
- Complexity: about 28 planned files [estimated], 2 new services (CLI server, `build:bin`). Gate tripped; no feature cuts proposed (scope just settled by CEO C1-C9).
- TODOS.md: only X3 doctor (deferred); nothing blocks Phase 0.
- Distribution: covered (02b releases, 14b binaries for 4 OS, attestations).

Scope record: feature answers: none proposed (scope settled by CEO Q1-Q14); structure: B, Smaller arrangement (D1, answered 2026-10-12); accepted scope: Phase 0 + 14b as amended by CEO C1-C9, with `sidecar/server.ts` (Host gate, manifest, handler; imported by chunk 14 plugin) split from `sidecar/cli.ts` (flags, listen, open, signals); pending remedies: E2, E3, E4.

Scope Challenge result: scope accepted as-is (smaller arrangement preserves the feature list).

Scope Challenge findings:
- E2 [P2] (confidence: 6/10) docs/PLAN.md:128 "1280x720 PNG, compressed under 200 KB." No compression tool is named. Medium confidence, verify this is actually an issue: a lossless 1280x720 PNG of a lit 3D scene with bloom is usually several hundred KB [estimated, not measured]; the Phase 0 blank page will pass, later chunks may not. Pending: E2.
- E3 [P2] (confidence: 8/10) docs/PLAN.md:393 "Permissions: `contents: write`." Granted at workflow level, so the check and test jobs also get write access, and the semantic-release job runs third-party npm plugins with it. Pending: E3.
- E4 [P3] (confidence: 8/10) docs/PLAN.md:371 "Create the Vite+ React-TS project with pnpm." `vp create --help` shows `--agent <NAME>` (writes AGENTS.md, CLAUDE.md), `--hooks` ("default in non-interactive mode") and `--git`; the plan does not say which, so a non-interactive run can add hooks and agent files nobody chose. Pending: E4.

## Decision ledger (eng review, Phase 0)

### E2: Screenshot size cap and compression
Finding: E2, P2, confidence 6/10, docs/PLAN.md:128, Claude (in-host)
Plan baseline: section 4 protocol (original proposal, carried by eng review 1 and design review): 1280x720 PNG under 200 KB; ShotFailed on > 200 KB approved in CEO C5 (Q10).
Runtime evidence: unknown; no shots exist. Size of 3D-scene PNGs is an estimate.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| E2 compression | none named | `sharp` palette PNG (quantized, dev dependency) | WebP lossy via `sharp`, files `.webp` | none; lossless PNG |
| 200 KB cap | approved (section 4, C5) | kept | kept | kept; ShotFailed fires loudly if exceeded, revisit then |
| C5 ShotFailed row | approved | unchanged | unchanged | unchanged |
| E3, E4 | pending | pending | pending | pending |
Question D2:
D2 — E2: How should README screenshots stay under 200 KB?
Project/branch/task: Synapse Horizon, phase-0-tooling, chunk 02 screenshot pipeline (`scripts/shots.ts`).
ELI10: Every chunk adds a 1280x720 screenshot to the README, capped at 200 KB. The plan never says how images get that small. The blank Phase 0 page will be tiny, but a glowing 3D campus saved as plain PNG is likely several hundred KB, so from about chunk 04 the shots script would start failing. Medium confidence: this is an estimate, not a measurement.
Stakes if we pick wrong: Shots start failing mid-project and someone raises the cap or hand-compresses images under time pressure.
Recommendation: A because it keeps PNG and the 200 KB rule as approved, and quantized PNG keeps flat UI and glow readable at that size.
Note: options differ in kind, not coverage — no completeness score.
Net: one dev dependency now versus a predictable failure later or a format change.
Header: E2 shots
Options:
A) Quantized PNG via sharp (recommended)
`scripts/shots.ts` passes each capture through `sharp(...).png({ palette: true, quality: 80, effort: 10 })`; the cap and ShotFailed stay as approved. `sharp` is a dev dependency only (prebuilt binaries; never in the SEA bundle). Effort S (human ~30 min / CC ~5 min), risk low. ✅ Keeps `.png` and the 200 KB cap exactly as the protocol says ✅ Quantization handles dark backgrounds and glow well at this size ❌ Adds a native dev dependency that must install on the Mac and CI
B) WebP via sharp
Shots saved as `.webp` (lossy, quality 80) under 200 KB; section 4 and every README image path change from `.png` to `.webp`. Effort S (human ~1h / CC ~10 min), risk low. ✅ Smallest files, lots of room under the cap ✅ GitHub renders WebP in README files ❌ Changes the approved PNG protocol and every image name in the plan
C) Lossless PNG, revisit on failure
No compressor; Playwright PNGs as captured. When a shot exceeds 200 KB, ShotFailed stops the run and the cap or format is decided then. Effort S (zero implementation work now), risk medium. ✅ No new dependency in Phase 0 ✅ Failure is loud and names the view and size ❌ Likely forces this same decision mid-project, around chunk 04

State: approved
Actual answer: A) Quantized PNG via sharp (recommended), answered D2 2026-10-12
Accepted scope: `scripts/shots.ts` quantizes captures with `sharp` palette PNG (quality 80, effort 10); `sharp` dev dependency only; 200 KB cap and C5 ShotFailed unchanged. Applied to section 4.
History: none

### E3: Workflow token permissions
Finding: E3, P2, confidence 8/10, docs/PLAN.md:393, Claude (in-host)
Plan baseline: chunk 02b "Permissions: `contents: write`." (D19 contract); 14b job-level permissions for the matrix (CEO spec fix); C7 SHA pins (Q12).
Runtime evidence: no workflows exist yet; repo default token permission not probed.
Comparison grid:
| Choice | Current | A | B |
|---|---|---|---|
| E3 token scope | `contents: write` at workflow level in release.yml; ci.yml and pr-title.yml unspecified | every workflow starts with `permissions: {}`; jobs grant only what they use (check/test/build/smoke: `contents: read`; semantic-release job: `contents: write`, `issues: write`, `pull-requests: write`; pr-title: `pull-requests: read`; 14b matrix as already approved) | keep as planned |
| C7 SHA pins | approved (Q12) | unchanged | unchanged |
| 14b job-level permissions | approved (CEO spec fix) | unchanged | unchanged |
| E4 | pending | pending | pending |
Question D3:
D3 — E3: Give each CI job only the token rights it needs?
Project/branch/task: Synapse Horizon, phase-0-tooling, chunks 01 and 02b workflows.
ELI10: GitHub hands every workflow job a token. The plan gives the release workflow write access to the repo at the top level, so every job in it gets write access, including the test job that runs whatever is in the code. Starting each workflow with no rights and granting per job means only the one job that tags and pushes can write. It is a few lines of YAML per workflow.
Stakes if we pick wrong: A compromised test dependency running in the release workflow could push to `main` or move tags.
Recommendation: A because least privilege per job is a few lines and makes C7's pinning count for every job, not just some.
Completeness: A=10/10, B=6/10
Net: a few YAML lines versus write access for jobs that only read.
Header: E3 perms
Options:
A) Per-job least privilege (recommended)
Every workflow file opens with `permissions: {}`. Jobs grant only what they use: check, test, build and smoke get `contents: read`; the semantic-release job gets `contents: write`, `issues: write`, `pull-requests: write` (for release comments); pr-title gets `pull-requests: read`; the 14b matrix keeps its approved grants. The C7 guard step also fails if a workflow lacks a top-level `permissions:` key. Effort S (human ~30 min / CC ~5 min), risk low. ✅ Only the release job can write to the repo or create tags ✅ The guard step stops a new workflow from silently getting default rights ❌ A new job that forgets its grant fails with a 403 until fixed
B) Keep as planned
`contents: write` at the top of release.yml; other workflows use the repo default. Effort S (zero implementation work), risk medium. ✅ Fewer lines in each workflow ✅ No 403 surprises when jobs are added ❌ Test and build jobs in release.yml hold write access they never use

State: approved
Actual answer: A) Per-job least privilege (recommended), answered D3 2026-10-12
Accepted scope: `permissions: {}` at the top of every workflow; per-job grants as listed in option A (release.yml split into `verify` read job and `release` write job); C7 guard also checks for a top-level `permissions:` key. Applied to chunk 02b.
History: none

### E4: `vp create` flags for the scaffold
Finding: E4, P3, confidence 8/10, docs/PLAN.md:371, Claude (in-host)
Plan baseline: chunk 01 "Create the Vite+ React-TS project with pnpm." (original proposal).
Runtime evidence: `vp create --help` (vp v1.0.0, run 2026-10-12): `--agent <NAME>` "Write coding agent instructions to AGENTS.md, CLAUDE.md, etc.", `--no-agent`, `--hooks` "Set up pre-commit hooks (default in non-interactive mode)", `--no-hooks`, `--git`/`--no-git`, `--package-manager`, `--no-interactive`.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| E4 agent files | unspecified | `--no-agent` | `--no-agent` | `--agent claude` (vp writes CLAUDE.md/AGENTS.md) |
| pre-commit hooks | unspecified (default on when non-interactive) | `--hooks` (vp's pre-commit check) | `--no-hooks` (CI only) | `--hooks` |
| git init | repo exists | `--no-git` | `--no-git` | `--no-git` |
| command | unspecified | `vp create vite --no-interactive --package-manager pnpm --no-agent --hooks --no-git --directory . -- --template react-ts` (run in a temp dir and copy if `.` is refused) | same with `--no-hooks` | same with `--agent claude` |
Question D4:
D4 — E4: Which `vp create` options should the scaffold use?
Project/branch/task: Synapse Horizon, phase-0-tooling, chunk 01 scaffold.
ELI10: The scaffold command can quietly add two things nobody chose. Run non-interactively, `vp create` installs pre-commit hooks by default. It can also write generic AI-agent instruction files (CLAUDE.md, AGENTS.md) into the repo. The plan doesn't say, so the result depends on whoever runs it. Picking now makes chunk 01 repeatable.
Stakes if we pick wrong: Surprise hooks block commits, or a generic CLAUDE.md starts steering every agent session in this repo.
Recommendation: A because a pre-commit `vp check` catches lint and type errors before CI, and agent instructions should be written on purpose, not generated.
Note: options differ in kind, not coverage — no completeness score.
Net: local commit checks plus no generated agent files, versus CI-only checks or vp's generic agent files.
Header: E4 scaffold
Options:
A) No agent files, keep hooks (recommended)
Chunk 01 runs `vp create vite --no-interactive --package-manager pnpm --no-agent --hooks --no-git --directory . -- --template react-ts` (temp dir and copy if `.` is refused); CONTRIBUTING notes the pre-commit check. Effort S (human ~5 min / CC ~1 min), risk low. ✅ Lint and type errors stop at commit time, before a CI round trip ✅ No generated CLAUDE.md or AGENTS.md overriding how you set up agents ❌ Commits take a few seconds longer while `vp check` runs
B) No agent files, no hooks
Same command with `--no-hooks`; CI is the only gate. Effort S (human ~5 min / CC ~1 min), risk low. ✅ Fastest commits, nothing runs locally ✅ No generated agent files ❌ Lint and type errors are found only after pushing
C) Let vp write agent files
Same as A plus `--agent claude`, keeping vp's generated CLAUDE.md/AGENTS.md. Effort S (human ~5 min / CC ~1 min), risk medium. ✅ Agents get vp-specific command hints from day one ✅ Hooks as in A ❌ Generic instructions you did not write start steering agent sessions in this repo

State: approved
Actual answer: A) No agent files, keep hooks (recommended), answered D4 2026-10-12
Accepted scope: chunk 01 scaffold command with `--no-interactive --package-manager pnpm --no-agent --hooks --no-git`; CONTRIBUTING notes the pre-commit check. Applied to chunk 01.
History: none

### Section 1: Architecture (eng)

- [P2] (confidence: 8/10) docs/PLAN.md chunk 02b "Chunk 14's WebSocket and import endpoints sit behind the same Host gate": Vite's `allowedHosts` covers only HTTP routes Vite serves; a plugin `upgrade` listener bypasses it. Required proof of C6 (Q11), applied: chunk 14 acceptance tests a foreign-Host WebSocket upgrade under `vp dev` and the binary.
- [P3] (confidence: 7/10) Asset loading: one `Map<path, bytes>` built at startup in SEA and `dist/` modes. Guidance within C6; no behaviour change.
Dispositions: first applied (C6 proof); second recorded as guidance.

### Section 2: Code quality (eng)

- [P3] (confidence: 8/10) `sidecar/server.ts` dual ESM/CJS loading: lint rule in `sidecar/` against `import.meta` and top-level await. Required proof of the approved CJS SEA approach, applied to 02b.
- [P3] (confidence: 8/10) CLI `--version` via esbuild `define` of the `package.json` version. Factual correction, applied to 02b.
Dispositions: both applied; no new choices.

### E5: Release config check before merge
Finding: E5, P2, confidence 7/10, docs/PLAN.md chunk 02b "Local release script `vp run release:dry`", Claude (in-host)
Plan baseline: `vp run release:dry` run by hand (D19, chunk 02b); no automated check of `.releaserc.json` on PRs.
Runtime evidence: none (no config exists). A broken config is first seen on `main` after merge, when `release.yml` fails and the merged change ships no release.
Comparison grid:
| Choice | Current | A | B | C |
|---|---|---|---|---|
| E5 release config check | manual `release:dry` | Vitest `scripts/releaserc.test.ts`: loads `.releaserc.json`, asserts `branches: ["main"]`, plugin order (commit-analyzer, release-notes, changelog, npm with `npmPublish: false`, git, github, exec), each plugin `require.resolve`s, exec `successCmd` writes `published` and `version` | PR job running `semantic-release --dry-run --no-ci --branches $GITHUB_HEAD_REF` when release files change | keep manual `release:dry` |
| E3 permissions | approved (D3) | unchanged | job needs `contents: read`; github plugin's push-permission check may fail with a read token (unverified) | unchanged |
Question D5:
D5 — E5: Check the release config automatically before merge?
Project/branch/task: Synapse Horizon, phase-0-tooling, chunk 02b semantic-release config.
ELI10: The release setup lives in one config file. If someone breaks it (a typo, a missing plugin, wrong order), nothing notices until after the merge. Then the release job on `main` goes red and that merge ships no version. A small unit test can load the config and check the parts we rely on, on every PR, in under a second.
Stakes if we pick wrong: A broken release config is found only after merge, so a feature lands with no release and needs a follow-up fix.
Recommendation: A because it catches the realistic breakages in milliseconds on every PR, with no tokens and no GitHub calls.
Completeness: A=9/10, B=8/10, C=4/10
Net: a 30-line unit test versus finding release breakage after merge.
Header: E5 release
Options:
A) Config unit test (recommended)
`scripts/releaserc.test.ts` in `vp test`: asserts branches, plugin list and order, `npmPublish: false`, each plugin resolves, and the exec `successCmd` writes `published` and `version`. Effort S (human ~30 min / CC ~5 min), risk low. ✅ Runs on every PR inside the normal test job, no token needed ✅ Pins exactly the settings 14b and the C3 seed version depend on ❌ Does not run semantic-release itself, so a plugin runtime bug still shows only on `main`
B) PR dry-run job
A PR job runs `semantic-release --dry-run --no-ci --branches $GITHUB_HEAD_REF` when `.releaserc.json`, `release.yml` or `package.json` change. Effort M (human ~1h / CC ~10 min), risk medium. ✅ Exercises the real tool, catching runtime errors too ✅ Shows the would-be version in the PR log ❌ The github plugin checks push rights and may fail with the read-only PR token (unverified)
C) Keep manual release:dry
Run `vp run release:dry` by hand before merging release changes. Effort S (zero implementation work), risk medium. ✅ Nothing new to maintain ✅ Full real run when you remember it ❌ Relies on memory; a forgotten run means breakage shows on `main`

State: approved
Actual answer: A) Config unit test (recommended), answered D5 2026-10-12
Accepted scope: `scripts/releaserc.test.ts` with the assertions in option A, run by `vp test`. Applied to chunk 02b.
History: none

### Section 3: Test review (eng)

```text
CODE PATHS                                              USER FLOWS
[+] sidecar/server.ts                                   [+] Download and run binary
  ├── checkHost()  [★★★ PLANNED] 421/308/ok (C6)          ├── [★★★ PLANNED] start, curl 200, --version [→E2E]
  ├── asset map    [★★★ PLANNED] traversal, %2e%2e (C6)   ├── [★★ PLANNED] localhost redirect
  └── handler      [★★★ PLANNED] 404/SPA/500 (C5)         └── [★★ PLANNED] port busy fallback message
[+] sidecar/cli.ts                                      [+] Contributor flow
  ├── flags        [★★★ PLANNED] bad flag, port range     ├── [★★ PLANNED] PR title rejected (live)
  ├── listen+retry [★★★ PLANNED] race, exhausted, EACCES  ├── [★★ PLANNED] feat merge → v0.2.0 (live)
  └── open/signals [★★ PLANNED] OpenFailed, SIGINT        └── [★★ PLANNED] fix after ruleset → bypass (live)
[+] scripts/build-bin.ts                                [+] Screenshots
  ├── fetch node   [★★★ PLANNED] 5xx retry, checksum      ├── [★★ PLANNED] < 200 KB via sharp (E2)
  └── postject/sign[★★ PLANNED] tool failure              └── [★★ PLANNED] repeat within 0.5% (toHaveScreenshot)
[+] scripts/check-workflows.ts [★★★ PLANNED] tag ref, no permissions key (C7, E3)
[+] .releaserc.json            [★★★ PLANNED] scripts/releaserc.test.ts (E5)
[+] chunk 01 page              [★★ PLANNED] smoke + app-version meta (CEO A-2)

COVERAGE (planned): 21/21 paths | GAPS: 0 after E5 and required proofs
```
- Required proof carried forward (no question): workflow guard script with fixture tests (C7 Q12, E3 D3); `toHaveScreenshot({ maxDiffPixelRatio: 0.005 })` for the repeat-run check (eng review 1, T2).
- E5 (D5): release config unit test, approved and applied.
- Dropped (fails value bar): automated Dependabot config schema check; the chunk 01 manual Insights check covers the only realistic regression.
- Test Plan artifact: `~/.gstack/projects/bjorkgard-ai-center/nathanael-phase-0-tooling-eng-review-test-plan-20261012-212606.md`.
Dispositions: E5 approved; two required proofs applied; one proposal dropped.

### Section 4: Performance (eng)

No issues found. Requests are map lookups on assets loaded once at startup (tens of files, a few MB [estimated]); no per-request disk access. Playwright browsers are not cached in CI, following Playwright's CI guidance (restore time comparable to download). Binary size about 100-120 MB per OS [estimated].

### Outside voice (eng)

Disabled (`codex_reviews` = disabled); logged as skipped. No outside or native second reviewer ran in this eng review.

### TODOS.md (eng)

No new TODO proposals. Existing X3 (doctor) unchanged.

### Approval readiness (eng)

Checked: D1 structure (Smaller arrangement), E2 (D2 A), E3 (D3 A), E4 (D4 A), E5 (D5 A). Required proof or factual corrections without new choices: chunk 14 foreign-Host WebSocket test (C6, Q11), `sidecar/` ESM/CJS lint rule (approved CJS SEA approach), `--version` via esbuild define (factual), workflow guard tests (C7, E3), `toHaveScreenshot` repeat check (eng T2). CEO C1-C9 carried unchanged.

Approval readiness: PASS

### NOT in scope (eng)

- PR dry-run of semantic-release (E5 option B): not chosen; config unit test instead.
- Dependabot config schema check: dropped, low value.
- `vp run doctor`: deferred earlier (CEO X3, TODOS.md).

### What already exists (eng)

No code in the repo. Reused: `vp create`, `vp env pin`, `setup-vp`, semantic-release plugins incl. `@semantic-release/exec` 7.1.0, Playwright `toHaveScreenshot`, `sharp` 0.35.5 (dev), Node 24 SEA + `postject` 1.0.0-alpha.6, `actions/attest-build-provenance`. Nothing rebuilt; the Host gate is written once in `sidecar/server.ts` and imported by chunk 14 (D1).

### Diagrams (eng)

Architecture (Section 1 above), test coverage map (Section 3). Inline ASCII diagram required at the top of `sidecar/server.ts`: request flow `Host gate → decode → asset map → 200 | SPA | 404 | 500`.

### Failure modes (eng)

| Path | Realistic failure | Test / handling | User sees |
|---|---|---|---|
| server.ts Host gate | rebinding Host | unit (C6) | 421 |
| plugin WS upgrade (chunk 14) | bypasses Vite host check | chunk 14 acceptance test | refused upgrade |
| cli listen | two copies start together | unit (C5) | fallback port line |
| build:bin | corrupted Node download | unit (C5) | hash mismatch message |
| release.yml | broken `.releaserc.json` | unit (E5) | red PR, not red `main` |
| workflows | new job with tag ref or no permissions | guard + unit | red PR |
| shots | 3D frame > 200 KB | sharp quantize (E2) + ShotFailed | view and size |

Critical gaps: 0.

### Worktree parallelization strategy

| Step | Modules touched | Depends on |
|------|----------------|------------|
| 01 scaffold, CI, Dependabot | root config, `src/`, `.github/` | — |
| 02 Playwright, smoke, shots | `e2e/`, `scripts/` | 01 |
| 02b-a release pipeline | `.github/workflows/`, `.releaserc.json`, `scripts/` (releaserc, check-workflows) | 02 |
| 02b-b server + CLI | `sidecar/` | 01 |
| 02b-c build:bin | `scripts/` (build-bin), `package.json` | 02b-b |

Parallel lanes: Lane A: 01 → 02 → 02b-a. Lane B: 02b-b → 02b-c (after 01).
Execution order: build 01; then launch A (02, then 02b-a) and B (02b-b, 02b-c) in parallel worktrees; merge as one 02b PR (one PR per chunk).
Conflict flags: both lanes touch `scripts/` and `package.json` scripts; keep script files separate and merge `package.json` by hand.

## Implementation Tasks (eng review, Phase 0)

Synthesized from this review's findings. Effort ratios: scaffolding ~100x, tests ~50x, features ~30x.

- [x] **T1 (P2, human: ~1h / CC: ~10min)** — sidecar — Split `server.ts` (createServer, checkHost, asset map, handler) from `cli.ts`; ESM/CJS lint rule; `--version` define
  - Surfaced by: Scope Challenge D1; Section 2
  - Files: sidecar/server.ts, sidecar/cli.ts, sidecar/server.test.ts, sidecar/cli.test.ts, lint config
  - Verify: `vp check` fails on `import.meta` in sidecar/; `vp test`
- [x] **T2 (P2, human: ~30min / CC: ~5min)** — shots — sharp palette PNG and `toHaveScreenshot` repeat check
  - Surfaced by: Scope Challenge E2 (D2); Section 3
  - Files: scripts/shots.ts, package.json
  - Verify: `vp run shots` twice; image < 200 KB
- [x] **T3 (P2, human: ~1h / CC: ~10min)** — CI — `permissions: {}` per workflow, split release.yml into verify/release jobs, guard script with fixtures
  - Surfaced by: Scope Challenge E3 (D3); Section 3 (C7 proof)
  - Files: .github/workflows/*.yml, scripts/check-workflows.ts, scripts/check-workflows.test.ts
  - Verify: `vp test`; guard fails on a tag ref fixture
- [x] **T4 (P3, human: ~5min / CC: ~1min)** — scaffold — `vp create` with `--no-agent --hooks --no-git`
  - Surfaced by: Scope Challenge E4 (D4)
  - Files: repo root
  - Verify: no AGENTS.md/CLAUDE.md generated; pre-commit runs `vp check`
- [x] **T5 (P2, human: ~30min / CC: ~5min)** — release — `.releaserc.json` unit test
  - Surfaced by: Section 3 E5 (D5)
  - Files: scripts/releaserc.test.ts
  - Verify: `vp test` fails when a plugin is removed
- [ ] **T6 (P2, human: ~30min / CC: ~5min)** — chunk 14 — Foreign-Host WebSocket upgrade test under `vp dev` and binary
  - Surfaced by: Section 1 (C6 proof)
  - Files: sidecar/plugin.ts tests (chunk 14)
  - Verify: chunk 14 acceptance

### Unresolved decisions (eng)

None.

### Completion summary (eng)

- Step 0: Scope Challenge — scope accepted as-is (smaller arrangement, D1)
- Reality rows: 7/7 applicable rows emitted, 2 unverified premises
- Architecture Review: 2 issues found
- Code Quality Review: 2 issues found
- Test Review: diagram produced, 3 gaps identified (all closed: E5 + 2 required proofs)
- Performance Review: 0 issues found
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed to user
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, disabled (config)
- Parallelization: 2 lanes, 2 parallel / 3 sequential steps
- Lake Score: 1/2 (D3 picked its 10/10 option; D5's best option scored 9/10)

Reality rows (eng):
- REALITY: premise-table finding unverified=2 (3D PNG size estimate; github plugin token behaviour in PR dry-run) docs/PLAN.md:128
- REALITY: already-done pass `git log origin/main` shows docs only docs/PLAN.md:371
- REALITY: surface-check finding `vp create` flags verified via `--help` (E4); `--build-sea` is Node 25.5+, so Node 24 keeps `--experimental-sea-config` + postject docs/PLAN.md:371
- REALITY: binding-decisions pass CEO C1-C9 honoured; none reopened docs/PLAN.md:15
- REALITY: numbers finding binary size, asset size and effort are [estimated] docs/PLAN.md:128
- REALITY: deferred-asks pass X3 stays in TODOS.md; nothing else deferred docs/PLAN.md:396
- REALITY: pr-count pass one PR per chunk (01, 02, 02b); lanes merge into the 02b PR docs/PLAN.md:399

## CEO review record: Phase 1 (/plan-ceo-review, 2026-10-13)

Target: Phase 1 (chunk 03) of `docs/PLAN.md` and the section 1 open decision it settles, branch `phase-1-rendering-spike`, base `main` at `dc8612a`. Reviewer: Claude (in-host). Review depth: implementation-ready, chunk 03 only. No Phase 1 design doc exists; `docs/designs/phase-0-tooling.md` is the Phase 0 CEO summary. Questions in this record are numbered PQ1, PQ2... (shown in chat as D1, D2...); ledger rows continue the CEO series at C10.

### 0A. Premise

- Real problem: about 30 scene chunks (04a-37) will be built on one integration. A wrong pick shows up late, at chunk 20 (hall churn) or 36 (perf), when switching means rewriting every scene file.
- Target outcome: an ADR whose decision follows from measured numbers and a rule written before measuring.
- Do-nothing cost (adopt R3F on the section 1 reasoning, no spike): about 1 CC-hour saved; any leak or overhead surfaces at chunk 20 instead of now.
- Chunk 03 as written solves this only partly:
  - F1 [P1] The load probably cannot separate the two [inference, not measured]: 12 boxes plus 2 InstancedMeshes is about 20 draw calls, so on this Mac both routes will likely sit at the refresh cap. "Both hit 60" then decides nothing and the ADR falls back to opinion. Pending: C10.
  - F2 [P1] fps is not comparable across browsers on this Mac [measured: `system_profiler` shows a built-in Liquid Retina XDR (ProMotion) display]: Chrome and Firefox run `requestAnimationFrame` at up to 120 Hz; Safari keeps page rendering near 60 fps by default ("Prefer Page Rendering Updates near 60fps" flag, WebKit bug 294338) [web source, not checked in Safari here]. Applied as RW2.
  - F3 [P1] Target machine mismatch [measured: `sysctl hw.model` = MacBookPro18,4, Apple M1 Max]: chunk 03 says measure on "M1 Air class"; this Mac's GPU is several times faster than an M1 Air's [estimated]. Pending: C11.
  - F4 [P2] Unequal defaults would bias the race [verified: R3F `configuration.ts` and `reconciler.tsx` via Context7, master branch]: R3F's Canvas creates its renderer with antialias and alpha on and sets ACES Filmic tone mapping, and its `dpr` defaults to `[1, 2]` (R3F docs); a plain `WebGLRenderer` has no antialias, no tone mapping and pixel ratio 1. R3F disposes unmounted objects on idle (`disposeOnIdle`), so `renderer.info` read right after churn shows a false leak. Applied as RW1, RW3.

### 0B. Existing code leverage

The repo has Playwright with chromium, firefox and webkit projects and a build-and-preview web server (`playwright.config.ts:24-48`), the shots pipeline with the `view=<name>` URL contract (`scripts/shots.config.ts:13`), and the design tokens (`src/styles/tokens.css`). No three, R3F or postprocessing package is installed (`package.json:20-24`). There is no router (`src/app/App.tsx`). Reuse: the shots `view=` parameter for the spike views and `03-spike.png`; the Playwright projects for any automated run. Nothing is rebuilt.

Current versions [measured: `npm view`, 2026-10-13]: three 0.186.1; `@react-three/fiber` 9.8.1 (peer `react >=19 <19.4`; React is pinned `~19.3.0`, `package.json:21`); drei 10.7.9; `@react-three/postprocessing` 3.2.0; `postprocessing` 6.39.5. R3F 10 is in alpha and canary (a canary was published 2026-10-13).

Reality rows:
- REALITY: premise-table finding unverified=3 (Safari 60 fps default on macOS not checked locally; M1 Max vs M1 Air GPU ratio; WebGPU on by default in Safari 26 and Firefox 147 from secondary web sources) docs/PLAN.md:433
- REALITY: already-done pass `git log origin/main -- src/spike docs/adr src/scene` shows only `f72dee8` (scaffold `.gitkeep`); no spike code exists docs/PLAN.md:430
- REALITY: surface-check finding `/spike/r3f` and `/spike/vanilla` have no router (`src/app/App.tsx`) and the shots contract addresses views by `view=<name>` (`scripts/shots.config.ts:13`); `renderer.info.memory` and `renderer.info.programs` exist in three; `performance.memory` is Chromium-only; applied as RW4 docs/PLAN.md:433
- REALITY: binding-decisions pass section 1 open decision and provisional R3F pick, D1 (3 browsers), D10 (bloom off below 45 fps), D18 (`e2e:local` on the Mac) and eng S3 (React `~19.3` for the R3F peer) honoured; `gstack-decision-search --scope branch` returned none docs/PLAN.md:34
- REALITY: numbers finding 200 racks exceeds the campus cap of 12 halls x 16 = 192 (D8, chunk 08); 3,200 LEDs is 16 per rack against chunk 07's "e.g. 8"; the 60 fps target and 45 fps bloom floor are [estimated] budgets; applied as RW5 docs/PLAN.md:433
- REALITY: deferred-asks pass no brief item is scheduled into Phase 1 beyond the integration decision docs/PLAN.md:34
- REALITY: pr-count pass no `.gstack/ship-policy.json`; Phase 1 is one PR for chunk 03 plus this review's docs PR docs/PLAN.md:31

### 0C. Dream state

```text
  CURRENT STATE               THIS PLAN (chunk 03)              12-MONTH IDEAL
  scaffold, CI, 3-engine ---> two throwaway scenes and an  ---> live campus holds 60 fps on an M1 Air in
  smoke, blank page;          ADR that picks R3F or vanilla      Chrome, Safari and Firefox for hours with
  no 3D, no perf numbers      from measured numbers              flat GPU memory; perf and leak regressions
                                                                 are caught per chunk, not at chunk 36
```

Chunk 03 moves toward the ideal. Gap: as written, its measurement code is deleted in chunk 04, so chunks 07, 10, 20 and 36 each build their own perf or leak check.

### Required work applied without a new choice

Each item cites the approved contract it serves; all are applied to chunk 03 above.
- RW1 (chunk 03 Goal "numbers, not opinion"; F4): both views use identical renderer settings and the same bloom library, listed in the ADR.
- RW2 (same contract; F2): the deciding numbers are frame times in ms (CPU median, p95, p99, longest churn frame, GPU where exposed); fps is reported but decides nothing. Acceptance restated as median frame interval at most 16.7 ms plus p95 CPU frame time under 16.7 ms.
- RW3 (chunk 03 Acceptance "counts return to baseline"; F4): churn counts are read after disposal settles and include `renderer.info.programs.length`.
- RW4 (surface-check): views are `?view=spike-r3f` and `?view=spike-vanilla`, so `vp run shots` can capture `03-spike.png` without a router.
- RW5 (numbers): 192 racks and 3,072 LEDs. Chunk 36's "200 racks" has the same overrun; left for its own review.
- RW6 (Section 1; chunk 04a "shared instances only", chunk 03 churn baseline): churn exercises the product's resource pattern, per-hall geometry plus shared materials that must survive.
- RW7 (Section 1; section 4 protocol): chunk 04a removes the `spike-*` shots entry and the rejected dependency along with the views; `03-spike.png` becomes a static image.
- RW8 (Section 4; chunk 03 Goal and chunk 07 pattern): identical per-frame work in both views, per-hall instanced meshes, no per-frame allocation in spike code, one rendered frame per churn cycle before removal.
- RW9 (Section 4; section 1 criterion "leaks we cannot control"): churn snapshots include the fake store's listener count.
- RW10 (Section 8; C10 "results table built from those JSON files"): each JSON result carries the run metadata the table and an auditor need; raw files are committed; the view shows the pass status.
- RW11 (Section 9; C10 "rule committed before the first measured run", D18 squash-merge): the ADR names the rule commit and every result starts after it, which stays checkable after squash-merge.
- RW12 (Section 10; chunk 03 Acceptance "a decision and reasoning"): the ADR lists known consequences of the pick.

### Decision ledger (CEO, Phase 1)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| C10 spike method (Claude) | chunk 03 Goal "Pick the integration with numbers, not opinion"; F1 (light load likely vsync-bound, inference); section 1 provisional R3F pick, docs/PLAN.md:36 | C: both views at 1x and 4x load, scripted bench with JSON per browser, decision rule committed in the ADR before the first run | none | approved | PQ1 answer "Decision-grade race (recommended)", 2026-10-13; scope: chunk 03 load levels, run method and decision rule; RW1-RW5 unchanged; applied to chunk 03 Tasks and Acceptance |
| C11 measurement machine (user) | chunk 03 "M1 Air class"; F3 dev Mac is M1 Max (`sysctl`) | B: ADR runs on the dev Mac (M1 Max); CPU-time pick valid; 1x 60 fps check labelled "M1 Max, overstates M1 Air GPU"; chunk 36 keeps the M1 Air-class target and must measure on it | none | approved | PQ3 answer "Decide here, label GPU numbers (recommended)", 2026-10-13; scope: measurement machine for chunk 03 and the target-hardware duty of chunk 36; applied to chunks 03 and 36 |

### Mode

HOLD SCOPE, the recommended mode, chosen by the user (PQ2, 2026-10-13; question answer, not auto-decided). Applies to all later sections. Chunk 03 counts about 14 changed files [estimated]: `package.json`, `pnpm-lock.yaml`, `src/spike/` (shared scene parameters, fake store, bench harness, R3F view, vanilla view, one unit test), `src/app/App.tsx`, `scripts/shots.config.ts`, `docs/img/03-spike.png`, `docs/adr/0001-render-integration.md`, `README.md`. A spike is neither greenfield, a feature nor a fix, so the category was unclear; HOLD keeps the gate short because its code is deleted in chunk 04. Not offered under HOLD: keeping the bench for chunks 20 and 36, a WebGPU data point, a glass-overlay cost check.

### 0G. Hold-scope checks

- Complexity: about 14 files [estimated] is over the 8-file mark, with one new module (`src/spike/`). Challenge result: 4 of the 14 are required by the section 4 README and screenshot protocol (`README.md`, `scripts/shots.config.ts`, `docs/img/03-spike.png`) or by the chunk's output (`docs/adr/0001-render-integration.md`); 2 are dependency files. The two views share one scene definition, one fake store and one bench, so no smaller set gives a fair race.
- Minimum change: everything left is needed for C10's goal. No deferral proposed.
- Invariants kept: D1 (Chrome, Safari, Firefox), D10 (bloom on, off below 45 fps), D18 (one PR per chunk, Conventional Commit title), section 4 protocol, eng S3 (React `~19.3`), C10 and RW1-RW5.

### 0I. Temporal interrogation (Phase 1)

```text
  HOUR 1 (foundations):   exact deps (three 0.186.1, @types/three, @react-three/fiber 9.8.1,
                          @react-three/postprocessing 3.2.0, postprocessing 6.39.5); shared
                          scene definition at load 1 and 4; seeded fake store at 10 Hz;
                          one renderer-settings constant (RW1); `view=` switch in App.tsx
  HOUR 2-3 (core logic):  vanilla view (WebGLRenderer, postprocessing BloomEffect, two
                          InstancedMeshes, explicit dispose on churn); R3F view (Canvas with the
                          same settings, refs written in useFrame from a transient store
                          subscription, halls mount and unmount as components)
  HOUR 4-5 (integration): bench: one shared timing driver, frame sampler, GPU timer where
                          present, churn driver, settle wait, renderer.info snapshots, JSON out
  HOUR 6+ (polish/tests): unit tests for the stats code; shots view; ADR rule committed first,
                          then runs in Chrome, Safari, Firefox; results table; README stub
```

What will surprise the implementer:
- Timing must wrap the same work in both views. R3F owns its render loop; drive both views from one external `requestAnimationFrame` driver (R3F with `frameloop="never"` and `advance()`), or the R3F number includes or skips work the vanilla number does not.
- Measure the production build (`vp build`, then `vp preview` or `vp run serve`), never `vp dev`: React's development build and StrictMode double-mounting would count against R3F only.
- `EXT_disjoint_timer_query_webgl2` is expected in Chromium only [unverified for Safari and Firefox]; the GPU column may read "n/a" there.
- Run order alternates R3F and vanilla with a cool-down between passes, so heat build-up does not favour whichever runs first.
- Default bench pass: 5 s warm-up, 20 s steady, churn (6 halls added and removed 50 times), 1 s settle, then snapshots [estimated durations].

Feasibility blockers: C11 (measurement machine), below. No other blocker found.

Effort: chunk 03 human ~2 days / CC ~1.5h [estimated, from C10].

### Answered decision C10 (PQ1)

Answer: C, "Decision-grade race (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Fair-test fixes RW1-RW5 | required work (chunk 03 Goal, Acceptance) | applied | yes | yes | yes |
| Views built | chunk 03 (approved plan) | R3F and vanilla | R3F and vanilla | R3F; vanilla only if R3F misses a bar | R3F and vanilla |
| Load levels | pending | 1x (12 halls, 192 racks, 3,072 LEDs) | 1x | 1x and 4x instances (768 racks, 12,288 LEDs, same draw calls) | 1x and 4x instances |
| Decision rule | pending; section 1 says vanilla wins only on overhead or leaks | provisional, no thresholds | provisional, no thresholds | absolute bars: p95 CPU frame under 16.7 ms at 4x, counts back to baseline, longest churn frame under 50 ms [thresholds estimated] | written in the ADR before the first run: R3F unless, in any browser at 4x, its p95 CPU frame exceeds vanilla's by more than 1 ms or 15%, any count misses baseline, or its longest churn frame is over 2x vanilla's [thresholds estimated] |
| How runs are made | pending | by hand per browser | by hand per browser | in-page scripted bench, JSON per browser | in-page scripted bench (`&bench=1`: warm-up, steady, churn, settle), JSON per browser |
| Measured R3F overhead in the ADR | chunk 03 Goal | yes, at 1x | yes, at 1x | no | yes, at 1x and 4x |
| Effort | - | - | M | S | M |

Question: D1 — C10: How should the rendering spike decide between R3F and plain Three.js?
Project/branch/task: Synapse Horizon, branch phase-1-rendering-spike, chunk 03 (the gate before every 3D chunk).
ELI10: Chunk 03 builds the same small 3D scene twice, once with React Three Fiber and once with plain Three.js, and picks one. The scene is so light that on your Mac both versions will probably hit the screen's refresh limit, so the numbers would tie and the pick would come down to opinion anyway. We can keep it as written, test only R3F against fixed pass/fail bars, or race both under a heavier load with the winning rule written down before measuring.
Stakes if we pick wrong: every scene chunk from 04a to 37 sits on this choice; a leak or overhead found at chunk 20 or 36 means rewriting the scene layer.
Recommendation: C because it costs about 30 CC-minutes more than A and is the only option whose numbers can separate the two, with the rule fixed before anyone sees results.
Completeness: A=6/10, B=7/10, C=9/10
Net: a cheap race that likely ties (A), a pass/fail check of the favourite (B), or a race built to produce a winner (C).
Header: Spike method
A) Keep chunk 03 as written
Two views of one light scene (12 halls, 192 racks, 3,072 LEDs) with the fair-test fixes RW1-RW5, measured by hand per browser. Effort M (human ~1.5 days / CC ~1h), risk medium. ✅ Smallest change to an already reviewed plan; both integrations are built and compared side by side ✅ The churn check still catches R3F disposal problems before chunk 04 starts ❌ Both views likely sit at the refresh cap on your Mac, so the pick probably falls back to the provisional choice
B) Bars-first: R3F only, vanilla on failure
Build only the R3F view and test it at 1x and 4x load against fixed bars for frame time, churn counts and churn hitches; build vanilla only if R3F misses one. Effort S (human ~1 day / CC ~40 min), risk medium. ✅ Tests what the product needs (does it fit the budget) instead of which one is faster ✅ Half the build work when R3F passes, which section 1 already expects ❌ No measured R3F overhead, so the ADR cannot say how much headroom vanilla would have bought
C) Decision-grade race (recommended)
Both views at 1x and a 4x stress level, an in-page scripted bench (warm-up, steady, churn, settle) that prints JSON per browser, and the decision rule written into the ADR before the first run. Effort M (human ~2 days / CC ~1.5h), risk low. ✅ The 4x level gives frame-time headroom, so the two views can actually differ in the numbers ✅ A rule fixed up front keeps the ADR honest, and the JSON runs can be repeated later ❌ About 30 CC-minutes more than A, and the 4x scene is bigger than anything the product draws today

### Answered decision C11 (PQ3)

Answer: B, "Decide here, label GPU numbers (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Machine for the ADR runs | chunk 03 "M1 Air class" (approved plan) | M1 Air class | an M1 Air-class Mac | this Mac (M1 Max) | this Mac (M1 Max) |
| What the integration pick rests on | C10 rule (approved): CPU frame time | - | CPU frame time on target | CPU frame time; M1 Air and M1 Max share the same CPU core design [estimated] | same as B |
| 1x 60 fps check (GPU-bound part) | chunk 03 Acceptance | on M1 Air class | on target | on this Mac, labelled "M1 Max, overstates M1 Air GPU" | on this Mac, as the target |
| Target machine in chunks 03 and 36 | chunks 03, 36 | M1 Air class | M1 Air class | M1 Air class kept; chunk 36 must measure on it | changed to M1 Max |
| Extra effort now | - | - | S (human ~2h of runs / CC 0) plus access to hardware | S (zero extra work) | S (zero extra work) |

Question: D3 — C11: Which Mac should the spike's numbers come from?
Project/branch/task: Synapse Horizon, branch phase-1-rendering-spike, chunk 03 measurements.
ELI10: The plan says to measure on an "M1 Air class" Mac, but your Mac is an M1 Max with a much stronger graphics chip and a 120 Hz screen. The R3F-or-vanilla pick rests mostly on CPU frame time, and the M1 Air and M1 Max use the same CPU core design, so that part should carry over. The "holds 60 fps" check leans on the graphics chip, so on your Mac it will look better than it would on an M1 Air.
Stakes if we pick wrong: a 60 fps pass measured on the M1 Max can hide a graphics-bound miss on the cheaper Macs people download the build to.
Recommendation: B because the integration pick rests on CPU time that carries over and it needs no extra hardware; pick A if an M1 Air-class Mac is at hand.
Completeness: A=10/10, B=8/10, C=5/10
Net: real target hardware now (A), an honest caveat with the target check moved to chunk 36 (B), or a cheaper promise (C).
Header: Bench Mac
A) Use an M1 Air-class Mac
Run the scripted bench in all three browsers on an M1 Air-class Mac for the ADR; this Mac is used only while building. Effort S (human ~2h of runs / CC 0 extra), risk low. ✅ The 60 fps check is measured on the hardware the budget is written for ✅ Heat throttling on a fanless Air shows up now instead of after release ❌ Needs an M1 Air-class Mac you can use; without one, chunk 03 cannot pass as written
B) Decide here, label GPU numbers (recommended)
Run on this M1 Max; the ADR names the machine, treats the CPU-time pick as valid, and labels the 1x 60 fps check "M1 Max, overstates M1 Air GPU". Chunk 36 keeps the M1 Air-class target and must measure on it. Effort S (zero extra work now), risk medium. ✅ No extra hardware, and the integration pick still rests on numbers that carry over ✅ The graphics caveat is written down instead of hidden inside a passing number ❌ Any M1 Air graphics shortfall stays unknown until chunk 36
C) Make this Mac the target
Change "target machine" in chunks 03 and 36 to this M1 Max with its 120 Hz display. Effort S (zero extra work), risk high. ✅ Every number is measured where the budget now lives, with no caveats ✅ Simplest plan text; no other hardware is ever needed ❌ Released builds then promise nothing for the cheaper Macs, Linux and Windows machines people download them to

### Section 1: Architecture (Phase 1)

```text
 /?view=spike-r3f|spike-vanilla&load=1|4&bench=1
        │
 src/main.tsx ─► src/app/App.tsx ── spike view? ──no──► home page (unchanged)
                                        │ yes
                                        ▼
                    src/spike/shared/
                      scene.ts      hall grid, rack and LED layout per load (pure)
                      fakeStore.ts  seeded LED colours at 10 Hz, transient subscribe
                      render.ts     RW1 renderer and bloom settings (one constant)
                      bench.ts      one rAF driver: warm-up > steady > churn > settle > done
                      stats.ts      median, p95, p99 (pure)
                 ┌──────────────┴───────────────┐
   src/spike/vanilla/                    src/spike/r3f/
   WebGLRenderer + postprocessing        Canvas frameloop="never" + @react-three/postprocessing
   2 InstancedMeshes, explicit dispose   <instancedMesh> refs, halls mount/unmount as components
                 └──────────────┬───────────────┘
                   per-pass JSON result ──► ADR 0001 results table
```

Dependencies before: app → react, react-dom, geist, tailwind. After: + three, `@react-three/fiber`, `@react-three/postprocessing`, `postprocessing` (runtime), `@types/three` (dev). Nothing outside `src/spike/` and one branch in `App.tsx` imports the spike, so chunk 04a deletes it in one step. Scaling: at 4x load, per-frame work is one colour upload of 13,056 instances (about 157 KB) plus matrices once; draw calls stay flat; the shadow pass draws both instanced meshes a second time. No endpoints, no single point of failure, no production data. Rollback: revert the PR. Value test: the ADR is consumed by chunk 04a (it gates it); the JSON results are consumed by the ADR table; the views retire in 04a.

- A-1 [P2] (confidence 8/10) Chunk 03 churns halls but does not say which resources a hall owns. If each view creates per-hall materials, the churn test misses the real risk: R3F disposing a shared material when one hall unmounts (R3F `reconciler.tsx` disposes JSX-declared objects on unmount). Required work for chunk 04a's "shared instances only" and chunk 03's baseline check; applied as RW6.
- A-2 [P2] (confidence 9/10) Chunk 04a deletes the views, but `scripts/shots.config.ts` would still list `spike-*`, so `vp run shots` fails from 04a on. Factual correction; applied as RW7 with a section 4 exception.
- A-3 [P3] (confidence 7/10) A static import of the spike in `App.tsx` puts three and R3F into the home page bundle until 04a. Non-blocking implementation choice, owner: chunk 03 implementer; check with `vp build` output. Left pending; not a task.

Section 1 dispositions: A-1 applied (RW6), A-2 applied (RW7), A-3 pending implementation choice.

### Section 2: Error & Rescue Map (Phase 1)

Chunk 03 names the happy path for the bench but no failure behaviour. A pass that runs while the tab is hidden, the window is resized or the WebGL context is lost produces plausible numbers that are wrong, and the ADR decision rests on them. Proposed registry (pending C12):

```text
  CODEPATH              | WHAT CAN GO WRONG                          | ERROR
  ----------------------|--------------------------------------------|---------------------------
  spike params          | unknown view, load not 1 or 4, junk bench  | InvalidParam
  view init (both)      | WebGL2 context not created                 | WebGLUnavailable
                        | bloom composer throws on init              | ComposerInitError
  bench pass            | tab hidden or window blurred mid-pass      | PassInterrupted(visibility)
                        | window resized mid-pass                    | PassInterrupted(resize)
                        | webglcontextlost mid-pass                  | PassInterrupted(contextlost)
                        | R3F hall component throws during churn     | ChurnError (error boundary)
                        | churn or bloom control used mid-pass       | prevented: controls disabled
  sampler               | EXT_disjoint_timer_query_webgl2 missing    | gpuMs = null
                        | timer query reports disjoint               | sample dropped and counted
                        | performance.memory missing                 | heapBytes = null
  result output         | file download blocked                      | JSON stays in console and window.__benchResult

  ERROR                  | RESCUED | RESCUE ACTION                         | USER SEES
  -----------------------|---------|---------------------------------------|------------------------------------------
  InvalidParam           | Y       | fall back to home or load 1, warn     | console warning naming the parameter
  WebGLUnavailable       | Y       | stop, write result valid:false        | "WebGL2 unavailable: <reason>" in the view
  ComposerInitError      | Y       | stop, valid:false                     | error text in the view
  PassInterrupted(*)     | Y       | stop pass, valid:false, reason, time  | banner "Pass invalid: <reason> at <t> s"
  ChurnError             | Y       | stop pass, valid:false with message   | banner with the error
  gpuMs / heapBytes null | Y       | null, never 0                         | "n/a" in the ADR table
```

### Decision ledger additions (Sections 2+)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| C12 bench failure behaviour (Claude, Section 2) | Prime Directive 1 (zero silent failures); C10 "the ADR's results table is built from those JSON files"; chunk 03 has no failure behaviour | A: Section 2 registry (invalid-pass detection, locked controls, null not 0, param fallback) plus fake-clock unit tests | none | approved | PQ4 answer "Registry plus unit tests (recommended)", 2026-10-13; scope: spike bench and view failure behaviour and its unit tests; applied to chunk 03 Tasks and Acceptance |

### Answered decision C12 (PQ4)

Answer: A, "Registry plus unit tests (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Invalid-pass detection (hidden tab, resize, context lost, churn error) writes `valid:false` with reason | pending | none | yes | no; operator watches each run | yes |
| Controls disabled during a bench pass | pending | none | yes | no | yes |
| Missing GPU timer or heap reads `null`, never 0 | pending | not stated | yes | not stated | yes |
| Param allowlist (view, load 1 or 4, bench) with fallback and warning | C10 values (approved) | not stated | yes | not stated | yes |
| Unit tests: bench state machine with a fake clock (one valid pass, each interruption), param parsing, null handling | pending | none | yes | no | no |
| ADR table excludes invalid passes | C10 (approved) | implied | enforced by `valid` | operator judgement | enforced by `valid` |
| Effort | - | - | S | S | S |

Question: D4 — C12: What should the spike bench do when a measuring pass goes wrong?
Project/branch/task: Synapse Horizon, branch phase-1-rendering-spike, chunk 03 bench.
ELI10: The bench runs each scene for about half a minute and writes down timing numbers. If you switch tabs, resize the window or the graphics context resets during that time, the browser slows or pauses the scene and the numbers come out wrong but look normal. The R3F-or-vanilla decision is built from these numbers, so a bad pass can flip it without anyone noticing.
Stakes if we pick wrong: a silently corrupted pass lands in the ADR table and decides the integration for every later 3D chunk.
Recommendation: A because it closes every silent-failure path in the bench and proves each one with a fast unit test, for about 15 CC-minutes (zero silent failures, every behaviour tested).
Completeness: A=9/10, B=3/10, C=6/10
Net: about 15 CC-minutes for a bench that refuses bad numbers and proves it (A), versus trusting the operator (B), or flags with no proof they fire (C).
Header: Bench errors
A) Registry plus unit tests (recommended)
Adopt the registry above: invalid passes are flagged with a reason, controls lock during a pass, missing timers read null, and bad parameters fall back with a warning, all covered by unit tests on a fake clock. Effort S (human ~3h / CC ~15 min), risk low. ✅ A pass ruined by a tab switch or resize can never reach the ADR table as a valid result ✅ Each failure path has a fast test, so a refactor of the bench cannot quietly remove a guard ❌ About 15 CC-minutes of extra work on code that is deleted in chunk 04a
B) Happy path only
Keep chunk 03 as written; the operator watches each run and discards any pass that looks wrong. Effort S (zero extra work), risk high. ✅ No extra code in a spike that is thrown away after one decision ✅ Fewer moving parts for the first 3D code in the repo ❌ A pass slowed by a hidden tab looks like a slow integration, and nothing in the JSON says otherwise
C) Registry without tests
Adopt the same detection and fallbacks, but test them only by hand during the measuring runs. Effort S (human ~1.5h / CC ~8 min), risk medium. ✅ Bad passes are still flagged in the JSON and kept out of the ADR table ✅ Roughly half the extra work of A ❌ Nothing proves the guards fire; a missed event listener would leave a silent failure in place

Section 2 dispositions: registry adopted (C12, PQ4); 12 failure rows, 0 gaps after C12.

Bench pass state machine (C12):

```text
  idle ──start──► warmup (5 s) ──► steady (20 s) ──► churn (50 cycles) ──► settle (1 s) ──► done (valid:true)
                    │                 │                  │                    │
                    └──── hidden | blur | resize | contextlost | churn error ─┴──► invalid (valid:false, reason, t)
  Not allowed: any state ──► start (controls disabled until done or invalid); done | invalid ──► steady (a new pass
  needs a page load); churn ──► settle before the last removed hall has rendered its final frame (RW8).
```

### Section 3: Security & threat model (Phase 1)

| Threat | Likelihood | Impact | Mitigated? |
|---|---|---|---|
| New runtime dependencies (three, `@react-three/fiber`, `@react-three/postprocessing`, `postprocessing`) | Low | Medium | Yes: widely used MIT packages, lockfile, exact versions, Dependabot weekly (X2); R3F's React peer range held by the React ignore rule (eng S3) |
| Oversized `load` value allocating huge buffers and hanging the tab | Low | Low | Yes: allowlist, load 1 or 4 only (C12) |
| Bench JSON leaving the machine | Low | Low | Yes: console, `window.__benchResult` and a local download only; no network call (D16) |
| GPU name in committed JSON | Low | Low | Accepted: the renderer string names the GPU model only, no user data |

No endpoints, secrets, stored data or injection surfaces are added. No issues found beyond C12's parameter allowlist.

### Section 4: Data flow and interaction edge cases (Phase 1)

```text
 seed ─► fakeStore.tick (10 Hz) ─► snapshot per hall ─► frame: write instanceColor ─► upload ─► pixels
   nil:   no tick yet          ──► LEDs keep the colours set at mount
   empty: 0 extra halls        ──► nothing extra written; the frame is still timed
   wrong: NaN or outside [0,1] ──► store emits clamped values (test pending C13)
   stale: hall removed between tick and frame ──► writer walks live halls only; listener removed on unmount (RW9)
   error: context lost         ──► pass invalid (C12)
```

R3F churn schedule (baseline 12 halls, churn to 18 and back):

```text
 frame | churn driver          | React commit               | driver renders | store listeners
 ------|-----------------------|----------------------------|----------------|----------------
 n     | add 6 halls           |                            | 12 halls       | 12
 n..m  | await addHalls        | mount 6, refs attach       | 12 then 18     | 18
       | (may span frames, E16)|                            |                |
 m+1   |                       |                            | 18 halls (RW8) | 18
 m+1   | remove 6 halls        |                            |                |
 m+2   |                       | unmount, cleanup, dispose  | 12 halls       | 12
       |                       | scheduled on idle          |                |
 settle| read counts after 1 s |                            |                | must equal 12
```

Invariant: a hall's resources are released once, after its last rendered frame. Add and remove in one React batch would never mount the hall, so R3F would skip work vanilla does; RW8 forces one rendered frame per cycle. A frame between unmount and idle disposal does not draw the hall but leaves counts high; RW3's settle wait covers it. Regression proof: the C12 bench unit tests assert one rendered frame per churn cycle (required test for RW8).

| Interaction | Edge case | Handled? | How |
|---|---|---|---|
| Churn button | double click, click during a pass | Y | disabled while churn or a pass runs (C12) |
| Bloom toggle | toggled mid-pass | Y | disabled during a pass (C12) |
| `bench=1` page | navigate away mid-pass | Y | no result written; an absent result means rerun |
| Window | resize or tab hidden mid-pass | Y | pass invalid with reason (C12) |
| URL | `load=999999`, `view=foo` | Y | allowlist fallback and warning (C12) |
| Back button | returns to the other spike URL | Y | full page load, fresh view |

- D-1 [P2] (confidence 8/10) Chunk 03 did not say whether racks and LEDs are global or per hall, whether both views write the same buffers per frame, or how churn interacts with React batching. Required for the fair race (chunk 03 Goal) and the chunk 07 pattern; applied as RW8.
- D-2 [P2] (confidence 7/10) A per-hall store subscription that is never released is a leak `renderer.info` cannot see, and Safari and Firefox expose no heap number. Required by the section 1 criterion "leaks we cannot control"; applied as RW9.

### Section 5: Code quality (Phase 1)

- Q-1 [P3] One shared scene definition is the fairness guarantee: both views read instance counts and positions from `src/spike/shared/scene.ts`, never their own copies. Already in RW8 and the Section 1 diagram; no change.
- Q-2 [P3] Keep the bench spike-local and small; under HOLD SCOPE it is not a general perf framework and is deleted in 04a. No change.

No other issues found.

### Section 6: Test review (Phase 1)

```text
 NEW THING                         | TYPE        | IN PLAN?           | HAPPY                    | FAILURE                     | EDGE
 ----------------------------------|-------------|--------------------|--------------------------|-----------------------------|---------------------------
 bench state machine (C12, RW8)    | unit        | yes (C12)          | one valid pass           | each interruption -> invalid| one frame per churn cycle
 params parse (C12)                | unit        | yes (C12)          | view, load, bench parsed | junk -> fallback + warning  | load=2 refused
 sampler nulls (C12)               | unit        | yes (C12)          | GPU ms recorded          | extension missing -> null   | disjoint sample dropped
 stats: median, p95, p99           | unit        | pending C13        | known array -> values    | empty -> null               | one sample, ties
 scene layout per load             | unit        | pending C13        | 192/3,072, 768/12,288    | -                           | per hall 16/256, 64/1,024
 fake store (seeded)               | unit        | pending C13        | same seed, same sequence | -                           | values in [0,1]
 spike views in 3 engines          | e2e (local) | pending C13        | canvas, no console error | WebGL init error shown      | load 1 and 4
 churn leak baseline               | measured    | yes (RW3, RW6, RW9)| counts back to baseline  | -                           | listeners, programs
```

Assertion check for approved items: C12's tests assert `valid:false` plus the exact reason for each interruption (rejects a pass that ends `valid:true` after a hidden tab; `no_claim`=real browser event timing, events are simulated on a fake clock, unit only). RW8's test asserts exactly one rendered frame between add and remove per cycle (rejects zero; `no_claim`=React's real batching, the driver is tested with a fake view).

### Decision ledger additions (Section 6)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| C13 spike test scope (Claude, Section 6) | engineering preference "every behaviour tested"; the percentile maths computes the deciding numbers (C10); no test exists for stats, scene or store | A: unit tests for stats, scene layout and seeded store, plus both spike views in the `e2e:local` smoke (3 engines, skipped in CI) | none | approved | PQ5 answer "Unit tests plus local smoke (recommended)", 2026-10-13; scope: spike unit tests and local smoke only; no CI job; applied to chunk 03 Tasks and Acceptance |

### Answered decision C13 (PQ5)

Answer: A, "Unit tests plus local smoke (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| C12 bench, params and null tests | C12 (approved) | yes | yes | yes | yes |
| Unit tests: stats (nearest-rank median, p95, p99; empty gives null) | pending | no | yes | yes | yes |
| Unit tests: scene layout counts per load and per hall | pending | no | yes | yes | yes |
| Unit tests: seeded store (same seed, same sequence; values in [0,1]) | pending | no | yes | yes | yes |
| Both spike views in `vp run e2e:local` smoke (Chromium, Firefox, WebKit on the Mac) | pending | no | yes | no | yes |
| Spike smoke in CI (Chromium, Firefox on ubuntu, software WebGL) | pending | no | no | no | yes |
| Effort | - | - | S | S | S |

Question: D5 — C13: Which tests should guard the spike's own code?
Project/branch/task: Synapse Horizon, branch phase-1-rendering-spike, chunk 03 tests.
ELI10: C12 already tests how the bench handles failures. Three other small pieces turn raw timings into the numbers the ADR uses: the percentile maths, the scene layout per load, and the seeded fake data. A bug in the percentile maths would flip the decision while every run looks fine. Separately, a quick smoke test can open both spike views in Chrome, Firefox and WebKit to catch a view that crashes in one engine.
Stakes if we pick wrong: a wrong p95 calculation or a view that fails in one engine feeds a wrong number, or no number, into the decision.
Recommendation: A because it pins the maths that computes the deciding numbers and catches engine-specific crashes on real GPUs, without adding a CI job that may flake (every behaviour tested, explicit over clever).
Completeness: A=9/10, B=6/10, C=9/10
Net: maths plus a real-GPU smoke (A), maths only (B), or both plus a CI job that may flake on software WebGL (C).
Header: Spike tests
A) Unit tests plus local smoke (recommended)
Unit tests for the percentile maths (nearest-rank median, p95, p99; empty input gives null), the scene layout per load and the seeded fake store, plus both spike views in the `vp run e2e:local` smoke in all three engines. Effort S (human ~2h / CC ~10 min), risk low. ✅ The code that computes the deciding numbers is pinned by known-answer tests ✅ A view that crashes only in WebKit or Firefox is caught on the Mac's real GPU before the runs ❌ The spike smoke never runs in CI, so a broken view shows up only when e2e:local runs
B) Unit tests only
Unit tests for the percentile maths, the scene layout and the seeded store; no smoke test of the views. Effort S (human ~1h / CC ~5 min), risk medium. ✅ The deciding maths is still pinned by fast known-answer tests ✅ No new browser test to maintain for views deleted in chunk 04a ❌ An engine-specific crash in a view is found only by hand during the measuring runs
C) Unit tests plus local and CI smoke
Everything in A, plus the spike smoke in the CI Chromium and Firefox jobs on ubuntu, where WebGL is software-rendered [unverified on these runners]. Effort S (human ~3h / CC ~20 min), risk medium. ✅ A broken spike view fails the PR check, not only the local run ✅ Same unit coverage as A for the deciding maths ❌ Software WebGL on CI runners may fail or flake, adding noise to every PR until chunk 04a

Section 6 dispositions: C13 approved (PQ5); 0 test gaps after C12 and C13. Test ambition: the 2am-Friday test is a hidden-tab pass that must come out `valid:false` (C12); the hostile test is a churn that adds and removes inside one React batch (RW8 test); the chaos test is `WEBGL_lose_context` mid-pass (C12). Pyramid: about 6 unit suites, 1 local e2e spec, no CI e2e for the spike. Flakiness: unit tests use a fake clock and a fixed seed; the local smoke depends on a real GPU and runs only on the Mac.

### Section 7: Performance (Phase 1)

The spike is the performance measurement, so this section checks the measurement itself. Memory at 4x: about 13,056 instance matrices (about 836 KB) and colours (about 157 KB) [estimated from 64 B and 12 B per instance]; trivial. Slowest new paths: the per-frame colour write at 4x (13,056 instances), the shadow pass (instanced meshes drawn twice) and the bloom passes; all are the subject of the measurement, not a defect.

- P-1 [P1] (confidence 7/10) C10's rule compares p95 values with a 1 ms or 15% threshold, but the plan runs each case once. Browser frame times wobble from pass to pass (thermal state, background work, compositor timing) [inference, no local numbers yet], so a single pass can cross the threshold on noise alone and pick the integration for every later 3D chunk. Pending: C14.

### Decision ledger additions (Section 7)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| C14 passes per case (Claude, Section 7) | C10 rule (approved) "1 ms or 15%" at 4x; P-1 single-pass noise | C: 3 alternating passes per 4x case (bloom on and off), median p95, gap must exceed both views' pass-to-pass range; 1 pass per 1x case; 48 passes | none | approved | PQ6 answer "Three passes where the rule decides (recommended)", 2026-10-13; scope: pass count and noise guard for the C10 rule; thresholds unchanged; applied to chunk 03 Acceptance |

### Answered decision C14 (PQ6)

Answer: C, "Three passes where the rule decides (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| C10 thresholds (1 ms or 15%, counts, 2x churn frame) at 4x | C10 (approved) | yes | yes | yes | yes |
| Passes per case at 4x, bloom on and off (rule inputs) | pending | 1 | 3, alternating R3F and vanilla | 1 | 3, alternating R3F and vanilla |
| Passes per case at 1x (absolute 60 fps bar only) | pending | 1 | 3 | 1 | 1 |
| Value used per case | pending | the single pass | median of 3 pass p95 values | the single pass | median of 3 at 4x |
| Noise guard | pending | none | a gap counts only if larger than both views' pass-to-pass range of p95 | none | same as A, at 4x |
| Total passes (3 browsers x 2 views x 2 loads x 2 bloom states) | - | 24 | 72 | 24 | 48 |
| Operator run time [estimated: ~35 s per pass plus reloads and cool-downs] | - | ~25 min | ~1.2 h | ~25 min | ~50 min |

Question: D6 — C14: How many measuring passes should feed the decision rule?
Project/branch/task: Synapse Horizon, branch phase-1-rendering-spike, chunk 03 measuring protocol.
ELI10: Each pass gives one p95 frame time, and browsers are noisy: the same scene can read, say, 6.1 ms in one pass and 6.9 ms in the next. The rule picks vanilla if R3F is more than 1 ms or 15% slower, so one pass per case could flip the decision on noise. Repeating passes and ignoring gaps smaller than the pass-to-pass wobble makes the result hold up.
Stakes if we pick wrong: one noisy pass can pick the wrong integration, or rule out the right one, for every later 3D chunk.
Recommendation: C because the rule only reads the 4x passes, so repeats there buy noise protection where the decision is made, at about two thirds of A's run time.
Completeness: A=10/10, B=5/10, C=9/10
Net: full repeats (A), single shots that may decide on noise (B), or repeats where the rule decides (C).
Header: Pass count
A) Three passes everywhere
Run every case three times, alternating R3F and vanilla, use the median p95, and count a gap only when it is larger than both views' pass-to-pass range. Effort S (human ~1.2h of runs / CC ~5 min for the noise guard), risk low. ✅ Every number in the ADR, including the 1x 60 fps check, rests on three passes ✅ Noise can never decide the integration on its own ❌ About 72 passes by hand across three browsers, roughly 1.2 hours of operator time
B) One pass per case
Keep the current protocol: one pass per browser, view, load and bloom state, with no noise guard. Effort S (zero extra work), risk high. ✅ Shortest run session, about 25 minutes across three browsers ✅ Nothing to add to the bench or the ADR rule ❌ A single noisy pass can cross the 1 ms or 15% line and pick the wrong integration
C) Three passes where the rule decides (recommended)
Run the 4x cases (bloom on and off) three times, alternating R3F and vanilla, with the median and the noise guard from A; run the 1x cases once for the absolute 60 fps check. Effort S (human ~50 min of runs / CC ~5 min), risk low. ✅ Noise protection exactly where the decision rule reads its numbers ✅ About two thirds of A's operator time, 48 passes instead of 72 ❌ The 1x 60 fps check rests on one pass per case, so a borderline 1x miss needs a manual rerun

Section 7 dispositions: P-1 resolved by C14 (PQ6).

### Section 8: Observability (Phase 1)

The bench JSON is this chunk's only telemetry, and the ADR is its dashboard. As written, a result file would not say which browser version, refresh rate, pixel ratio or GPU produced it, so three weeks later nobody could tell whether two numbers are comparable.

- O-1 [P2] (confidence 8/10) Required by C10 ("the ADR's results table is built from those JSON files"): each result carries its run metadata, raw files are committed, and the view shows the pass status. Applied as RW10.
- Runbook: an invalid pass is rerun; a browser that cannot start WebGL2 is recorded in the ADR as a failure for both views with its reason; a pass with no result file is UNKNOWN and rerun, never counted.

### Section 9: Deployment and rollout (Phase 1)

```text
 chunk/03 branch:  commit 1: ADR with settings, method, rule (C10, C14)   ──► SHA named in the ADR (RW11)
                   commit 2: spike views, bench, tests                     ──► vp check, vp test, e2e:local
                   runs:     48 passes on the M1 Max, production build      ──► JSON start times after commit 1
                   commit 3: results, table, decision, consequences, README, 03-spike.png
 PR ──► CI (check, test, Chromium + Firefox smoke without the spike spec) ──► squash-merge ──► release.yml
 rollback: revert the PR; spike views sit behind ?view=, so users see no change either way
 chunk 04a: delete src/spike/, the App.tsx branch, the spike-* shots entry, the rejected dependency (RW7)
```

- Dep-1 [P2] (confidence 8/10) Squash-merge (D18) leaves one commit on `main`, so "rule committed before the first run" (C10) cannot be checked from `main` alone. Required to keep an approved acceptance checkable; applied as RW11.
- Dep-2 [P3] (confidence 6/10) PR type: CONTRIBUTING maps `feat:` to a minor release. Nothing user-facing ships in chunk 03 (the views sit behind `?view=`), so a non-releasing type such as `chore(spike):` matches D19's intent; `feat:` would cut 0.3.0 with a throwaway view in the CHANGELOG. Guidance for the implementer under existing CONTRIBUTING rules; no plan change.
- No migrations, flags or deploy-time window. Post-merge check: `release.yml` green, and no release for a non-`feat` title.

### Section 10: Long-term trajectory (Phase 1)

- Reversibility: spike code 5/5 (deleted in 04a); the integration decision 2/5 once chunks 04a-10 build on it.
- Debt and path dependency: (1) R3F 10 is in alpha and canary, WebGPU-first [measured: `npm view` dist-tags], so an R3F pick implies a later 9-to-10 migration; (2) R3F 9.8.1's peer range holds React below 19.4 (eng S3, Dependabot ignore rule); (3) WebGL2 only: three 0.186 ships `three/webgpu` with a WebGL2 fallback, and secondary sources report WebGPU on by default in Safari 26 and Firefox 147 [unverified]; not measured under HOLD SCOPE; (4) the 4x level is not the chunk 36 scene; (5) the M1 Air-class check moved to chunk 36 (C11).
- T-1 [P2] (confidence 7/10) An ADR without its known consequences reads as final when it is not; applied as RW12 so these five items sit in the ADR.
- 1-year question: a new engineer reads ADR 0001, its raw JSON and this record and can see why the integration was picked and what would reopen it.

### Section 11: Design and UX (Phase 1)

The spike adds dev-only views: a canvas, a churn button, a bloom toggle and a one-line pass status. No product screen, token or design-system change; the views are deleted in 04a.

```text
  FEATURE     | LOADING                     | EMPTY | ERROR                                   | SUCCESS             | PARTIAL
  spike view  | blank canvas to first frame | n/a   | "WebGL2 unavailable: <reason>" (C12)    | scene and controls  | GPU time "n/a"
  bench pass  | status: current phase       | n/a   | "Pass invalid: <reason> at <t> s" (C12) | "done" + JSON       | n/a

  open /?view=spike-*  ──► first frame ──► [bench=1] warmup ► steady ► churn ► settle ──► done | invalid
```

No issues found. `/plan-design-review` is not needed for this phase.

### Outside voice (Phase 1)

`codex_reviews` is disabled by config. Recorded as `outside_status: disabled` (review log, commit `dc8612a`). No external or native challenge ran; this is an opt-out, not missing coverage to replace.

### TODOS.md (Phase 1)

No TODO proposals. Under HOLD SCOPE a TODO must address an evidenced gap in accepted scope; none remains open after C10-C14 and RW1-RW12. Chunk 36's "200 racks" overrun is outside Phase 1 and noted for that chunk's review.

### Approval readiness (Phase 1)

Checked rows and answers: C10 (PQ1), C11 (PQ3), C12 (PQ4), C13 (PQ5), C14 (PQ6). Mode: PQ2 (HOLD SCOPE, user choice; not a remedy approval). Required work without a new choice, each citing its contract: RW1-RW5 (chunk 03 Goal and Acceptance, surface check, numbers), RW6-RW7 (Section 1), RW8-RW9 (Section 4), RW10 (Section 8), RW11 (Section 9), RW12 (Section 10). Every plan edit in chunks 03, 36 and section 4 maps to one of these; no unanswered remedy is in the plan.

Approval readiness: PASS

### NOT in scope (Phase 1)

- Not offered under HOLD SCOPE (PQ2): keeping the bench for chunks 20 and 36; a WebGPU renderer data point; a glass-overlay cost check.
- Rejected by user choice: keeping chunk 03 as written and R3F-only bars (PQ1); measuring on an M1 Air now and retargeting to the M1 Max (PQ3); happy-path bench (PQ4); CI spike smoke (PQ5); three passes at 1x and one pass at 4x (PQ6).
- Moved, not cut: the M1 Air-class measurement to chunk 36 (C11).
- Outside Phase 1: chunk 36's "200 racks" overrun of the 192-rack campus cap.

### What already exists (Phase 1)

Playwright with three engines and a build-and-preview server, the shots pipeline and its `view=` contract, design tokens, CI, Dependabot. Reused: the `view=` contract (RW4) and Playwright for the local spike smoke (C13). No three, R3F or postprocessing code exists; nothing is rebuilt.

### Dream state delta (Phase 1)

After chunk 03: an integration decision backed by 48 passes, a pre-registered rule and committed raw data, with the shared-material and listener leak paths tested. Still missing from the 12-month ideal: numbers on M1 Air-class hardware (chunk 36), a perf and leak harness that outlives the spike (not taken under HOLD), and the campus itself (04a-10).

### Error and rescue registry (Phase 1)

See "Section 2: Error & Rescue Map (Phase 1)": 12 failure rows, all rescued, each with a named user-visible result and a unit test (C12).

### Failure modes registry (Phase 1)

```text
  CODEPATH           | FAILURE MODE                         | RESCUED? | TEST?            | USER SEES?                      | LOGGED?
  -------------------|--------------------------------------|----------|------------------|---------------------------------|--------
  spike params       | unknown view, bad load, junk bench   | Y        | Y (unit)         | fallback + console warning      | Y
  view init          | no WebGL2, bloom init throws         | Y        | Y (unit)         | reason in the view              | Y
  bench pass         | hidden tab, blur, resize             | Y        | Y (unit)         | "Pass invalid: <reason> at <t>" | Y (JSON)
  bench pass         | context lost                         | Y        | Y (unit)         | same banner                     | Y (JSON)
  churn (R3F)        | hall throws during mount or unmount  | Y        | Y (unit)         | banner with error               | Y (JSON)
  churn (R3F)        | add and remove in one batch          | Y        | Y (unit, RW8)    | none needed                     | n/a
  churn (both)       | shared material disposed             | Y        | measured (RW6)   | ADR row fails; black hall shot  | Y (JSON)
  churn (both)       | listener leak                        | Y        | measured (RW9)   | ADR row fails                   | Y (JSON)
  sampler            | no GPU timer, no heap                | Y        | Y (unit)         | "n/a"                           | Y (null)
  result output      | download blocked                     | Y        | N (browser)      | JSON in console                 | Y
  stats              | wrong percentile maths               | Y        | Y (unit, C13)    | none needed                     | n/a
  measurement        | single noisy pass decides            | Y        | protocol (C14)   | ADR shows 3-pass spread         | Y (JSON)
```
CRITICAL GAPS: 0.

### Diagrams produced (Phase 1)

Dream state (0C), temporal sequence (0I), system architecture (Section 1), bench state machine and error flow (Section 2), data flow with shadow paths and churn schedule (Section 4), test map (Section 6), deployment sequence and rollback (Section 9), user flow and states (Section 11).

### Stale diagram audit (Phase 1)

- Section 3 architecture picture: accurate (the spike sits outside the data path).
- Section 6 dependency summary: accurate (`02 → 03 (gate) → 04a`).
- Section 4b interaction state table: unaffected (spike views are dev-only).
- Eng review and Phase 0 diagrams: unaffected.

### Reality rows (Phase 1)

- REALITY: premise-table finding unverified=3 (Safari 60 fps default on macOS not checked locally; M1 Max vs M1 Air GPU ratio; WebGPU on by default in Safari 26 and Firefox 147 from secondary web sources) docs/PLAN.md:433
- REALITY: already-done pass `git log origin/main -- src/spike docs/adr src/scene` shows only `f72dee8` (scaffold `.gitkeep`); no spike code exists docs/PLAN.md:430
- REALITY: surface-check finding `/spike/*` paths had no router and the shots contract uses `view=<name>`; applied as RW4 docs/PLAN.md:433
- REALITY: binding-decisions pass section 1 open decision, D1, D10, D18, eng S3 honoured; C10-C14 logged with `gstack-decision-log` docs/PLAN.md:34
- REALITY: numbers finding 200 racks exceeded the 192-rack cap (RW5); thresholds, durations and effort figures are [estimated]; package versions [measured: `npm view`] docs/PLAN.md:433
- REALITY: deferred-asks pass no brief item is scheduled into Phase 1 beyond the integration decision docs/PLAN.md:34
- REALITY: pr-count pass no ship policy; one PR for chunk 03 plus this review's docs PR docs/PLAN.md:31

PLAN_REALITY: phase=ceo rows=7/7 missing=none unverified=3 verdict=complete

## Implementation Tasks (CEO review, Phase 1)

Synthesized from this review's findings. Each task derives from a specific finding above. Effort ratios assumed: features ~30x, tests ~50x, docs ~30x; operator measuring runs are human time with no CC share.

- [ ] **T1 (P1, human: ~1 day / CC: ~40min)** — spike — Shared scene, fake store and renderer settings; vanilla and R3F views with per-hall instancing, shared materials and identical per-frame work
  - Surfaced by: C10 (PQ1); RW1, RW4, RW5, RW6, RW8, RW9
  - Files: package.json, pnpm-lock.yaml, src/spike/shared/scene.ts, src/spike/shared/fakeStore.ts, src/spike/shared/render.ts, src/spike/vanilla/view.ts, src/spike/r3f/View.tsx, src/app/App.tsx
  - Verify: `/?view=spike-r3f&load=4` and `/?view=spike-vanilla&load=4` render 18-hall churn with shared materials intact; `vp check`
- [ ] **T2 (P1, human: ~4h / CC: ~20min)** — spike bench — Driver, sampler, settle, churn cycles, JSON records with metadata, failure registry and fake-clock tests
  - Surfaced by: C10 (PQ1), C12 (PQ4); RW2, RW3, RW8, RW10
  - Files: src/spike/shared/bench.ts, src/spike/shared/params.ts, src/spike/shared/bench.test.ts, src/spike/shared/params.test.ts
  - Verify: `vp test` covers all 12 registry rows and one rendered frame per churn cycle
- [ ] **T3 (P2, human: ~2h / CC: ~10min)** — spike tests — Stats, scene and store unit tests; local three-engine smoke skipped in CI
  - Surfaced by: C13 (PQ5)
  - Files: src/spike/shared/stats.ts, src/spike/shared/stats.test.ts, src/spike/shared/scene.test.ts, src/spike/shared/fakeStore.test.ts, e2e/spike.spec.ts
  - Verify: `vp test`; `vp run e2e:local` opens both views at load 1 and 4 in all three engines with no console errors; CI log shows the spike spec skipped
- [ ] **T4 (P1, human: ~30min / CC: ~5min)** — docs — ADR 0001 with settings, method, decision rule and pass protocol, committed before any run
  - Surfaced by: C10 (PQ1), C14 (PQ6); RW1, RW11
  - Files: docs/adr/0001-render-integration.md
  - Verify: the rule commit's SHA is named in the ADR and precedes every result's start time
- [ ] **T5 (P1, human: ~1.5h / CC: none)** — measurement — 48 passes on the M1 Max production build in Chrome, Safari and Firefox; raw JSON, results table, decision, consequences
  - Surfaced by: C10, C11 (PQ3), C14 (PQ6); RW10, RW12
  - Files: docs/adr/0001-results/*.json, docs/adr/0001-render-integration.md
  - Verify: table built only from `valid:true` files; rule applied as written; 1x rows labelled "M1 Max, overstates M1 Air GPU"
- [ ] **T6 (P2, human: ~30min / CC: ~5min)** — docs — README "Architecture" stub linking the ADR; `spike-r3f` shots view and `03-spike.png`
  - Surfaced by: RW4; section 4 protocol
  - Files: README.md, scripts/shots.config.ts, docs/img/03-spike.png
  - Verify: `vp run shots` writes `03-spike.png` under 200 KB
- [ ] **T7 (P3, human: ~30min / CC: ~5min)** — chunk 04a cleanup — Delete spike views, App branch, spike shots entry and the rejected dependency
  - Surfaced by: Section 1 — A-2, RW7
  - Files: src/spike/, src/app/App.tsx, scripts/shots.config.ts, package.json, pnpm-lock.yaml
  - Verify: `vp run shots` and `vp test` pass after deletion; `03-spike.png` unchanged

### Completion summary (Phase 1)

```text
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | HOLD SCOPE                                  |
  | System Audit         | no 3D code yet; dev Mac is M1 Max on a      |
  |                      | 120 Hz display; Safari near 60 fps; R3F 9.8 |
  |                      | peer React <19.4; R3F 10 in alpha           |
  | Step 0               | C10 decision-grade race; C11 measure on M1  |
  |                      | Max, M1 Air check to chunk 36; RW1-RW5      |
  | Section 1  (Arch)    | 3 issues found (A-1, A-2 applied; A-3 open  |
  |                      | implementation choice)                      |
  | Section 2  (Errors)  | 12 error paths mapped, 0 GAPS after C12     |
  | Section 3  (Security)| 0 issues found, 0 High severity             |
  | Section 4  (Data/UX) | 11 edge cases mapped, 0 unhandled (RW8, RW9)|
  | Section 5  (Quality) | 0 issues found (2 P3 notes)                 |
  | Section 6  (Tests)   | Diagram produced, 0 gaps after C13          |
  | Section 7  (Perf)    | 1 issue found (P-1, resolved by C14)        |
  | Section 8  (Observ)  | 1 gap found (O-1, RW10)                     |
  | Section 9  (Deploy)  | 2 risks flagged (RW11 applied; type note)   |
  | Section 10 (Future)  | Reversibility: 5/5 code, 2/5 decision;      |
  |                      | debt items: 5                               |
  | Section 11 (Design)  | 0 issues (dev-only views)                   |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (4 groups, 11 items)                |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 12 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 12 total, 0 CRITICAL GAPS                   |
  | TODOS.md updates     | 0 items proposed                            |
  | Scope proposals      | 0 proposed, 0 accepted (HOLD SCOPE)         |
  | CEO plan             | skipped by mode                             |
  | Outside voice        | codex disabled (config)                     |
  | Lake Score           | 0/2 recommendations chose complete option   |
  | Diagrams produced    | 8 (dream, temporal, arch, state/error,      |
  |                      | data flow + schedule, tests, deploy, flow)  |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 0                                           |
  | Reality rows         | 7/7 rows (PLAN_REALITY complete), 3 unverif.|
  +====================================================================+
```

Lake Score basis: two answered questions offered a 10/10 option (C11, C14); both answers took the recommended 9/10 or 8/10 option. C10, C12 and C13 offered no 10/10 option and are excluded.

### Unresolved decisions (Phase 1)

None. Open verifications (not decisions): Safari's 60 fps default on this Mac; WebGPU defaults in Safari and Firefox; `EXT_disjoint_timer_query_webgl2` in Safari and Firefox; A-3 bundle split left to the implementer.

## Eng review record: Phase 1 (/plan-eng-review, 2026-10-13)

Target: `docs/PLAN.md` Phase 1 (chunk 03) as amended by the Phase 1 CEO review (C10-C14, RW1-RW12), branch `phase-1-rendering-spike`, base `dc8612a` plus uncommitted CEO review edits. Reviewer: Claude (in-host). Report file: this plan. Question numbers D1, D2... are this review's own sequence; ledger rows continue the eng series at E6. Design doc found by the finder is `docs/designs/phase-0-tooling.md` (Phase 0 only); no Phase 1 design doc.

### Scope record

feature answers: none proposed (no feature cuts); structure: A, Original arrangement (eng D1, 2026-10-13); accepted scope: chunk 03 as amended by CEO C10-C14 and RW1-RW12, one module per concern in `src/spike/shared/` with one test file each; pending remedies: E6, E7.

Scope Challenge result: scope accepted as-is.

### Scope Challenge findings

Evidence probes (bounded, current behaviour only): a Playwright 1.64 script in the session scratchpad loaded a static page in headless Chromium 156, Firefox 157 and WebKit 27.2 on this Mac, with and without COOP/COEP headers on `127.0.0.1` [measured]:

| Engine | WebGL2 | `EXT_disjoint_timer_query_webgl2` | Renderer | `performance.now()` step, plain | step, cross-origin isolated |
|---|---|---|---|---|---|
| Chromium 156 (headless) | yes | no | SwiftShader (software) | 0.1 ms | 0.005 ms |
| Firefox 157 (headless) | yes | no | "Apple M1, or similar" | 1 ms | 0.02 ms |
| WebKit 27.2 (headless) | yes | no | "Apple GPU" | 1 ms | 0.02 ms |

Real Chrome, Safari and Firefox were not probed; Playwright's WebKit and Firefox builds are close to, not the same as, the shipping browsers [unverified for real browsers].

- E6 [P1] (confidence 9/10) docs/PLAN.md chunk 03 Tasks: "CPU frame time (update + render, `performance.now()`) median, p95 and p99". On this Mac, Firefox and WebKit step `performance.now()` in 1 ms units unless the page is cross-origin isolated (probe above). C10's rule fires on a gap "more than 1 ms", so in Firefox and Safari the deciding gap is one timer tick, and rounding alone can decide the integration. Pending: E6.
- E7 [P2] (confidence 8/10) `postprocessing` 6.39.5 declares peer `three: ">=0.168.0 <0.187.0"` [measured: `npm view`]; the plan adds three 0.186.1, and `.github/dependabot.yml:17-35` groups all npm updates weekly with ignore rules only for React. When three 0.187 ships, Dependabot proposes it; pnpm only warns on peer mismatch, and the spike smoke is skipped in CI (C13), so the bump can merge green while bloom breaks. Pending: E7.
- E8 [P1] (confidence 9/10) RW1 requires "the same bloom library", but the two entry points have different composer defaults: `@react-three/postprocessing` 3.2.0 `EffectComposer` defaults to `multisampling = 8` and `frameBufferType = HalfFloatType` (react-postprocessing `EffectComposer.tsx`, via Context7), while `postprocessing` 6.39.5's `EffectComposer` defaults to `multisampling = 0` and `UnsignedByteType` (`build/index.js:948-949` in the published tarball). Left to defaults, the R3F view would do 8x MSAA on half-float targets and the vanilla view none, and every bloom-on number would favour vanilla. Required work under C10 (PQ1) and RW1 ("RW1 renderer and bloom settings (one constant)"); applied below.
- E9 [P2] (confidence 8/10) RW6's "no hall renders black" has no check that a JSON result can carry. three dispatches a `dispose` event from `Material.dispose()`, so the bench can count dispose events on the shared materials during churn (must be 0). Required proof for RW6; applied.
- E10 [P2] (confidence 8/10) C10 claims the 4x level keeps "the same draw-call count". With a composer, three resets `renderer.info.render` on every `render()` call (`info.autoReset` defaults to true), so a single read sees only the last pass. Proof needs `info.autoReset = false` with one `info.reset()` per frame, and draw calls per frame in each JSON result. Required proof for C10's stated invariant; applied.
- E11 [P2] (confidence 8/10) `scripts/shots.config.ts:13` opens every view as `/?source=mock&scenario=steady&seed=1&freeze=1&view=<name>`, and section 4 says `freeze=1` stops the animation clock. C12's parameter parsing must accept `source`, `scenario`, `seed` and `freeze` without warnings, the spike views must seed the fake store from `seed` and render one fixed frame under `freeze=1`, and `bench=1` with `freeze=1` must be refused with a warning (a frozen clock cannot be measured). Required by the section 4 URL contract and C12; applied.
- E12 [P3] (confidence 9/10) Headless Playwright Chromium renders WebGL on SwiftShader (probe above), and Playwright's WebKit is not Safari. The C13 smoke is a crash check only; no number in the ADR may come from a Playwright run. Factual clarification; applied.
- E13 [P3] (confidence 5/10) Medium confidence, verify this is actually an issue: the repo runs TypeScript `~7.0.2` (`package.json`) and R3F 9 adds its JSX elements by augmenting React's JSX types. Nothing has checked that the augmentation type-checks under TypeScript 7. Verification step for T1 (run `vp check` right after installing R3F); no plan change.
- E14 [P3] (confidence 9/10) Outside Phase 1: plan chunk 01 still says Dependabot uses `fix(deps)` for runtime dependencies and that the dev server host is `127.0.0.1`, but `main` now uses `build(deps)` (`b17f26e`, #8) and `localhost` (`dc8612a`, #9). Stale plan text, flagged for a docs fix; no Phase 1 change.

Search check: the R3F-specific pattern (driving `frameloop="never"` with `advance()` from an external `requestAnimationFrame` loop) is documented R3F API [Layer 1]; cross-origin isolation for high-resolution timers is the standard platform mechanism [Layer 1, confirmed by the probe]. TODOS.md holds only `vp run doctor` (X3); nothing blocks or overlaps chunk 03. Distribution: no new artifact; the spike rides in the existing web bundle until chunk 04a.

### Decision ledger (eng review, Phase 1)

### E6: Timer resolution for the measuring runs
Finding: E6, P1, confidence 9/10, docs/PLAN.md chunk 03 Tasks ("CPU frame time (update + render, `performance.now()`)"), reviewer Claude (in-host)
Plan baseline: CEO C10 (PQ1) and RW2: per-frame CPU time, p95 and p99; runs on the production build via `vp preview` or `vp run serve` (Phase 1 0I); no timer-resolution requirement.
Runtime evidence: Playwright probe on this Mac: plain pages step 0.1 ms (Chromium), 1 ms (Firefox, WebKit); with COOP `same-origin` and COEP `require-corp` on `127.0.0.1`, `crossOriginIsolated` is true and steps are 0.005 ms, 0.02 ms, 0.02 ms. Real browsers unknown.
Comparison grid:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| C10 rule thresholds and C14 pass protocol | C10 (PQ1), C14 (PQ6) approved | unchanged | unchanged | unchanged | unchanged |
| Per-frame p95 and p99 of CPU time | RW2 (C10 contract) | per frame | per frame | per 10-frame batch (changes RW2) | per frame |
| Timer step in Firefox and Safari [Playwright probe] | - | 1 ms | 0.02 ms | 1 ms, averaged over 10 frames | 1 ms |
| Server for measuring runs | Phase 1 0I | `vp preview` or `vp run serve` | `vp build` + `vp preview --host 127.0.0.1` only | either | either |
| COOP/COEP headers | pending | none | `preview.headers` in `vite.config.ts` | none | none |
| JSON records `crossOriginIsolated` and measured timer step | pending | no | yes | yes | yes |
| Pass with a timer step coarser than 0.1 ms | pending | counted | `valid:false`, reason `coarse-timer`, unit-tested | counted | counted |
| Effort | - | - | S | S | S |

Question D2:
D2 — E6: How should the bench get timings fine enough for the 1 ms rule?
Project/branch/task: Synapse Horizon, branch phase-1-rendering-spike, chunk 03 bench timing.
ELI10: The bench times each frame with the browser's stopwatch. On this Mac, Firefox and Safari's engine round that stopwatch to whole milliseconds unless the page opts into a stricter security mode called cross-origin isolation; with it, they report steps of 0.02 ms (probe on this Mac). The decision rule picks vanilla when R3F is more than 1 ms slower, so without isolation a single rounding step can decide the integration in two of the three browsers.
Stakes if we pick wrong: the ADR picks the integration for every later 3D chunk from numbers that are rounded to the size of the deciding gap.
Recommendation: A because two response headers give 20x (Chromium) to 50x (Firefox, WebKit) finer timing on the measured probe, and a coarse-timer pass is then refused instead of trusted (zero silent failures, every behaviour tested).
Completeness: A=10/10, B=7/10, C=3/10
Net: fine timers through two headers (A), coarse timers smoothed over batches at the cost of per-frame spikes (B), or rounding left in the decision (C).
Header: Timer res
Options:
A) Isolate the measuring page (recommended)
Add COOP `same-origin` and COEP `require-corp` to `preview.headers` in `vite.config.ts`; measuring runs use `vp build` then `vp preview --host 127.0.0.1`, not `vp run serve`; each result records `crossOriginIsolated` and the measured timer step, and a pass with a step coarser than 0.1 ms is `valid:false` (`coarse-timer`), with a unit test. Effort S (human ~1h / CC ~5 min), risk low. ✅ Probe on this Mac: steps drop from 1 ms to 0.02 ms in Firefox and WebKit, 0.1 ms to 0.005 ms in Chromium ✅ A run that loses isolation is refused automatically, never averaged into the ADR ❌ The headers also apply to e2e and shots previews; harmless while every asset is same-origin, but a future cross-origin asset there would need CORP
B) Time 10-frame batches
Keep plain timers; time batches of 10 frames and compute p95 and p99 over batch averages, recording the timer step. Effort S (human ~1h / CC ~10 min), risk medium. ✅ No server or header change, and works the same under `vp run serve` ✅ Rounding error per batch falls to about 0.1 ms in Firefox and Safari ❌ Changes RW2: averaging 10 frames hides the single slow frames that p95, p99 and the churn hitch check exist to catch
C) Record resolution only
Add the timer step to each result and note the rounding in the ADR; the rule and timers stay as they are. Effort S (zero extra work beyond one field), risk high. ✅ Smallest change; the rounding is at least visible in the ADR ✅ Keeps the current server choice and plain timers ❌ In Firefox and Safari the 1 ms threshold equals one timer tick, so rounding can still decide the pick

State: approved
Actual answer: A, "Isolate the measuring page (recommended)", eng D2, 2026-10-13
Accepted scope: COOP `same-origin` and COEP `require-corp` in `preview.headers` (`vite.config.ts`); measuring runs on `vp build` + `vp preview --host 127.0.0.1` only; each result records `crossOriginIsolated` and the measured timer step; a step coarser than 0.1 ms makes the pass `valid:false` (`coarse-timer`), with a unit test. C10 thresholds, C14 protocol and RW2 per-frame statistics unchanged. Applied to chunk 03 Tasks.
History: none

### E7: Guard against three and postprocessing drifting apart
Finding: E7, P2, confidence 8/10, `.github/dependabot.yml:17-35` (npm group, weekly, React-only ignore rules) with `postprocessing` 6.39.5 peer `three: ">=0.168.0 <0.187.0"` and `@react-three/postprocessing` 3.2.0 peer `postprocessing: "^6.36.0"`, reviewer Claude (in-host)
Plan baseline: chunk 03 adds three 0.186.1, `postprocessing` 6.39.5 and `@react-three/postprocessing` 3.2.0 (Phase 1 0I); X2 (Q4) Dependabot weekly grouped updates; eng S3 React ignore rule; no rule for three or postprocessing.
Runtime evidence: `npm view` peer ranges above [measured 2026-10-13]; `pnpm-workspace.yaml` sets no strict peer checking, so pnpm only warns on a peer mismatch; the spike smoke is skipped in CI (C13). Whether today's tree already has unmet peers is unknown (not probed).
Comparison grid:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Dependabot weekly grouped npm updates, React ignore rules | X2 (Q4), eng S3 approved | unchanged | unchanged | unchanged | unchanged |
| Spike smoke skipped in CI | C13 (PQ5) approved | unchanged | unchanged | unchanged | unchanged |
| Dependabot ignore `three` and `@types/three` `>=0.187.0`, `postprocessing` `>=7.0.0`, with a comment naming the peer ranges | pending | no | yes | no | no |
| `strictPeerDependencies: true` in `pnpm-workspace.yaml` (any unmet peer fails install) | pending | no | no | yes | no |
| What catches a three bump past `postprocessing`'s range | - | `vp run e2e:local` before a tick | Dependabot never proposes it | CI install fails on the Dependabot PR | `vp run e2e:local` before a tick |
| Effort | - | - | S | S | S |

Question D3:
D3 — E7: How should the repo stop a three upgrade from silently breaking bloom?
Project/branch/task: Synapse Horizon, branch phase-1-rendering-spike, chunk 03 dependencies.
ELI10: The bloom library (`postprocessing` 6.39.5) says it works only with three versions below 0.187, and chunk 03 installs three 0.186.1. When three 0.187 comes out, Dependabot will propose it in its weekly bundle. The package manager only prints a warning about the mismatch, and the spike's browser test does not run in CI, so the update could merge green while bloom quietly breaks. The repo already holds React back the same way for R3F.
Stakes if we pick wrong: a green Dependabot merge ships a three version the bloom code does not support, found only at the next local run or by a user.
Recommendation: A because it copies the React rule that already works here, cannot disturb today's install, and is lifted with one line when postprocessing widens its range (explicit over clever).
Completeness: A=8/10, B=10/10, C=3/10
Net: a narrow hold on the two known pairs (A), a repo-wide strict check whose effect on today's tree is unprobed (B), or reliance on the local run (C).
Header: Peer guard
Options:
A) Hold three and postprocessing (recommended)
Add Dependabot ignore rules for `three` and `@types/three` at `>=0.187.0` and `postprocessing` at `>=7.0.0`, with a comment naming the peer ranges and when to lift them. Effort S (human ~15 min / CC ~2 min), risk low. ✅ Same pattern as the React rule already in `.github/dependabot.yml`, so nothing new to learn ✅ Cannot break today's install, since it only stops future update proposals ❌ Covers only these two pairs; another peer mismatch elsewhere would still only warn
B) Strict peer checks in pnpm
Set `strictPeerDependencies: true` in `pnpm-workspace.yaml` so any unmet peer fails `pnpm install`, in CI and locally. Effort S (human ~30 min / CC ~5 min, plus fixing any mismatch it exposes), risk medium. ✅ Catches every peer mismatch in the tree, including R3F's React range, not just three ✅ Dependabot PRs that break a peer range go red in CI instead of merging ❌ Today's tree is not probed for unmet peers, so the switch may fail installs until those are fixed
C) No guard
Rely on pnpm's warning and the `vp run e2e:local` run before a chunk is ticked. Effort S (zero extra work), risk medium. ✅ No configuration change at all ✅ The local smoke still exercises bloom before any chunk is ticked ❌ A Dependabot merge between chunks can ship a broken three and bloom pairing to `main` and a release

State: approved
Actual answer: A, "Hold three and postprocessing (recommended)", eng D3, 2026-10-13
Accepted scope: Dependabot ignore rules for `three` and `@types/three` `>=0.187.0` and `postprocessing` `>=7.0.0`, with a comment naming the peer ranges and the lift condition; no pnpm strict-peer change. Applied to chunk 03 Tasks.
History: none

### Scope Challenge dispositions

E6 approved (eng D2); E7 approved (eng D3); E8, E9, E10, E11 applied as required proof or work of approved contracts (C10 and RW1, RW6, C10's draw-call claim, section 4 URL contract and C12); E12 applied as a factual clarification; E13 kept as a T1 verification step; E14 outside Phase 1, flagged.

### 1. Architecture review (eng, Phase 1)

```text
 bench.ts: one requestAnimationFrame loop            SpikeView seam, implemented by vanilla/view.ts and r3f/View.tsx
   rAF(t) ─► interval = t - tPrev (wall clock) ─┐      frame(t)        write LED colours, render all passes
           ─► cpu = now() around view.frame(t)  │      addHalls(n)     Promise, resolves when the halls are in the scene
   churn:  await view.addHalls(6) ─► 1 frame ───┤      removeHalls(n)  Promise, resolves when they are unmounted
           await view.removeHalls(6)            │      snapshot()      geometries, textures, programs, draw calls,
   settle: 1 s ─► view.snapshot()               │                      listeners, shared-material dispose events
   result: JSON (RW10) ◄────────────────────────┘
 R3F only: frameloop="never"; frame(t) calls advance(t). React commits for addHalls/removeHalls run in
 scheduler tasks between rAF callbacks, outside frame(t): they lengthen the wall-clock interval, not cpu.
 Served by vp preview --host 127.0.0.1 with COOP + COEP (E6): crossOriginIsolated, 5-20 µs timer steps.
```

- E15 [P1] (confidence 8/10) docs/PLAN.md chunk 03 Tasks: "the longest frame during churn" sits in the CPU-time list, and C10's rule compares "its longest churn frame". React applies `addHalls`/`removeHalls` state changes in scheduler tasks between animation frames, outside the timed `frame(t)` call, so a CPU-time hitch metric cannot see R3F's reconciliation cost, the very overhead section 1 says decides for vanilla. Required for the fair race (C10, PQ1); applied: the churn hitch is the longest wall-clock rAF interval.
- E16 [P2] (confidence 7/10) RW8: "Each churn cycle lets the added halls render one frame before they are removed." A React state update outside a discrete event can commit after more than one frame, so counting one frame from the call is not enough. Required for RW8; applied: `addHalls` resolves when the halls are in the scene, then one frame, then removal.
- CEO A-3 (static vs lazy import of the spike) stays an implementation choice: chunk 04a makes the 3D canvas the home view, so a split would be undone there; owner chunk 03 implementer.
- Production failure per path: a view that throws on init shows its reason and writes `valid:false` (C12); a run served without isolation is refused (`coarse-timer`, E6); a Dependabot three bump past `postprocessing`'s range is held back (E7). Security: no endpoint; COOP/COEP only tightens the preview server. Distribution: no new artifact.

Dispositions: E15 applied (required, C10); E16 applied (required, RW8); A-3 pending implementation choice.

### 2. Code quality review (eng, Phase 1)

- Q-E1 [P3] (confidence 9/10) The CEO Section 4 churn schedule showed the halls mounting in exactly one frame; with E16 that is stale. Fixed in place (mount may span frames).
- Shared code: `src/spike/shared/` has two proposed callers (the two views) and exists to make the race fair; rubric met on proposed callers [assumption: both views import it]. No extraction beyond that.
- The bench state machine has about 7 transitions; implement it as a transition table so each guard is one row and one test (C12).

Dispositions: Q-E1 applied (factual diagram fix). No other issues found.

### 3. Test review (eng, Phase 1)

Framework: Vitest through `vp test` (`vite.config.ts` `test` block) and Playwright (`playwright.config.ts`, build-and-preview web server). Existing tests read: `e2e/smoke.spec.ts` (home page title, heading, version meta, no console errors) and `e2e/repeat.spec.ts` (home view captured twice within 0.5%).

```text
CODE PATHS (planned, src/spike/)                                   USER FLOWS (operator)
[+] shared/params.ts                                               [+] /?view=spike-*&load=N&bench=1
  ├── [★★★ PLANNED] view, load, bench parse; fallback (C12)          ├── [★★★ PLANNED] valid pass -> JSON (C12)
  └── [★★★ PLANNED] shots params accepted; freeze+bench refused (E11) ├── [★★★ PLANNED] hidden tab, resize -> invalid (C12)
[+] shared/stats.ts                                                  └── [★★★ PLANNED] not isolated -> coarse-timer (E6)
  └── [★★★ PLANNED] nearest-rank median, p95, p99; empty -> null    [+] vp run shots -> 03-spike.png
[+] shared/scene.ts                                                  └── [★   PLANNED] size and console checks (shots.ts)
  └── [★★  PLANNED] counts per load and per hall (C13)              [+] Home page unchanged under the new headers
[+] shared/fakeStore.ts                                              ├── [★★  TESTED] smoke.spec.ts:7
  └── [★★  PLANNED] seed determinism, [0,1], listeners (C13, RW9)    └── [★★  TESTED] repeat.spec.ts:6
[+] shared/bench.ts (fake views)
  ├── [★★★ PLANNED] state machine, each interruption (C12)
  ├── [★★★ PLANNED] addHalls awaited, then one frame (E16, RW8)
  ├── [★★★ PLANNED] hitch = longest wall-clock interval (E15)
  ├── [★★★ PLANNED] timer-step check (E6)
  ├── [★★★ PLANNED] shared-material dispose events counted (E9)
  └── [★★★ PLANNED] draw calls with autoReset off (E10)
[+] vanilla/view.ts, r3f/View.tsx
  ├── [★   PLANNED] e2e:local smoke, 3 engines, load 1 and 4 (C13)
  └── [GAP]         both views draw the same scene: nothing compares them -> E17
COVERAGE: 16/17 paths planned or tested | QUALITY: ★★★:12 ★★:4 ★:2 (smoke, not counted) | GAPS: 1
```

Required proofs carried forward without a new question (approved behaviour): E6, E9, E10, E11, E15 and E16 each get a bench or params unit test against fake views. Value card for the group: `protects=each approved bench rule (E6, E9, E10, E15, E16); fails_when=a guard is removed or measures the wrong window; why_new=no spike code exists; seam=none (fake SpikeView); no_claim=real React scheduling and real GPU behaviour (fake views, unit only)`.

Regression rule: the home page is touched by the `App.tsx` view branch and by the new COOP/COEP preview headers (E6). `smoke.spec.ts` and `repeat.spec.ts` already run against that same preview server and assert the home page's behaviour; carried forward as the regression contract, unchanged. No test is made obsolete.

### E17: Check that both views draw the same scene
Finding: E17, P2, confidence 8/10, docs/PLAN.md chunk 03 Tasks ("each rendering the same thing") and CEO RW8; the planned tests check `scene.ts` counts, not what each view renders; reviewer Claude (in-host)
Plan baseline: C13 (PQ5): unit tests for stats, scene and store; local smoke "canvas present, no console errors" at load 1 and 4 in three engines. RW10 puts counts and draw calls in each JSON result.
Runtime evidence: no spike code exists; unknown.
Comparison grid:

| Commitment | Source/approval or pending | Current | A | B |
|---|---|---|---|---|
| C13 unit tests and local smoke (crash check), skipped in CI | C13 (PQ5) approved | unchanged | unchanged | unchanged |
| Counts and draw calls in each JSON result | RW10, E10 approved | unchanged | unchanged | unchanged |
| Automated check that both views report equal instance counts, geometry count and draw calls per frame at load 1 and 4 | pending | none | local smoke reads each view's `snapshot()` (exposed on the spike page as `window.__spikeSnapshot`) and asserts equality | none; the operator compares the JSON files before applying the rule |
| Effort | - | - | S | S |

Question D4:
D4 — E17: Should a test prove both spike views draw the same scene?
Project/branch/task: Synapse Horizon, branch phase-1-rendering-spike, chunk 03 tests.
ELI10: The whole race assumes both versions draw exactly the same thing. Today's planned tests check the shared layout numbers, but nothing checks what each view actually puts on screen. If the R3F view quietly drew fewer LEDs, or the vanilla view skipped a bloom pass, it would look faster and win for the wrong reason.
Stakes if we pick wrong: an unequal scene makes one integration look faster, and the ADR picks it for every later 3D chunk.
Recommendation: A because one assertion in the existing local smoke catches an unequal race on every run, which hand-checking JSON files does not (every behaviour tested).
Completeness: A=9/10, B=6/10
Net: an automatic fairness check in the smoke (A), or a manual comparison of 48 JSON files (B).
Header: Same scene
Options:
A) Assert equal scenes in the smoke (recommended)
Extend the local spike smoke: at load 1 and 4 it reads each view's `snapshot()` through `window.__spikeSnapshot` and asserts equal instance counts, geometry count and draw calls per frame across the two views. Effort S (human ~1h / CC ~5 min), risk low. ✅ Catches a view that drops halls, racks, LEDs or a render pass before any measuring run ✅ Runs in all three engines on the Mac with the existing smoke, no new spec file ❌ Adds a debug hook on the spike page that only the test reads, deleted with the spike in 04a
B) Compare JSON by hand
Keep the smoke as a crash check; before applying the rule, the operator checks that both views' JSON results show equal counts and draw calls. Effort S (zero extra code), risk medium. ✅ No debug hook and no change to the approved smoke ✅ The JSON already carries every number needed for the comparison ❌ 48 files compared by eye; an unequal scene can slip through and decide the pick

State: approved
Actual answer: A, "Assert equal scenes in the smoke (recommended)", eng D4, 2026-10-13
Accepted scope: the local spike smoke reads `window.__spikeSnapshot` for each view at load 1 and 4 and asserts equal instance counts, geometry count and draw calls per frame; the hook exists only on the spike page and goes with it in 04a. C13 scope otherwise unchanged (local only, skipped in CI). Applied to chunk 03 Tests and Acceptance.
History: none

Value card (E17): `protects=both spike views draw the same scene at load 1 and 4; fails_when=one view drops halls, racks, LEDs or a render pass; why_new=planned unit tests check scene.ts counts, not what each view renders; seam=window.__spikeSnapshot (spike page only); no_claim=visual equality and frame timing (counts only, headless engines)`.

Test Plan artifact: written to the gstack project directory (see Required outputs).

Dispositions: E17 approved (eng D4); 0 test gaps remain.

### 4. Performance review (eng, Phase 1)

- P-E1 [P3] (confidence 7/10) RW8: "Spike code allocates nothing per frame." A sampler that pushes into growing JS arrays allocates during the measured window, and its garbage-collection pauses land in p99 for whichever view runs while they happen. Required by RW8; applied as a clarification: the bench's sample storage is typed arrays sized up front (steady plus churn at 120 Hz with headroom [estimated]).
- Scale: per frame at 4x, one colour upload per hall LED mesh (18 halls x 1,024 instances x 12 B, about 221 KB at peak churn [estimated]); `renderer.info` reads only at snapshots, draw-call reads one integer per frame. JSON results: 48 files of frame statistics, no raw samples [estimated under 10 KB each].
- Bundle: a static spike import adds three, R3F and postprocessing to the home bundle until 04a [size unmeasured]; stays CEO A-3, implementation choice.

Dispositions: P-E1 applied (required clarification of RW8). No other issues found.

### Outside voice (eng, Phase 1)

`codex_reviews` is disabled (stored config). Recorded as `outside_status: disabled` (review log, commit `dc8612a`). No external or native challenge ran.

### E18: TODO, reconcile the plan with merged PRs #8 and #9
Finding: E14 (Scope Challenge), P3, confidence 9/10, docs/PLAN.md:372-373 (chunk 01 "`commit-message.prefix: "fix(deps)"`", "Set the Vite dev server host to `127.0.0.1`") against `b17f26e` (#8, `.github/dependabot.yml` prefix `build(deps)`) and `dc8612a` (#9, `vite.config.ts` host `localhost`), reviewer Claude (in-host)
Plan baseline: CEO C8 (Q13): runtime dependency bumps use `fix(deps)` so they cut a patch release; CEO C2 and eng A1: dev server on `127.0.0.1`, the only host the Origin check and C6 Host gate accept; chunk 14's plugin imports that gate into `vp dev`.
Runtime evidence: `main` uses `build(deps)` (no release under D19 and CONTRIBUTING) and serves `vp dev` on `localhost:5173` (`git show b17f26e`, `git show dc8612a`). Whether these reversals were meant to supersede C8 and C2 is unknown.
Comparison grid:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Phase 1 scope | C10-C14, E6, E7, E17 approved | unchanged | unchanged | unchanged | unchanged |
| TODOS.md entry to reconcile C8 and C2 with #8 and #9 before chunk 14 | pending | none | added (P2) | none | none |
| Plan text for chunk 01 and the C8 ledger row | C8, C2 approved | stale vs `main` | unchanged until the TODO is worked | unchanged, stays stale | rewritten now to match `main`, C8 and C2 marked superseded |
| Effort | - | - | S | S | S |

Question D5:
D5 — E18: What should happen to plan text that no longer matches PRs #8 and #9?
Project/branch/task: Synapse Horizon, branch phase-1-rendering-spike, outside Phase 1 (chunk 01 text, CEO C8 and C2).
ELI10: Two merged PRs changed decisions the plan still records. #8 switched Dependabot's runtime-library updates from `fix(deps)` to `build(deps)`, so those updates no longer cut a release, which means a security fix in a library like `ws` would not reach the downloadable builds. #9 moved the dev server from `127.0.0.1` to `localhost`, while chunk 14 plans to reuse a Host check that accepts only `127.0.0.1`. Either the plan or the code needs to change, and that is a policy call.
Stakes if we pick wrong: chunk 14 builds on a Host rule the dev server no longer meets, or library fixes stop reaching binaries without anyone deciding that.
Recommendation: A because whether library fixes should cut releases is a policy decision that deserves its own look before chunk 14, not a silent text edit inside the Phase 1 review.
Note: options differ in kind, not coverage — no completeness score.
Net: park it as a tracked P2 with a deadline (A), leave the plan stale (B), or accept the merged PRs as the decision now (C).
Header: PR 8 and 9
Options:
A) Add to TODOS.md (recommended)
Add a P2 TODO: decide whether #8 and #9 supersede CEO C8 and C2, then update chunk 01, the C8 row and chunk 14's Host-gate text to match, before chunk 14 starts. Effort S (human ~1h / CC ~10 min when worked), risk low. ✅ The release-policy question gets an explicit answer instead of drifting ✅ Deadline tied to chunk 14, the first chunk the Host rule affects ❌ The plan stays out of step with `main` until someone works the TODO
B) Skip
Leave the plan text as it is and record nothing. Effort S (zero work), risk medium. ✅ No new backlog item for a single-contributor repo ✅ The code on `main` already reflects the current choice ❌ Chunk 14 will be planned against a `127.0.0.1` rule the dev server no longer uses
C) Fix it in this PR
Treat the merged PRs as the decision: rewrite chunk 01 and chunk 14 text to `build(deps)` and `localhost`, and mark C8 and C2 superseded in the ledger. Effort S (human ~1h / CC ~10 min), risk medium. ✅ The plan matches `main` as soon as this branch merges ✅ No backlog item to remember ❌ Decides that library fixes no longer cut releases without weighing it, inside a review about the rendering spike

State: approved
Actual answer: A, "Add to TODOS.md (recommended)", eng D5, 2026-10-13
Accepted scope: P2 entry in `TODOS.md` (reconcile #8 and #9 with C8 and C2 before chunk 14); no plan text or code change in this review.
History: none

Approval readiness: PASS. Checked: E6 (eng D2), E7 (eng D3), E17 (eng D4), E18 (eng D5); structure (eng D1) is a scope selector, not a remedy approval. Required work applied without a new choice, each citing its approved contract: E8 (C10 PQ1, RW1), E9 (RW6), E10 (C10's draw-call claim), E11 (section 4 URL contract, C12 PQ4), E12 (factual), E15 (C10 PQ1 fair race), E16 (RW8), P-E1 (RW8), Q-E1 (factual diagram fix). No unanswered remedy is in the plan.

### NOT in scope (eng, Phase 1)

- Strict peer checks in pnpm: declined (E7, eng D3), because today's tree was not probed for unmet peers.
- 10-frame batch timing: declined (E6, eng D2); it would have hidden single slow frames.
- Comparing the two views by hand from JSON: declined (E17, eng D4).
- Rewriting chunk 01 and the C8/C2 rows to match #8 and #9 now: deferred to `TODOS.md` (E18, eng D5); it needs a release-policy decision first.
- GPU time in Safari and Firefox: no engine probed exposes `EXT_disjoint_timer_query_webgl2`; recorded as null, not pursued.
- Lazy import of the spike (CEO A-3): implementation choice, not a review remedy.

### What already exists (eng, Phase 1)

- Playwright's build-and-preview web server (`playwright.config.ts:44-49`): reused for the local smoke; its `vp preview --host 127.0.0.1` command is also the measuring server.
- Vite `preview.headers` (`CommonServerOptions.headers`, `node_modules/vite/dist/vite/node/index.d.ts:878`, extended by `PreviewOptions` at `:2019`): reused for cross-origin isolation (E6); no custom server.
- Shots URL contract (`scripts/shots.config.ts:13`) and Dependabot ignore pattern (`.github/dependabot.yml:27-35`): reused (E11, E7).
- pmndrs `postprocessing` composer in both views: reused, with its options pinned (E8). Nothing is rebuilt.

### Failure modes (eng, Phase 1)

```text
  NEW PATH                  | REALISTIC FAILURE                               | TEST                 | HANDLING                    | USER SEES
  --------------------------|-------------------------------------------------|----------------------|-----------------------------|----------------------------
  measuring server (E6)     | run served by vp run serve or vp dev            | unit (timer step)    | valid:false, coarse-timer   | "Pass invalid: coarse-timer"
  bloom composer (E8)       | a view falls back to library defaults           | E17 smoke draw calls | one pinned options constant | smoke fails before runs
  R3F churn (E16)           | React commits the added halls a frame later     | unit (fake view)     | await addHalls              | none needed
  churn hitch (E15)         | React work lands outside the timed frame        | unit (fake view)     | wall-clock interval metric  | ADR churn row
  shared materials (E9)     | unmount disposes a shared material              | unit + measured      | dispose events counted      | ADR row fails
  draw calls (E10)          | autoReset hides composer passes                 | unit (fake info)     | autoReset off, reset/frame  | ADR shows equal counts
  three upgrade (E7)        | Dependabot proposes three 0.187                 | none (config)        | ignore rule                 | no PR proposed
  preview headers (E6)      | a future cross-origin asset is blocked by COEP  | smoke, repeat specs  | same-origin assets only     | home smoke fails
  shots capture (E11)       | spike view warns on contract params or animates | params unit test     | params accepted, freeze     | shots fails on console error
```
Critical gaps: 0 (no row lacks both a test and handling while failing silently).

### Worktree parallelization strategy (eng, Phase 1)

| Step | Modules touched | Depends on |
|------|----------------|------------|
| ADR settings, method and rule (CEO T4) | `docs/adr/` | — |
| Shared core and both views (CEO T1, eng T3) | `src/spike/`, `src/app/`, `vite.config.ts`, `.github/`, package files | — |
| Bench, params and tests (CEO T2, T3; eng T1, T4-T6) | `src/spike/shared/`, `e2e/` | shared core and views |
| Measuring runs and results (CEO T5) | `docs/adr/` | ADR rule commit, bench |
| README, shots, image (CEO T6) | `README.md`, `scripts/`, `docs/img/` | views |

Lane A: shared core → views → bench and tests (`src/spike/` shared, sequential). Lane B: ADR rule (`docs/adr/`, independent). Execution order: launch A and B; commit B's rule before any measured run; after A, run the passes, then README and shots. Conflict flags: `docs/adr/0001-render-integration.md` is written by lane B and later by the results step, so those stay sequential.

### Implementation Tasks (eng review, Phase 1)

Synthesized from this review's findings; they extend the CEO Phase 1 tasks T1-T6 rather than replace them. Effort ratios assumed: features ~30x, tests ~50x, config ~30x.

- [ ] **T1 (P1, human: ~1h / CC: ~5min)** — tooling, bench — Cross-origin isolated measuring server and timer-step check
  - Surfaced by: Scope Challenge — E6 (eng D2)
  - Files: vite.config.ts, src/spike/shared/bench.ts, src/spike/shared/bench.test.ts, docs/adr/0001-render-integration.md
  - Verify: `vp test`; on `vp build` then `vp preview --host 127.0.0.1`, `crossOriginIsolated === true`; `smoke.spec.ts` and `repeat.spec.ts` still green
- [ ] **T2 (P2, human: ~15min / CC: ~2min)** — deps — Dependabot ignore rules for three, @types/three and postprocessing with peer-range comment
  - Surfaced by: Scope Challenge — E7 (eng D3)
  - Files: .github/dependabot.yml
  - Verify: Dependabot config check shows no error; the three rules are present
- [ ] **T3 (P1, human: ~1h / CC: ~5min)** — spike render — Pin composer options in the shared constant and pass them in both views
  - Surfaced by: Scope Challenge — E8
  - Files: src/spike/shared/render.ts, src/spike/vanilla/view.ts, src/spike/r3f/View.tsx
  - Verify: both views' snapshots report the same multisampling and frame buffer type; E17 smoke passes
- [ ] **T4 (P2, human: ~2h / CC: ~10min)** — spike bench — SpikeView seam, wall-clock churn hitch, awaited addHalls, dispose-event count, draw calls with autoReset off, preallocated samples, fake-view unit tests
  - Surfaced by: Scope Challenge — E9, E10; Architecture — E15, E16; Performance — P-E1
  - Files: src/spike/shared/bench.ts, src/spike/shared/bench.test.ts, src/spike/vanilla/view.ts, src/spike/r3f/View.tsx
  - Verify: `vp test` covers each rule against a fake SpikeView
- [ ] **T5 (P2, human: ~30min / CC: ~5min)** — spike params — Accept shots contract params, seed the store, freeze one frame, refuse bench with freeze
  - Surfaced by: Scope Challenge — E11
  - Files: src/spike/shared/params.ts, src/spike/shared/params.test.ts, src/spike/shared/fakeStore.ts
  - Verify: `vp test`; `vp run shots` captures the spike view with no console warning
- [ ] **T6 (P2, human: ~1h / CC: ~5min)** — e2e — Equal-scene assertion across views in the local spike smoke
  - Surfaced by: Test review — E17 (eng D4)
  - Files: e2e/spike.spec.ts, src/spike/vanilla/view.ts, src/spike/r3f/View.tsx
  - Verify: `vp run e2e:local` green in three engines; CI log shows the spec skipped
- [ ] **T7 (P3, human: ~5min / CC: ~1min)** — verify — Run `vp check` immediately after adding R3F to prove its JSX types under TypeScript 7
  - Surfaced by: Scope Challenge — E13
  - Files: package.json, pnpm-lock.yaml
  - Verify: `vp check` green with one R3F element in a spike file

_No new tasks from Code Quality review beyond the diagram fix already applied (Q-E1)._

### Reality rows (eng, Phase 1)

- REALITY: premise-table finding unverified=3 (real Safari and Firefox timer policy under isolation, probe used Playwright builds; GPU timer extension in real Chrome; R3F JSX types under TypeScript 7) docs/PLAN.md:433
- REALITY: already-done pass `git log origin/main --since=2026-10-12` on the named paths shows Phase 0 commits plus #8 and #9; no spike code docs/PLAN.md:430
- REALITY: surface-check pass `vp preview --host 127.0.0.1 --port --strictPort` in use (`playwright.config.ts:45`); Vite `preview.headers` exists (`node_modules/vite/dist/vite/node/index.d.ts:878`); R3F `advance` and `frameloop="never"` from R3F docs via Context7 docs/PLAN.md:433
- REALITY: binding-decisions finding CEO C10-C14 honoured; #8 and #9 reverse CEO C8 and C2 in code, logged as TODO E18 docs/PLAN.md:372
- REALITY: numbers finding timer steps [measured: Playwright probe]; composer defaults [measured: tarball `build/index.js:948-949` and Context7]; peer ranges [measured: `npm view`]; thresholds, sample sizes and effort [estimated] docs/PLAN.md:433
- REALITY: deferred-asks pass nothing requested for Phase 1 is left out; E18 deferred with a trigger docs/PLAN.md:434
- REALITY: pr-count pass one PR for chunk 03 plus this branch's review-docs PR docs/PLAN.md:31

### Unresolved decisions (eng, Phase 1)

None. Open verifications (not decisions): timer resolution in real Safari and Firefox under isolation (checked by E6's `coarse-timer` guard at run time); E13 TypeScript 7 check; CEO A-3 bundle split.

### Completion summary (eng, Phase 1)

- Step 0: Scope Challenge — scope accepted as-is (original arrangement, eng D1)
- Reality rows: 7/7 applicable rows emitted (`PLAN_REALITY` complete), 3 unverified premises
- Architecture Review: 2 issues found (E15, E16)
- Code Quality Review: 1 issue found (Q-E1)
- Test Review: diagram produced, 1 gap identified (E17, closed by eng D4)
- Performance Review: 1 issue found (P-E1)
- Scope Challenge findings, reported separately: 9 (E6-E14); E6 and E7 decided, E8-E12 applied, E13 verification, E14 to TODO
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 1 item proposed to user (E18, added)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, disabled (config)
- Parallelization: 2 lanes, 1 parallel / 3 sequential steps
- Lake Score: 1/3 (eng D2 picked its 10/10 option; D3 picked the 8/10 option over a 10/10; D4's best option scored 9/10)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 2 | CLEAR | mode: HOLD_SCOPE, 0 critical gaps (Phase 1, chunk 03, 2026-10-13) |
| Outside Review | codex via `/plan-ceo-review`, `/plan-eng-review` | Independent 2nd opinion | 4 | disabled | `codex_reviews` disabled; no completed external review |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 4 | ISSUES OPEN | 5 issues, 0 critical gaps (this run: Phase 1, chunk 03; all mapped to tasks T1-T7, 0 unresolved; not yet in the review log when this report was saved) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | ISSUES OPEN | score: 2/10 → 7/10, 22 decisions (on main, 2026-10-12) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex, plan-review phase: disabled by config for the Phase 1 CEO and eng reviews (logged skipped/disabled at commit `dc8612a`), as for Phase 0. No external or native challenge ran.
- **VERDICT:** CEO CLEARED for Phase 1. Eng Review ISSUES OPEN means 5 findings mapped to tasks T1-T7 with 0 unresolved decisions and 0 critical gaps; eng review required status per dashboard rules.

NO UNRESOLVED DECISIONS


