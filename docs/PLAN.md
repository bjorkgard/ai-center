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

**Decision (gates chunk 04 onward):** React Three Fiber, chosen by the chunk 03 spike under the pre-written rule; results and rule in [docs/adr/0001-render-integration.md](docs/adr/0001-render-integration.md).

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

- Images live in `docs/img/NN-<slug>.png` (NN = chunk number), 1280x720 PNG, compressed under 200 KB: `scripts/shots.ts` quantizes each capture with `sharp(...).png({ palette: true, quality: 100, effort: 10, dither: 0 })`, with no dithering so flat 3D faces stay flat and quality 100 so bloom gradients do not band (`sharp` is a dev dependency, never in the SEA bundle; eng E2).
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

Visual reference: approved mockup `/Users/nathanael/.gstack/projects/bjorkgard-ai-center/designs/main-dashboard-20261012/variant-B-2.png` (compressed copy in the repo at `docs/designs/variant-B-2.png` from chunk 04c, CEO C17) for both layout and look (design D5, D14, D28). Where the image differs from this text, the text wins: no glyphs on cooling towers, and provenance marks sit top-right of the number (D19). Every decision below cites its design-review question.

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
- Slot sizes (Phase 2 design review DR10, from mockup variant-B-2 [estimated]): KPI tiles 168x120 px with a 12 px gap; job tracker 536x112 px, 16 px above the tab strip; the same sizes at 1280x720 and 1920x1080, where the 3D area takes the extra space.
- The store keeps a `safeArea` rect (canvas minus visible panels). Area presets and `cameraRig.glideTo` frame targets inside it, so a selected object is never behind a panel (chunks 05, 25).

### Visual hierarchy (design D6)

1. First: the attention chip in the top bar, left of the clock: "<n> waiting · <m> error" plus a muted "+k" for other alerts. It is the only alert entry point; the bell is removed (design D26). It shows a quiet "All clear" at zero, turns amber when anything waits and red when any error. Click opens one alert panel with tabs "Needs you" (waiting/error queue, flies to the oldest item) and "All alerts" (acknowledge).
2. Second: the 3D campus. In the scene, `waiting_user` racks show a slow amber-white beacon above the rack; it is the strongest scene signal, above load pulses and packets.
3. Third: KPI tiles, then the job tracker, then the tab strip.

### Semantic zoom (design D7)

- Zoomed out (below the threshold): each hall shows a billboard label with project name, session count and a worst-status dot. Per-rack labels are hidden.
- Zoomed in: billboards fade out (200 ms) and rack detail and LEDs show. (Phase 3 design review D8, WD3: a hall's billboard also shows while zoomed in whenever its wall sign panel faces away or measures under 12 CSS px, so each hall always has exactly one label.)
- Label text is never smaller than 12 CSS px on screen.

### Data mode and replay (design D8)

- Mode chip right of the clock: `LIVE` (cyan dot), `REPLAY 10x` (amber), `MOCK <scenario>` (grey). Click opens the source menu (live / replay file / mock scenario).
- In replay a 40 px bar appears above the tab strip: play/pause, 1x/10x/60x, a scrubber showing sim time.
- Unassigned board: a small glass list at the campus edge, shown only when it has items.
- "+N" badge: 12 px neutral-grey pill on top of the project's last rack.

### Empty and first-run states (design D9)

- Dormant hall: LEDs off, desaturated materials, grey floor sign reading "No sessions". (Phase 3 design review: the sign is a panel on the front wall, UI-5; dormant halls are desaturated through colour attributes, CEO W-RW6.)
- KPI tiles at zero show "0" and a flat sparkline, never a dash.
- No log files found: a centred glass card reads "Watching ~/.claude/projects and ~/.codex/sessions. No sessions in the last 24 h." with two buttons, "Drop a .jsonl to replay" and "Try the demo" (starts mock `steady`).

### Loading and catch-up (design D10)

- Scene loader: centred wordmark with a thin cyan progress line until the first frame renders.
- The server sends backfill progress `{done, total}` in files; the connection pill reads "Catching up 120/480 files".
- KPI tiles, job tracker and table show shimmer skeletons until backfill completes, then show the real values. They never count up from 0 during catch-up.

### Failure states (design D11)

- WebGL unavailable: a glass card reads "Your browser could not start 3D (WebGL)." with a link to browser help. Panels and the table still render from the store. (Phase 2 design review DR3: the card uses the same layout as the scene-error card, about 420 px wide, centred in the `safeArea` rather than full-viewport, with the body "Turn on hardware acceleration, then reload.", an outlined Reload button and a "How to turn on hardware acceleration" link to the detected browser's help page; Safari and unknown browsers get "Update your browser and system, then reload." instead (DR16).)
- WebGL context lost: restore automatically and show a toast, "Restoring 3D view".
- Log server down (at load or later): a persistent amber banner under the top bar reads "Log server not running. Start it with `vp dev`". It hides itself on reconnect.

### Toasts and search (design D12)

- Toasts sit bottom-right above the tab strip, at most 3 visible, newest on top.
  - Anatomy (Phase 2 design review DR9): a `GlassPanel` 320 px wide, 12 px vertical and 16 px horizontal padding, 10 px radius, 14 px Geist Sans body in `--color-text`, a 16 px leading icon (spinner while restoring, the status shape otherwise), 8 px between stacked toasts, enter and exit over `--dur-ui` with the D20 easing (fade only under reduced motion) [values estimated].
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

The approved mockup sets the look, not only the layout. The look is a low-poly isometric campus in realistic dark slate/concrete materials, warm window and LED points, and glowing cyan `#22D3EE` fibre lines with bloom. Everything is still built in code, with no external models. This replaces the brief's "toy-like clay" wording. Chunks 04c and 08 compare a frozen screenshot against variant-B-2 (04c after CEO C22).

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
  - removes the lightning flash;
  - holds rack LEDs at a steady 0.8 of their level and turns cooling fans at 25% speed (Phase 3 design review D12, WD7).
- Chunk 04 adds the tokens and the flag. Every animated chunk checks both modes in its acceptance.

### Glass panel (design D18)

- `GlassPanel` is the one panel surface: backdrop blur, a constant 8% white tint, a 1 px border at 12% white, 10 px radius (D16).
- Under the tint sits a dark underlay in `--color-bg` whose alpha comes from the D21 lookup (CEO C21).
- Blur: `backdrop-filter: blur(16px) saturate(140%)` [estimated] (Phase 2 design review DR7).
- When the frame monitor reports slow frames (under 45 fps at the 60 fps cap), the panel falls back to a solid 85% dark fill and returns when frames recover. The fallback replaces only the dark layer with `rgb(7 10 18 / 0.85)`, keeps the 8% tint and the 12% border, and crossfades over `--dur-ui` (instant under reduced motion) (DR7).
- Chunk 04b builds it; every later panel uses it.

### Contrast and browser surfaces (design D21)

- Panel text is at least 4.5:1; large numerals (28 px and up) are at least 3:1. Both are measured against the rendered pixels behind the panel.
- Glass fill steps from 8% up to 72% dark when the scene is bright. The level comes from a lookup on the known day/night phase and weather (night 8%, dusk 30%, day 60%, day + heatwave 72%), with no GPU pixel readback (eng re-review D2). Read as two layers (CEO C21): every panel keeps design D18's 8% white tint, and a dark underlay in `--color-bg` takes the level from the lookup: night 0% (the night 8% is the white tint), dusk 30%, day 60%, day + heatwave 72%.
- A Playwright check in forced-day and forced-night samples text against its backdrop on KPI tiles, panels and the table.
- Browser surfaces are themed from the palette: 2 px cyan focus ring with 2 px offset, `::selection` cyan at 30%, thin dark scrollbars, cyan caret.

### Keyboard and screen-reader access (design D22)

- Tab order: top bar, 3D view (the focusable canvas, chunk 05), KPI tiles, right panel, job tracker, tab strip and table (3D view placed after the top bar by the Phase 2 design review DR12).
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

#### [x] 03. R3F vs direct Three.js spike
- **Goal:** Pick the integration with numbers, not opinion.
- **Depends on:** 02.
- **Tasks:** Two throwaway views, `?view=spike-r3f` and `?view=spike-vanilla` (the shots URL contract; the app has no router, CEO RW4), each rendering the same thing: 12 hall boxes, 192 instanced racks (12 halls x 16, D8) and 3,072 instanced LEDs (16 per rack) with per-frame colour updates driven by a fake store at 10 updates/s, MeshStandardMaterial flat-shaded, one shadow-casting light, bloom on/off toggle (CEO RW5). Both views use identical renderer settings: pixel ratio `min(devicePixelRatio, 2)`, antialias on, ACES Filmic tone mapping, sRGB output, `PCFShadowMap` at 2048 (three 0.186 removed `PCFSoftShadowMap`), and the same bloom library, pmndrs `postprocessing` (R3F through `@react-three/postprocessing`); the ADR lists them (CEO RW1). Composer options are pinned in that shared constant and passed explicitly in both views, because the two entry points default differently (`@react-three/postprocessing` 3.2.0 uses multisampling 4 and `HalfFloatType`; `postprocessing` uses multisampling 0 and `UnsignedByteType`): `multisampling: 4`, `frameBufferType: HalfFloatType`, and the bloom effect's intensity, luminance threshold and mipmap blur [values estimated; identical values in both views are the requirement] (eng E8). A churn button adds and removes 6 halls 50 times. Record per browser: CPU frame time (update + render, `performance.now()`) median, p95 and p99; the longest frame during churn, measured as the longest wall-clock interval between `requestAnimationFrame` callbacks, so React work that runs between frames counts (eng E15); GPU time where `EXT_disjoint_timer_query_webgl2` exists; fps for reference only, because on a ProMotion display Chrome and Firefox run `requestAnimationFrame` at up to 120 Hz while Safari stays near 60 by default (CEO RW2). Record `renderer.info.memory.geometries/textures` and `renderer.info.programs.length` before churn and after disposal settles (1 s after the last removal; R3F disposes unmounted objects on idle) (CEO RW3), and JS heap where available (Chromium). Measure in Chrome, Safari and Firefox on the dev Mac (M1 Max); the ADR names the machine, treats the CPU-time pick as valid (same CPU core design as the M1 Air), and labels the 1x 60 fps check "M1 Max, overstates M1 Air GPU" (CEO C11). Measuring runs use `vp build` then `vp preview --host 127.0.0.1`, never `vp run serve`: `preview.headers` in `vite.config.ts` sends COOP `same-origin` and COEP `require-corp`, so the page is cross-origin isolated and `performance.now()` steps 0.005-0.02 ms instead of 0.1-1 ms; each result records `crossOriginIsolated` and the measured timer step, and a pass whose step is coarser than 0.1 ms is `valid:false` with reason `coarse-timer`, covered by a unit test (eng E6). Each view takes `&load=1` or `&load=4` (4x instance counts: 768 racks and 12,288 LEDs at the same draw-call count) and `&bench=1`, which runs one scripted pass (warm-up, steady, churn, settle) and prints a single JSON result; the ADR's results table is built from those JSON files (CEO C10).
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

#### [x] 04a. Scene core: canvas, render loop, store, camera, failure handling
- **Goal:** One persistent 3D canvas with its render loop, store, parameters and failure handling, shown on a test cube (split from 04, eng re-review D1; split again into 04a and 04c, CEO C22).
- **Depends on:** 03 (decision).
- **Tasks:** Full-viewport canvas behind a DOM overlay layer, showing a test cube on a plain ground plane with a temporary neutral material and one light (04c brings the final rig and materials). Orthographic isometric camera (true iso angles), perspective toggle that keeps framing: a perf HUD button under `dev=1` triggers it here and the `P` camera key in chunk 05; on a toggle the controls rebind to the new camera and any glide in flight is cancelled with the current framing kept (CEO S-RW39), and in perspective the camera distance is clamped to the range that matches the ortho zoom range; 04a defines both ranges in `src/scene/camera.ts` and chunk 05's controls clamp to them (CEO S-RW26). Dev perf HUD (fps, draw calls, triangles, `renderer.info`), placed at the top-right of the `safeArea` with an 8 px inset, Geist Mono 12 px with tabular numerals, a solid fill with no blur, and not counted in the `safeArea` (design-review DR11). Quality tier (high/medium/low) controlling shadows, bloom, pixel ratio: the tier lives in the store `ui` slice and `qualitySettings(tier)` is a table in `src/scene/render.ts` (eng D1). Motion tokens and a `reducedMotion` store flag from `prefers-reduced-motion` (section 4b, design D20). WebGL-unavailable card, plain in 04a with the D11 text (04b gives it the glass look, CEO C15), laid out like the scene-error card and centred in the `safeArea` with the body "Turn on hardware acceleration, then reload.", an outlined Reload button and a "How to turn on hardware acceleration" link to the detected browser's help page (design-review DR3); Safari has no hardware-acceleration setting [unverified], so Safari and unknown browsers get "Update your browser and system, then reload." with a link to that browser's WebGL help, the browser picked from its user-agent name with a unit test per branch (design-review DR16), and context-lost auto-restore that sets the store `webgl` state to `restoring`, then `ok` (section 4b, design D11); the "Restoring 3D view" toast comes with 04b's toast host (CEO C15).
- **Acceptance:** Test cube and ground render in all three browsers. Toggle switches ortho/perspective without jump. Perf HUD (`?dev=1`) shows under 10 scene draw calls, with post-processing draw calls shown separately (CEO S-RW4). Forcing WebGL off (`?webgl=0`) shows the plain WebGL card with the D11 text; that spec waits on the card, not on the ready signal (CEO S-RW19). `WEBGL_lose_context` sets the store `webgl` state to `restoring`, then back to `ok` after restore, and the scene renders again (design D11; the toast is checked in 04b, CEO C15). Losing the context with no restore shows the WebGL card after 10 s (CEO S-RW10). A scene component that throws shows the scene-error card, not the WebGL card (CEO C23); both cards are `role="alert"` regions and do not move focus, and "Copy error details" puts the message, the last 20 `[scene]` lines, the app version and the user agent on the clipboard (design-review DR14). `reducedMotion` flag follows the OS setting. The 60 fps cap is proven by fake-clock unit tests at 60, 75, 90, 120 and 144 Hz, since headless Chromium drives rAF at 60 Hz; with `?dev=1`, Chromium renders 31 or fewer frames per second after 5 s without input (CEO C16, S-RW12, S-RW29). Smoke test checks canvas exists and no WebGL errors; `e2e/smoke.spec.ts` drops its heading check, since the canvas replaces the placeholder page. CI's Chromium and Firefox jobs create a WebGL2 context, or the S-RW30 fallback is in place.
- **README:** Image `04a-core.png` (test cube with the perf HUD), captured by a shots entry that adds `dev=1` to the section 4 URL; `scripts/shots.config.ts` gains an optional extra-query field per entry. Under `freeze=1` the HUD shows draw calls, triangles and `renderer.info` counts and reads "frozen" in place of fps (CEO S-RW32).
- **Store (CEO S-RW1):** add `zustand` and create the app store (`src/app/store/index.ts`, one file per slice) with a `ui` slice (`src/app/store/ui.ts`): `reducedMotion`, `quality`, `webgl` (`ok`, `unavailable` or `restoring`), `sceneError` (null or a message, C23) and, from 04b, `safeArea`. Chunk 11 adds its data slices to this same store (D11), so chunk 11 now depends on 04a.
- **App parameters (CEO S-RW2):** generalise the spike's allowlist parser into `src/app/params.ts`, read in production builds, because Playwright and `vp run shots` run `vp build` and `vp preview` (`playwright.config.ts:37`). `dev=1` shows the perf HUD and, from chunk 05, the dev menu; `webgl=0` forces the WebGL card; `calm=0` keeps the 60 fps cap (C16); `view` (including `lookdev` from 04c, C17), `source`, `scenario`, `seed` and `freeze` follow the section 4 contract. An unknown value falls back with one console warning naming the parameter. Unit tests cover each parameter.
- **Promote, then delete the spike (CEO S-RW3):** move `RENDER`, `applyRendererSettings`, the inner composer error boundary pattern (`src/spike/r3f/View.tsx:336-347`), the draw-call counter and the shared-material dispose-event guard, with their tests, from `src/spike/` into `src/scene/` (`guardComposer` served only the vanilla view and is deleted with it; CEO S-RW31); then delete the rest of `src/spike/`, `e2e/spike.spec.ts`, the `App.tsx` branch and the `spike-*` shots entry (RW7), plus the spike-only `__THREE_VERSION__` and `__R3F_VERSION__` defines in `vite.config.ts`; the `preview.headers` comment is reworded to cite chunk 36 timing instead of the spike bench (eng E22). `postprocessing` stays as the peer of `@react-three/postprocessing`. The renderer keeps the ADR 0001 settings unless a later decision changes them (C16 changes `powerPreference`).
- **Draw calls (CEO S-RW4):** the perf HUD shows scene draw calls (the render pass) and post-processing draw calls as two numbers, counted per frame with `autoReset` off (eng E10): `renderer.info.reset()` at frame start, a snapshot of `info.render.calls` right after the scene render pass (a no-op pass placed after it, or the frame total when bloom is off), and post-processing = frame total minus that snapshot (CEO S-RW32). The "under 10" bar applies to scene draw calls; the post-processing number is shown, not capped (bloom adds 17 at the ADR 0001 settings).
- **Frame monitor (CEO S-RW5):** one monitor of `requestAnimationFrame` intervals. It judges the mean delivered interval over a short window [about 0.5 s, estimated] against the cap interval in force, so neither a deliberate cap nor a display whose refresh rate does not divide the cap evenly reads as slow (CEO S-RW29). It ignores the first frames after the tab becomes visible or the window resizes, and switches with hysteresis: drop after 2 s with the mean over 1.33 times the cap interval (22 ms at 60 fps, 44 ms at 30 fps), recover after 10 s with it under 1.08 times the cap interval (18 ms at 60 fps) [thresholds estimated]. With `dev=1`, `window.__sceneDev.simulateFrameInterval(ms | null)` replaces the real intervals with synthetic ones while it is non-null, so Playwright can trigger and clear the fallbacks deterministically in any engine (CEO S-RW11, S-RW27). D10's bloom auto-disable and 04b's glass fallback both read it; chunk 36 extends it to the other quality knobs. Under `freeze=1` the monitor is paused, so specs and shots that judge glass or bloom (contrast, shots, look-dev) use `freeze=1` and cannot be flipped by slow software rendering; only the fallback test drives the monitor, through `simulateFrameInterval` (CEO S-RW34). Fake-clock unit tests cover displays at 60, 75, 90, 120 and 144 Hz.
- **WebGL detection (CEO S-RW6):** the card comes from a WebGL2 pre-check plus an error boundary around the R3F `Canvas`. The pre-check, restore, 10 s timeout and late restore form one state machine in `src/scene/webgl.ts`, with the boundary in `src/scene/SceneBoundary.tsx` (eng D1). The renderer is created through R3F's `gl` factory, which catches a failed `new WebGLRenderer(...)` and rethrows it as `WebGLUnavailableError`, the class the pre-check throws, so the boundary can tell WebGL failures from scene errors by class (R3F rethrows both the same way; eng E24). R3F's `fallback` prop renders only when the browser has no `<canvas>` (`react-three-fiber.esm.js:182`), so it cannot show the card. The `@react-three/postprocessing` `<EffectComposer>` sits in its own error boundary inside the `Canvas`, as in the spike's R3F view; an error there turns bloom off and leaves the scene running, without the WebGL card. On `webglcontextrestored` the composer remounts (key change) under that boundary, so a failed rebuild turns bloom off instead of leaving a black canvas (CEO S-RW31). If no restore event arrives within 10 s [estimated], the store `webgl` state becomes `unavailable` and the card shows with its own wording, since the browser did start 3D: title "The 3D view lost its graphics connection.", body "Reload to restart it.", an outlined Reload button and no hardware-acceleration link (design-review DR4); a restore that arrives later still returns the state to `ok`, hides the card and resumes rendering, since D11 restores automatically (CEO S-RW33). Fake-clock unit tests cover restore, a failed composer rebuild, the timeout and a late restore (CEO S-RW10); a unit test stubs `WebGLRenderer` to throw and asserts the `gl` factory rethrows `WebGLUnavailableError` (eng E24). Scene runtime errors (CEO C23): the driver requests the next frame before running the current one and catches errors from `advance()` and `useFrame` callbacks; each distinct message is logged once with `console.error` and the frame time, the HUD counts them, and rendering continues. After 3 consecutive failing frames [estimated] the driver stops and sets the store `sceneError` (message). A React error in a scene component reaches the outer boundary, which tells the kinds apart: WebGL failures show the D11 card; scene errors show a separate card, "The 3D view stopped after an error.", with the message and a Reload button; panels keep working and the loader ends. Card layout (approved mockup, design-review D2/D3): a red square status icon inline at the left of the title; one Geist Sans body line "The panels still work. Reload to restart the 3D view."; an outlined cyan "Reload" button and a quiet "Copy error details" text button; a divider; then the error message on one Geist Mono line with a chevron that expands the full details. Accessibility (design-review DR14): both the WebGL card and the scene-error card are `role="alert"` regions, read out once when they appear; focus stays where the user is, and the card's buttons take the 3D view's place in the Tab order. "Copy error details" copies the error message, the last 20 `[scene]` console lines, the app version and the browser user agent, then confirms "Copied" (design D13). Tests: a throwing frame callback keeps the loop alive and logs once; 3 consecutive throws set `sceneError`; a throwing component shows the scene-error card, not the WebGL card.
- **First frame and freeze (CEO S-RW7):** the scene sets one ready signal after its first rendered frame (`data-scene-ready` on the app root and `window.__sceneReady`). The 04b loader, every shots entry (including the existing `home` entries), `e2e/repeat.spec.ts` and the smoke test wait on it before capturing (CEO S-RW20). When WebGL is unavailable no frame ever renders, so the loader also ends when the store `webgl` state is `unavailable` (CEO S-RW19). `freeze=1` renders one fixed frame, stops the scene clock, and re-renders that same frame after a resize or a context restore (section 4, CEO S-RW30).
- **Render loop and power (CEO C16):** R3F runs with `frameloop="never"`, driven by one `requestAnimationFrame` driver that calls `advance()` (the pattern ADR 0001 measured), passing scene time in seconds, not the rAF timestamp in milliseconds, so `useFrame` deltas keep R3F's seconds convention (eng E19). The driver owns scene time: it starts at 0 on the first rendered frame and advances by the real interval capped at 0.1 s per frame [estimated], so the first frame and the frame after a hidden tab or a long pause never jump; it stays still under `freeze=1`. Store and replay time are separate (eng E20). The driver caps rendering at 60 fps on every display by deadline accumulation: it renders when the time since the last rendered frame reaches the cap interval minus a few milliseconds of tolerance [estimated] and carries the remainder, so the mean rate holds 60 fps on 60, 75, 90, 120 and 144 Hz displays and rAF jitter never halves it (CEO S-RW29). It enters calm mode after 5 s with no pointer or keyboard input, camera motion or glide, where the cap drops to 30 fps; any input returns to 60 within one frame [values estimated]. The renderer uses `powerPreference: "default"` (a later decision under S-RW3). The app parameter `calm=0` keeps the 60 fps cap for measuring runs (chunk 36). The perf HUD also shows the cap and mode. Fake-clock unit tests cover the cap at 60, 75, 90, 120 and 144 Hz, jittered 60 Hz callbacks, calm entry and exit, and a hidden tab (CEO S-RW12, S-RW29), plus scene time: the first delta is 0, a 60 s hidden gap gives at most 0.1 s, and `freeze=1` gives 0 (eng E20).
- **Cleanup under StrictMode (eng E25):** `src/main.tsx` renders in `<StrictMode>`, which mounts, unmounts and remounts effects in `vp dev`. The driver, the monitor's listeners, the reduced-motion `matchMedia` listener, the ResizeObserver and the WebGL context listeners each return a stop function used as effect cleanup. A unit test mounts, unmounts and remounts the driver and asserts one scheduled callback and baseline listener counts.
- **Transition logs (CEO S-RW40):** each state transition (`webgl`, quality tier, composer failure, `sceneError`) logs one console line with a `[scene]` prefix, the transition, its reason and, for quality changes, the mean frame interval. The README "Known limits" section names the WebGL card and the scene-error card and what to do (check hardware acceleration; reload and report the `[scene]` console line).
- **CI WebGL (CEO S-RW30):** before the new smoke merges, confirm that headless Chromium and Firefox on the ubuntu runners create a WebGL2 context [unverified: chunk 03's spike spec was skipped in CI]. If not, add software-rendering launch options in `playwright.config.ts` (for Chromium, `--use-angle=swiftshader` and `--enable-unsafe-swiftshader` [unverified which recent Chromium needs]; for Firefox, its WebGL force-enable pref). If a browser still has no WebGL2, its CI smoke asserts the WebGL card path instead, `e2e/repeat.spec.ts` is skipped in CI for that browser, and the canvas smoke and repeat check for it run only in `vp run e2e:local` (CEO S-RW35).

#### [x] 04b. UI shell: tokens, glass panel, layout, loader
- **Goal:** The empty dashboard frame every later panel lives in (split from 04, eng re-review D1).
- **Depends on:** 04a.
- **Tasks:** Section 4b tokens wired in (type, spacing, radius, status palette from chunk 01) and themed focus ring, selection, scrollbars and caret, plus adaptive glass fill driven by day/night phase and weather, no GPU readback (section 4b, design D21, eng re-review D2). `GlassPanel` component per section 4b "Glass panel" (design D18): backdrop blur 16 px with 140% saturation (design-review DR7), 8% white tint over the C21 dark underlay, 1px 12% border, fps-aware fallback to a solid 85% dark layer under 45 fps that keeps the tint and border and crossfades over `--dur-ui`. Empty layout shell with the section 4b slots (top bar, KPI row, right panel, job tracker, tab strip) that updates the store `safeArea` on panel open/close (opened and closed through a `dev=1` toggle in the HUD's dev section until real panels exist, design-review DR11) and on window resize via ResizeObserver (eng re-review E6), writing at most once per animation frame and only when the rect changed, so the browser never reports a ResizeObserver loop error (CEO S-RW36); pointer events blocked by panels and passed through gaps (design D18, D5). Each empty slot shows its placeholder title in 13 px label type and `--color-text-2` (for example "Claude sessions", "Job tracker"), so the contrast helper has text to sample (CEO S-RW28, design-review DR8). Slot sizes per section 4b (design-review DR10): KPI tiles 168x120 px with a 12 px gap, job tracker 536x112 px 16 px above the tab strip. Scene loader (wordmark plus thin cyan progress line) until the first frame, or until the store `webgl` state is `unavailable` (design D10, CEO S-RW19). Loader look (design-review DR2, settles UI-3): an indeterminate 2x160 px cyan bar sweeps every 1.2 s, 16 px below a 20 px Geist Sans semibold wordmark; it appears only after 300 ms, so fast starts show nothing; it fades out over `--dur-ui` with the D20 easing; under reduced motion it does not sweep and cuts instantly [values estimated]. Message precedence (design-review DR5): only one card shows at a time; WebGL unavailable (either wording) beats scene error, which beats restoring; the restore toast is hidden while any card shows; a unit test covers each pair. Layering (design-review DR1): the loader covers only the 3D area, and the top bar, slots and tab strip render above it from the first paint; while loading, restoring or unavailable the 3D area shows `--color-bg`; after a scene error the last frame stays under a 60% `--color-bg` overlay [estimated]; cards and toasts sit on top. The 04a WebGL card and scene-error card (C23) are restyled with `GlassPanel`, and a minimal toast host (bottom-right above the tab strip, newest on top; normal toasts auto-dismiss after 6 s, design D12; anatomy per section 4b, design-review DR9) shows "Restoring 3D view" for as long as the store `webgl` state is `restoring` and dismisses it on `ok` (CEO S-RW13), inside an `aria-live="polite"` region so screen readers announce it (design D22, eng E21); when `webgl` returns to `ok` from `restoring`, or a late restore hides the WebGL card, a normal toast "3D view restored" shows for 6 s in the same region (design-review DR6); chunk 32 extends this host with the 3-toast cap, overflow, error toasts and mode tags (CEO C15).
- **Acceptance:** Empty layout shell matches the section 4b diagram at 1280x720 and 1920x1080; the D21 contrast helper passes at the night glass level on the wordmark, the tab-strip labels and each slot's placeholder title, and a `glassFill` unit test covers all inputs (CEO S-RW9, S-RW28); the fallback triggers and recovers in Firefox (design D18), driven by `simulateFrameInterval` (CEO S-RW11). `safeArea` updates on resize and on panel toggle (unit test on the rect). Loader shows until first frame, and with `?webgl=0` it gives way to the card. With `?webgl=0` the WebGL card renders as a glass card; `WEBGL_lose_context` shows the "Restoring 3D view" toast inside an `aria-live="polite"` region, and after restore it clears and "3D view restored" shows for 6 s (CEO C15, eng E21, design-review DR6).
- **README:** Image `04b-shell.png`.
- **Glass tokens (CEO S-RW8):** `--color-glass` becomes 8% white and `--color-glass-border` 12% white, matching section 4b "Glass panel" (design D18); chunk 01 set 6% and 8% (`src/styles/tokens.css`).
- **Quiet text tokens (design-review DR8):** `--color-text-2: #A3ACBD` for secondary text (slot titles, labels, card body lines) and `--color-text-3: #8A93A6` for tertiary text (captions, hints; the D19 derived-badge grey). On night glass (8% white over `--color-bg`, composite `#1B1E25`) they measure 7.3:1 and 5.4:1 [measured: WCAG formula]; the D21 contrast helper checks them at the day levels in chunks 34 and 35.
- **Adaptive glass now, inputs later (CEO S-RW9):** `glassFill(phase, weather)` is a pure lookup that returns the dark underlay alpha beneath design D18's constant 8% white tint (CEO C21): night 0, dusk 0.30, day 0.60, day + heatwave 0.72 (the R13 levels). Only day + heatwave changes the level; every other weather uses the clear level for its phase, so the unit test covers all 3 phases x 4 weathers (CEO S-RW15). Until chunks 34 and 35 put phase and weather in the store, it reads night and clear. The D21 contrast helper (text sampled against the rendered backdrop) is built here and run at the night level; chunk 34 runs it in forced day, dusk and night, chunk 35 in day + heatwave.

#### [x] 04c. Look: lights, materials, look-dev view
- **Goal:** The final look language, tuned against the mockup and guarded by a screenshot (split from 04a, CEO C22).
- **Depends on:** 04a.
- **Tasks:** Lighting rig: hemisphere + one directional with soft shadow plus low night fill, tuned to match the approved mockup (design D14). Material library `scene/materials.ts`: dark concrete/slate building greys, warm window and rack-LED emissives, accent cyan emissive for fibre lines (bloom), vendor colours, shared instances only (no per-mesh materials), built on the shared-material guard promoted in 04a. Ground plane with subtle grid. The 04a test cube and ground switch to the library and rig.
- **Acceptance:** The test cube and ground render with the library under the rig in all three browsers. The look-dev view matches its committed baseline in `vp run e2e:local`, and the PR shows it beside the mockup copy (CEO C17). Shared materials receive 0 `dispose` events when the look-dev view unmounts and remounts (the 04a guard). `playwright test --list` for the chromium, firefox and webkit projects does not list the look-dev spec (eng, S-RW24 check).
- **README:** Images `04c-scene.png` and `04c-lookdev.png` (CEO C17, C22). One line on the art direction.
- **Look-dev view (CEO C17):** `?view=lookdev` draws a fixed vignette under the rig with the ortho camera and bloom on, at the 1280x720 shots viewport with the shell and HUD hidden and one fixed camera preset (design-review DR11): a hall slab and wall with a window strip, one 8-rack row with LEDs in all six D17 status colours, a cyan fibre segment, Claude and Codex trim swatches and the ground grid. `vp run shots` captures it as `docs/img/04c-lookdev.png`. `vp run e2e:local` guards it with a `toHaveScreenshot` baseline (`maxDiffPixelRatio: 0.005`, as in `e2e/repeat.spec.ts`), opened with the section 4 URL (`freeze=1`) after the ready signal, so a deliberate look change updates the baseline in the same PR. The baseline is committed under `e2e/__screenshots__/` through its own Playwright project (Chromium only, its own `snapshotPathTemplate`), because `test-results/` is gitignored (`playwright.config.ts:10`); the chromium, firefox and webkit projects ignore this spec with `testIgnore`, and it is skipped when `CI` is set, since CI renders on ubuntu against a Mac baseline (CEO S-RW17, S-RW24). A compressed copy of the approved mockup goes to `docs/designs/variant-B-2.png`. Chunks 06-10 add their new materials to this view.

#### [x] 05. Camera controls and camera rig
- **Goal:** Map-style navigation and a programmatic glide API.
- **Depends on:** 04b.
- **Tasks:** Left-drag pan, right-drag free rotate, scroll zoom (ortho zoom, not dolly), clamped to campus bounds and zoom range. Controls are three's `MapControls` (`three/examples/jsm/controls/MapControls.js`, installed with three; left-drag pan and right-drag rotate are its defaults, and it has `zoomToCursor` and damping), with a custom clamp of target and zoom to the campus bounds, and the perspective distance clamp from 04a; the C16 driver calls `controls.update()` each frame, and a `change` event or damping that is still settling counts as camera motion, so calm mode waits for the camera to stop (CEO S-RW16). Map feel (CEO C20): scroll zoom aims at the point under the cursor, still clamped; pan and rotate ease to a stop over about 250 ms [estimated], off under `reducedMotion`, and a new drag or glide stops the damping; a double-click on empty ground glides to `cameraRig.home()`. Empty ground means the nearest raycast hit is the ground mesh; chunk 24's double-click on an entity zooms close and cancels any home glide (CEO S-RW25). `cameraRig.glideTo(target, zoom, ms=600)` using the D20 easing (instant cut when `reducedMotion`), interruptible by user input, framing the target inside the store `safeArea` rect (section 4b, design D5). If `safeArea` changes during a glide, the glide retargets so the target ends inside the new rect (CEO S-RW37). A `safeArea` with no width or height (a window below the supported 1280x720) falls back to the full canvas with one console warning (CEO S-RW38). Expose in a dev menu for manual testing: a collapsible section under the perf HUD (glide test, projection toggle, right-panel toggle) (design-review DR11). Keyboard focus on the canvas shows as four small cyan corner brackets framing the visible canvas area (the `safeArea`), on `:focus-visible` only, not the D21 ring around the whole viewport (approved mockup, design-review D2/D3). Keyboard camera controls (CEO C19): the canvas is focusable (`tabIndex=0`, `role="application"`, a static `aria-label` until chunk 24 adds the live summary) and sits right after the top bar in the Tab order (design-review DR12); its `aria-label` is "3D campus view" and `aria-describedby` points to visually hidden text "Arrow keys pan, plus and minus zoom, Q and E rotate, 0 returns home, P switches perspective." (design-review DR15); while it has focus, arrows pan, `+` (or `=`) and `-` zoom, `Q`/`E` rotate 45 degrees, `0` or Home glides to `cameraRig.home()` (the whole campus framed in the `safeArea`; from chunk 08 the placed campus, CEO C25), and `P` toggles ortho and perspective (D9, CEO S-RW26, S-RW30). Keys never fire while typing in inputs, steps use the D20 easing over `--dur-ui` (instant under `reducedMotion`), and a key press counts as input for calm mode (C16). Step sizes (design-review DR13): one arrow press pans 10% of the `safeArea`'s shorter side; one `+`/`=` or `-` press zooms by x1.25; a held key keeps stepping at the key-repeat rate, each step starting from the current animated position, so movement stays smooth and nothing queues [values estimated].
- **Acceptance:** Pan, rotate, zoom work with mouse and trackpad in all three browsers. Camera cannot leave bounds, in ortho and in perspective. Dev-menu glide reaches target in about 600 ms and cancels on drag. Opening the right panel during a glide still ends with the target inside the new `safeArea` (unit test on the rig with a fake clock, CEO S-RW37). Context menu suppressed on right-drag. With the canvas focused, each camera key moves the camera and it stays in bounds, in all three engines; a unit test covers the key map, the focus gate and the DR13 step sizes (one arrow press pans 10% of the shorter `safeArea` side; one `+` zooms by x1.25) (CEO C19, design-review DR13). Zoom-to-cursor keeps the world point under the cursor fixed while inside bounds (unit test), and in an e2e a scroll over a corner moves that corner toward the centre less than a centre zoom would; a double-click on empty ground glides home (e2e) (CEO C20). With reduced motion emulated, glides and key steps are instant cuts and damping is off (e2e), and a fake-clock test shows that damping still settling holds the 60 fps cap (design D20, CEO S-RW21).
- **README:** "Controls" line, including the camera keys.

### Phase 3: World building (static, no data)

File arrangement (eng-review Phase 3 D1): pure, unit-tested modules each get their own file (`hall/buildHall.ts`, `hall/signAtlas.ts`, `hall/slots.ts`, `scene/signals.ts`, `scene/fake.ts`, `sim/rng.ts`, `campus/layout.ts`, `campus/waypoints.ts`, `plant/vapour.ts`, `fibre/route.ts`), and each chunk's 3D view code lives in one file (`hall/Hall.tsx`, `campus/Campus.tsx`, `plant/Plant.tsx`, `network/Network.tsx`), split by part only past about 300 lines; review tasks that name per-part view files map to these. Each Phase 3 chunk adds its new materials to the 04c look-dev view and updates its baseline in the same PR (CEO C17); from chunk 08 a look change also updates the campus baseline (CEO C28). Every draw-call bar in this phase reads the perf HUD's scene number (shadow pass included, post-processing excluded) at the high tier with shadows on (CEO W-RW2, S-RW4). Triangle budgets (eng-review Phase 3 D4, E28) [estimated]: unit tests count each builder's triangles against per-part caps, in the chunk that adds the part: hall body 2,000; rack 12; LED 12; tower 600; chiller 200; fan 64; tree 60; parked car 120; lamp 60; fence bay 24; gate 400; dock 600; monument 100; vapour quad 2; packet 48; fibre tube 12 per 0.25 units of length; and an e2e reads the HUD's triangle count at 12 placed halls, frozen, at 150k or less. Every dev control in this phase lives in a collapsible section of the `dev=1` HUD menu (`src/scene/PerfHud.tsx`) and has a `window.__sceneDev` hook, so Playwright drives it in the production build (CEO W-RW12, S-RW2). Sections, in build order under the HUD and in its Geist Mono 12 px style: Camera (open at first, as in chunk 05), then Hall (06), Racks (07), Campus (08), Cooling (09) and Network (10), all collapsed by default (design-review Phase 3 D20, WD14). Every moving value (rack count, LED load, duty, vapour particle phase, fan angle, packet phase) comes from the pure `src/scene/fake.ts` as a function of scene time and `seed`, frozen under `freeze=1`; dev controls override it, and chunks 18 and 22 replace it with store values (CEO W-RW7). Scene components read these values only through one `SceneSignals` interface (`rackCount(hall)`, `ledLoad(hall, rack)`, `duty()`, `vapourPhase(i)`, `fanAngle(i)`, `packetPhase(line, i)`, evaluated at scene time); `fake.ts` is its first implementation, chunks 18 and 22 add a store-backed one, and no component imports `fake.ts` directly (CEO W-RW28). Every new custom shader is covered by `renderer.debug.onShaderError` (three `WebGLRenderer.js:169-195`), set where the renderer is created: a compile failure logs one `[scene]` line naming the material and counts in the HUD's frame-error row, and rendering continues without that mesh, as for C23 frame errors (CEO W-RW30). Every `__sceneDev` setter clamps out-of-range, non-integer or NaN input to its valid range and logs one `console.warn` naming the argument (CEO W-RW31). Roof toggles and placed-hall changes log one `[scene]` transition line each, as S-RW40 does for other scene state (CEO W-RW36). Fake project names on signs are fixed fictional strings in `fake.ts`, never read from the machine, so committed images carry no real project names (D16; CEO W-RW34). Flat site surfaces that are not entities (roads, parking, empty slots, aprons) carry `userData.ground`, so C20's double-click home works on them; halls, racks, plant and vehicles do not (CEO W-RW35). Per-instance fades (eng-review Phase 3 D3, E27): one helper in `src/scene/materials.ts` adds a per-instance `instanceOpacity` attribute, and for atlas text a per-instance UV rectangle, to library materials through `onBeforeCompile` with a fixed `customProgramCacheKey`, so sign panels, slot-pad numbers and vapour fade one instance at a time while keeping the 04c shared-material rule; a unit test feeds it a stand-in shader and asserts the injected attribute and the opacity multiply; its compile failures go through W-RW30. Emissive ladder (design-review D7, WD2), lowest to highest: sign panel 0.5 (under the 0.6 bloom threshold so its text never smears) < rack LEDs 1.0 < lamps 1.6 < windows 2.0 < fibre 2.6 < packets 3.2 < chunk 18's waiting beacon 4.0 [values estimated; existing values from `src/scene/materials.ts`]; hues stay as in variant-B-2, and the beacon is told apart from the warm windows by brightness, motion and position. A unit test in `materials.test.ts` asserts the order, so no later material outshines the beacon. While bloom is off (medium and low tiers, or bloom auto-disabled under D10), every glow material's emissive is scaled by 1.5 [estimated], keeping the same order, with no new meshes or draw calls; a unit test covers the factor and the order, `__sceneDev.setQuality(tier)` forces a tier, and the chunk 08 PR shows one frozen `home` shot with bloom forced off (design-review Phase 3 D9, WD4). Site palette (design-review Phase 3 D15, WD10) [estimated]: colour in the scene only means something: status (D17), vendor trim (D17), cyan network (D10) and warm windows and lamps (D14). Site furniture uses neutral slate and concrete steps: roads `#1a2130` (a step above the ground `#121926`); kerbs, markings and parking lines `#3a4559`; parked cars in three dark desaturated greys with their lights off; the gate boom dark grey with warm-white `#E8DCC8` stripes; trees `#1d2b2a` with trunks `#2a2420`; fence `#2e3748`; cold-aisle tiles a grey step lighter than the hall floor and hot-aisle tiles a step darker (chunk 22 tints hot aisles later). A unit test keeps every furniture colour's hue and saturation away from the status and vendor colours. Shadow casters in this phase: hall bodies, racks, plant (towers, chillers), power parts (transformers, generators, tanks), trees and parked cars; LEDs, windows, signs, roads, lamps, fibre, packets and vapour do not cast (CEO W-RW23).

#### [x] 06. Parametric data hall
- **Goal:** One hall built in code from parameters.
- **Depends on:** 04c, 05 (CEO C22).
- **Tasks:** `buildHall({ slots: 16, rows: 2 })`: floor slab, walls, cutaway roof (roof hidden or sliced above a height, toggleable), cold-aisle and hot-aisle floor tiles, door, and a sign panel on the front wall's face above the door for the hall letter and project name (canvas texture, shared atlas; approved mockup `hall-identity-20261014/variant-B.png`, design-review Phase 3 D3/D4, UI-5). Low poly, merged geometry for static parts.
- **Acceptance:** One hall renders, roof cutaway toggle works: `applyRendererSettings` sets `localClippingEnabled`, the hall body material holds exactly one clipping plane with `clipShadows`, a toggle changes only that plane's constant (unit tests), and toggling changes the roof region of a frozen `view=hall` capture (e2e) (CEO W-RW14). The sign panel shows only while it faces the camera and its letter measures at least 12 CSS px at the current camera pose, and fades out otherwise; a unit test sweeps elevation over `ELEVATION_RANGE` and azimuth in 45 degree steps in both projections and checks the rule against an expected value it computes from its own two `project` calls, and an e2e shows the sign at the `view=hall` framing and hides it after zooming out (design D7, CEO W-RW5, W-RW17, W-RW24). Static hall costs 4 or fewer scene draw calls: 3 main pass + 1 shadow (CEO C24); a unit test counts the meshes, `castShadow` flags and the hall's share of the instanced panel draw in `buildHall` output, and an e2e at `view=hall&dev=1` with racks at 0 reads the HUD scene count (eng-review Phase 3 Section 3). Two halls tinted with `setHallTint` share material instances (unit test, CEO W-RW6, W-RW21). `mergeHallParts` with mismatched parts throws `HallBuildError` (unit test, CEO W-RW13, W-RW21).
- **README:** Image `06-hall.png` (`view=hall`).
- **Hall construction (CEO C24):** one merged hall body (slab, walls, roof, aisle tiles, door) built with three's `mergeGeometries` (`three/examples/jsm/utils/BufferGeometryUtils.js`) on one new shared library material with vertex colours (the concrete, slate and roof greys become colours); the cutaway roof is a clipping plane on that shared material with `clipShadows`, toggled for all halls at once: cut, the plane sits 0.01 units above the wall top, so the roof slab (built wholly above the wall top) is removed and walls and racks stay; uncut, it sits above the roof top. The roof starts cut in every Phase 3 view (`home`, `hall`, `racks`, `cooling`, `power`, look-dev), since variant-B-2 shows open halls with lit racks (CEO W-RW25); windows use the shared window glow; the sign comes from the shared atlas. The body casts and receives shadows. Clipping needs `renderer.localClippingEnabled = true` (three `WebGLShadowMap.js:442` also checks it for shadows), set in `applyRendererSettings`; the toggle moves the plane above the tallest part instead of adding or removing it, so no shader recompiles; no other library material carries a clipping plane (unit test) (CEO W-RW14, W-RW19). `mergeGeometries` returns null and logs on mismatched attributes, so the exported pure `mergeHallParts(parts)` throws `HallBuildError` instead, `buildHall` calls it, and the C23 scene-error path reports it (CEO W-RW13, W-RW21).
- **Per-hall looks (CEO W-RW6):** each hall's body and aisle tiles carry a per-hall colour attribute range, written by `setHallTint(hall, tint)` and `setAisleTint(hall, tint)`, so chunk 18's dormant desaturation and chunk 22's heat wash write attributes, never materials (chunk 04c: shared instances only; CEO W-RW21).
- **Sign and semantic zoom (CEO W-RW5, W-RW17, W-RW24, W-RW26):** the letter measure is the 2D screen distance in CSS px between the projected bottom-centre and top-centre of a capital letter in the sign's smallest text line (the project name; the hall letter is drawn larger) (`cameraRig.project`), at the current pose: projection, zoom or distance, elevation and azimuth. The sign panel is visible only while its face points toward the camera and that measure is at least 12 CSS px (design D7), re-checked whenever the camera changes, and fades over 200 ms when it crosses; the fade can dip below 12 px for those 200 ms, as D7's own billboard fade does. Separately, `SEMANTIC_ZOOM` in `src/scene/camera.ts` is the ortho zoom at which the measure reaches 12 CSS px at the isometric pose; in perspective the effective zoom is `zoomForDistance` at the camera's target distance (`camera.ts`). Chunk 18's billboards and rack detail switch on `SEMANTIC_ZOOM` (D7), and a billboard also shows whenever its hall's panel is hidden by this rule, so from chunk 18 on every hall has exactly one label at every pose (design-review Phase 3 D8, WD3, amending D7); until chunk 18 a hall whose panel is hidden has no label. The panel stands upright on the wall, so it never reads upside down. All halls' panels are one InstancedMesh on the shared atlas material with the E27 fade helper (per-instance opacity for the 200 ms fade, per-instance atlas region), one draw for every panel; an e2e checks a panel's opacity goes from 1 to 0 within about 200 ms after zooming out (eng-review Phase 3 D3, E27). Panel anatomy (design-review Phase 3 D10, WD5) [sizes estimated]: about 3.2 x 0.8 units on the front wall's face above the door; slate face `#232b3a`; text `--color-text-2` `#A3ACBD`; the hall letter in Geist 600 at a 0.5-unit cap height, a middle dot, then the project name in Geist 500 at 0.28 units (the line the 12 px measure uses); emissive 0.5, under the 0.6 bloom threshold (WD2). A dormant hall (D9) reads "A · No sessions" in `--color-text-3` `#8A93A6`. A 0.08-unit stripe along the panel's bottom edge is neutral slate in Phase 3 and takes D8's overflow sign colour from chunk 19. The atlas is one shared canvas texture; `setSign(slot, letter, project)` redraws only that slot's region, and the texture count stays constant. Before its first draw the atlas awaits `document.fonts.load` for the sign font (Geist is `font-display: swap`, `src/styles/tokens.css:1-6`, so an early `fillText` would draw the fallback and never redraw), with a 3 s timeout [estimated] after which it draws with the fallback and logs one `[scene]` warning; the scene ready signal (`src/app/App.tsx:38`) waits for the atlas, so shots and baselines always capture one font (CEO W-RW29). A null 2D context throws `SignAtlasError` into the C23 scene-error path. A project name wider than its region is truncated with an ellipsis; an empty name draws the letter only; a slot outside 0-11 throws `SignAtlasError` (CEO W-RW33).
- **Dev controls (design-review Phase 3 D20, WD14):** a "Hall" section with the roof cut toggle and `__sceneDev.setRoofCut(on)`.
- **View (CEO W-RW7):** `view=hall` frames one hall with the roof cut away; `src/app/params.ts` and `scripts/shots.config.ts` gain it. The look-dev vignette renders the `buildHall` output in place of its own slab and wall (C17).

#### [x] 07. Instanced racks and LEDs
- **Goal:** Racks and LEDs as instances with per-instance colour and intensity buffers.
- **Depends on:** 06.
- **Tasks:** One InstancedMesh for rack bodies, one for LEDs (a status strip plus 12 blades per rack; design-review Phase 3 D11, WD6), per-instance colour attribute. Slot allocator inside a hall (stable slot per key). Dev slider for rack count 0-16 and a fake load pulse per rack.
- **Acceptance:** The slider adds and removes racks without reallocating: a count change writes only `mesh.count` and instance attributes, and the geometry and attribute objects are the same objects before and after (unit test); `renderer.info.memory.geometries` is unchanged across 0, 16 and 0 racks (e2e through `__sceneDev`; Vitest has no WebGL) (CEO W-RW8, W-RW23). LED pulse checks both reduced-motion modes: under reduced motion LEDs hold a steady 0.8 of their level (design D20; design-review Phase 3 D12, WD7). Draw calls do not grow with rack count. LEDs pulse with the seeded fake load, and two frozen captures of `view=racks` match (CEO W-RW7). Slot allocator unit tests pass (CEO W-RW9).
- **README:** Image `07-racks.png` (`view=racks`).
- **Instances (CEO W-RW8):** each hall owns its rack and LED InstancedMeshes (ADR 0001 RW8), allocated once at capacity: 16 racks and 16 x 13 = 208 LEDs. Each rack has one wide status strip on top in the main session's D17 colour and 12 blade LEDs below, one per active subagent in its own status colour; unlit blades are dark; more than 12 subagents keep all 12 lit, and panels show the exact count (design-review Phase 3 D11, WD6). LEDs carry status by colour only, because shapes cannot show at LED size; the statuses that need action have non-colour cues elsewhere: an error sends chunk 22's technician cart to the rack and counts in the attention chip (D6), and a waiting rack gets chunk 18's beacon; panels and tables show every status with its D17 shape (design-review Phase 3 D19, WD13). LED colours come from the D17 status table (`statusLed`, `STATUS_COLORS`). The look-dev rack row renders through these instances.
- **Slot allocator (CEO W-RW9):** a pure module `src/scene/hall/slots.ts`. Unit tests: a key keeps its slot; a new key takes the lowest free slot; a freed slot is reused only after its key leaves; a 17th key gets no slot and is counted (overflow halls are chunk 19's, D8); the same inputs give the same layout.
- **Fake load and view (CEO W-RW7, W-RW20, W-RW37):** `src/scene/fake.ts`, seeded by a small RNG in `src/sim/rng.ts` that chunk 11's mock generator reuses, gives each hall's rack count and each rack's LED load from scene time and `seed`. The pulse moves an LED's emissive between 0.6 and 1.0 of its level with a period of 1.2-3.0 s set by load [estimated], never lower, so every D17 colour stays legible. The seeded hero mix is 60% tool, 25% thinking, 10% idle and 5% waiting for the status strips, no errors, and 0-6 lit blades per rack (design-review Phase 3 D11, WD6). `view=racks` shows the chunk 06 hall with a fixed 16 racks (an override, not the time-varying fake count) and the seeded LED load.
- **Dev controls (CEO W-RW12, W-RW20):** a "Racks" section (hall picker, count slider 0-16, fake load on or off) with `__sceneDev.setRackCount(hall, n)` and `__sceneDev.setFakeLoad(on)`.

#### [x] 08. Campus layout and site furniture
- **Goal:** Ground plan with hall slots and the static campus.
- **Depends on:** 07.
- **Tasks:** Campus grid with the hall-slot position table (deterministic positions for up to 12 halls, A/B fixed first), roads, parking with instanced parked cars, security gate with barrier, loading dock with bay doors, road lamps (CEO W-RW3) and the site perimeter (CEO C27). Waypoint graph for vehicles (used later): gate, dock, each hall door.
- **Acceptance:** Two halls (A, B) plus site furniture render. Dev toggle shows the waypoint graph. Total scene draw calls under 40 (CEO W-RW2), read by an e2e from `__sceneDev.stats()` at frozen `home` with shadows on in Chromium (eng-review Phase 3 Section 3). The PR shows `08-campus.png` beside `docs/designs/variant-B-2.png` (section 4b D14, CEO W-RW4). The campus baseline passes in `vp run e2e:local` (CEO C28). Startup and `home()` frame the placed halls, plant, power and gate inside the canvas minus the top bar and tab strip (build decision H1) at 1280x720 and 1920x1080, and placing a third hall through the dev menu widens the next `home()` (unit test on the rig with the layout; CEO C25). The chunk 05 camera e2e that encodes the old home is updated to the C25 contract, not deleted: `e2e/camera.spec.ts:121` frames the placed-campus extent corners, `:185-187` centres the home extent instead of the origin, and `:240` reads the startup zoom from the rig instead of 80 (CEO W-RW38). Layout and waypoint unit tests pass (CEO W-RW1, W-RW9).
- **README:** Image `08-campus.png` (`view=home`) as new hero image. The "Controls" line says `0` or Home frames the placed campus (CEO C25, W-RW40).
- **Campus layout (CEO W-RW1):** a pure module `src/scene/campus/layout.ts` maps slot indices 0-11 (A and B first) to positions, the road grid, the furniture, plant, power and gate zones, and the campus extent. `CAMPUS_BOUNDS` (`src/scene/camera.ts`), the ground and grid size (`src/scene/Ground.tsx`) and the shadow camera extent (`src/scene/LightRig.tsx`) are derived from the extent instead of constants; the rig gains `setCampus({ bounds, home })`, read by `clampTarget` and the home fit at call time, so `camera.ts` never imports campus code and a newly placed hall widens the next `home()` (CEO W-RW27); a zero-size or NaN extent keeps the previous bounds and logs one warning, as S-RW38 does for the `safeArea` (CEO W-RW32); and `ORTHO_ZOOM.min` is lowered if needed so a home fit is never clamped. Assigning projects to slot indices stays in chunk 19's reconciler (D8), which needs no positions and so no dependency on this chunk. Composition follows variant-B-2 (design-review D6, WD1): at the startup view the cooling plant sits top-left, the power yard and fuel tanks left and lower-left, the hall grid in the centre growing toward the top-right, the gate and monument bottom-centre, parking bottom-right, and the loading dock on the hall grid's right flank. Sizes [estimated]: a 16-rack hall is about 8 x 6 units (two rows of 8 at rack pitch 0.8, cold aisle 1.2, hot aisles 0.8, walls 0.4); slot pitch 11 x 9 units (hall plus a 3-unit road); a 4 x 3 slot grid with A and B in the front row nearest the gate, filling toward the back; towers about 2.5x the hall wall height. Plan view (x right, z toward the camera's lower left, not to scale):

  ```text
            -z (screen top-right)
     ┌─────────────────────────────────────────────┐
     │ TOWERS   │  slot 9   slot 10  slot 11 slot 12 │
     │ chillers │  slot 5   slot 6   slot 7  slot 8  │
     │──────────┤  slot 3   slot 4   (dock on right) │
     │ POWER    │  [A]      [B]        DOCK          │
     │ substation, tanks, generators   │ PARKING     │
     │          vault ── fibre ──      │             │
     │                 GATE + MONUMENT                │
     └─────────────────────────────────────────────┘
            +x+z corner (screen bottom-centre)
  ``` Unit tests: every slot and zone lies inside the bounds; slots do not overlap each other or any zone; the whole-campus fit at 1280x720 is at least `ORTHO_ZOOM.min`.
- **First glance and home (CEO C25):** the startup pose and `cameraRig.home()` frame the extent of the placed halls plus the plant, power and gate zones, read from the layout: startup once at load, `home()` on each press. They fit that extent into the canvas minus only the top bar and tab strip, so the KPI tiles, job tracker and right panel float over the campus as in variant-B-2; glides to a selected object still use the `safeArea` (build decision H1, 2026-10-14, user answer after the chunk 08 hero came out small in the 1280x352 safe strip). This amends chunk 05's home ("the whole campus framed") to the placed campus; bounds still cover all 12 slots. A placed hall never moves (D8); only the next `home()` widens.
- **Road lamps (CEO W-RW3):** one instanced post mesh and one instanced lamp-head mesh on a shared warm glow material along the road grid; chunk 34 raises their emissive at night.
- **Site perimeter (CEO C27):** one instanced low-poly tree (trunk and canopy in one geometry with a colour attribute, on its own shared `tree` library material with no clipping plane, CEO W-RW19) on seeded perimeter and road-edge spots; a perimeter fence (instanced posts, merged panels) open at the gate; the gate monument with the "SYNAPSE HORIZON" wordmark, matching the top-bar wordmark (design-review Phase 3 D18, WD12; not the mockup's "SYNAPSE AI DATA CENTRE"), from the shared sign atlas under the chunk 06 12 px pose rule (W-RW5). The look-dev view adds one tree and one fence bay.
- **Empty slots (design-review Phase 3 D16, D17, WD11; approved mockup `empty-slot-20261014/variant-B.png`, UI-6) [estimated]:** each empty slot is a flat pad `#1c2433` (a step above the ground, darker than any hall surface) with a 0.06-unit `#3a4559` outline and its slot number, `01` to `12` in slot order, painted at the front edge facing the gate in Geist Mono at a 0.6-unit cap height in `#3a4559`; the number shows only while it measures at least 12 CSS px at the current pose, the chunk 06 rule. Slot numbers, not hall letters, because chunk 19 assigns letters by project order and overflow halls (A2) take the lowest free slot (D8). Pads carry `userData.ground` (W-RW35). The numbers are one InstancedMesh on the atlas with the E27 fade helper (eng-review Phase 3 D3).
- **Waypoints (CEO W-RW9):** unit tests: the graph is connected; gate to dock and gate to every hall door have a path; no edge crosses a hall footprint.
- **Views (CEO W-RW7):** from this chunk `view=home` shows the campus; until chunk 18, halls A and B show the seeded fake rack set, so the hero has lit racks as in variant-B-2. The existing `home` shots entries regenerate with it (section 4).
- **Dev controls (CEO W-RW12):** a "Campus" section: waypoint graph toggle and placed-hall count (A and B always, up to 12) with `__sceneDev.setWaypoints(on)` and `__sceneDev.setPlacedHalls(n)`.
- **Campus baseline (CEO C28, W-RW15):** `e2e/campus.spec.ts` captures the frozen `home` view (1280x720, `freeze=1`, `seed=1`, after the ready signal) with `toHaveScreenshot` (`maxDiffPixelRatio: 0.005`) in the look-dev Playwright project (Chromium on the Mac, skipped when `CI` is set), baseline under `e2e/__screenshots__/`. `playwright.config.ts`: the `lookdev` project's `testMatch` becomes `/lookdev\.spec\.ts|campus\.spec\.ts/`, and the chromium, firefox (both CI branches) and webkit `testIgnore` patterns add `campus\.spec\.ts`, so the baseline is never written to the gitignored `test-results/`. Every PR that changes the campus look (09, 10, 18-23, 34, 35) updates it in the same PR. When two such PRs are open at once (C26 lets 18 run beside 09 and 10), the one that merges second rebases and regenerates the baseline and the `home` shots on top; binary images are never hand-merged (CEO W-RW39).

#### [ ] 09. Cooling plant
- **Goal:** Cooling towers, chillers, vapour.
- **Depends on:** 08.
- **Tasks:** Low-poly towers and chillers. Vapour as instanced billboards with a soft shader, rate controlled by a `duty` value 0-1 (dev slider). Fan rotation speed follows duty.
- **Acceptance:** Duty slider visibly ramps vapour and fans. Two frozen captures of `view=cooling` match (CEO W-RW16), and a unit test shows the closed-form vapour at scene time 0 has 60 visible particles per tower at duty 1 and none at duty 0 (E26). Vapour costs one draw call per tower group. Vapour uses normal (not additive) alpha blending with `depthWrite: false` and a back-to-front instance sort when the camera moves (unit test on the sort, CEO W-RW18); the PR shows frozen vapour at duty 1 from four azimuths in Chromium, Firefox and WebKit, plus a recorded manual Safari check (CEO W-RW8; Playwright WebKit is not Safari, eng E12). Under normal blending, overlapping billboards converge to the vapour colour, so a unit test checks that the vapour colour's linear luminance (read from the shader uniform, not `emissive`) stays below `RENDER.bloom.luminanceThreshold` (CEO W-RW10, W-RW18). With reduced motion, vapour density is 30% (design D20; unit test on the rate function and one e2e with reduced motion emulated, CEO W-RW8); fans turn at 25% of their duty speed under reduced motion, the D20 packet factor (design-review Phase 3 D12, WD7).
- **README:** Image `09-cooling.png` (`view=cooling`, framed on the cooling zone from the chunk 08 layout).
- **Vapour and fan look (design-review Phase 3 D14, WD9) [estimated]:** vapour `#8090A8` (linear luminance about 0.27, under the 0.6 bloom threshold) at opacity 0.35; billboards grow from 1.2 to 2.4 units over a 6 s life, rise 0.6 units/s with seeded drift; up to 60 per tower at duty 1, emission linear in duty, none at duty 0. Fans turn 0.5 times a second at duty 1 and at 10% of that at duty 0, so the plant never looks stopped; reduced motion: vapour 30% (D20), fans 25% (WD7). Each particle fades in over 0.5 s and out over the last 1.5 s of its 6 s life through the E27 helper, so closed-form rebirth (E26) never pops (eng-review Phase 3 D3) [estimated].
- **Duty and dev controls (CEO W-RW7, W-RW12, W-RW16):** duty, each vapour particle's phase and each fan's angle come from `src/scene/fake.ts` (seeded, frozen under `freeze=1`), so the campus baseline stays stable from this chunk on. Vapour is a closed form of scene time and seed, not a simulation: particle i has age (t + offset_i) mod 6 s and shows when i < 60 x duty, so plumes are full at scene time 0 (every frozen shot) and a duty change takes effect as particles are reborn, within one 6 s life (eng-review Phase 3 D2, E26); a "Cooling" section holds the duty slider, with `__sceneDev.setDuty(value)`.

#### [ ] 10. Power and network infrastructure
- **Goal:** Substation, generators, fuel tanks, fibre vault, fibre lines.
- **Depends on:** 08.
- **Tasks:** Substation (transformers, fence), generators with exhaust stacks, fuel tanks. Fibre entry vault. Fibre lines from the vault to each placed hall, routed on the road grid (rebuilt when the hall set changes, geometry disposed; CEO W-RW11). Packet layer stub: instanced glowing spheres moving along a line at a dev-set rate.
- **Acceptance:** All parts render. Packets travel smoothly along lines, and two frozen captures match (CEO W-RW7); a unit test shows each line holds its capped packet count spread along its length at scene time 0 (E26). With reduced motion, packets move at 25% speed (design D20; unit test and one e2e, CEO W-RW8). Removing a hall slot in the dev menu removes its fibre line, and `renderer.info.memory.geometries` and `textures` return to the previous counts (CEO W-RW11). Route unit test: every line reaches its hall's door side and crosses no hall footprint.
- **README:** Image `10-power-network.png` (`view=power`, framed on the power and vault zones from the chunk 08 layout). "World" gallery section with images 06-10.
- **Fibre routing (CEO W-RW11):** lines follow the road grid from the vault to each placed hall's door side with rounded right-angle bends, as in variant-B-2, never through a hall footprint; only placed halls get a line (A and B always). Look (design-review Phase 3 D13, WD8) [estimated]: tube radius 0.05 units, laid 0.03 above the road and 0.4 in from the kerb, bend radius 0.6, the last 0.6 units climbing the door-side wall to a small entry box; grey junction boxes where lines branch, as one instanced mesh.
- **Packets and dev controls (CEO W-RW7, W-RW12):** packets are pale cyan spheres `#A5F3FC` of radius 0.08 at emissive 3.2 (WD2), at least 1.2 units apart, moving at 2.5 units/s, by default 1 per second per line and at most 12 moving per line, 25% speed under reduced motion (D20) (design-review Phase 3 D13, WD8) [estimated]; packet phase comes from `src/scene/fake.ts` as a closed form: packet j has phase (2.5 t + 1.2 j) mod the line length for j below the rate cap, so lines are populated at scene time 0 (eng-review Phase 3 D2, E26); a "Network" section holds the packet rate, with `__sceneDev.setPacketRate(perSecond)`; hall slots are added and removed through the chunk 08 placed-hall control.

### Phase 4: Data layer

#### [ ] 11. Schema, store, and steady mock source
- **Goal:** One store fed by a mock stream, visible in a debug panel.
- **Depends on:** 04a, for the store module it extends (CEO S-RW1); can run in parallel with 04b-10.
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
- **Depends on:** 08, 13 (CEO C26; was 10, 13).
- **Tasks:** Transient store subscription writes rack instance data each frame: one rack per main session in its project hall, the rack's status strip in the session's status colour, blade LEDs lit per active subagent (up to 12; more keep all 12 lit; chunk 07, design-review Phase 3 D11), LED pulse rate and brightness from tokens/min, vendor colour trim, status colours from the section 4b status palette (design D17), and a slow amber-white beacon above racks in `waiting_user` (design D6), at the top of the Phase 3 emissive ladder, 4.0 (design-review Phase 3 D7, WD2). Hall billboard labels (`aria-hidden`, eng re-review E7; project, session count, worst status) show below the zoom threshold (`SEMANTIC_ZOOM`, chunk 06, CEO W-RW5) and fade to rack detail above it (section 4b, design D7); a hall's billboard also shows above the threshold whenever its sign panel is hidden by chunk 06's pose rule, so each hall has exactly one label at every pose (design-review Phase 3 D8, WD3). Dormant halls use the section 4b style: LEDs off, desaturated through the hall's colour attribute (chunk 06 `setHallTint`, never a per-hall material; CEO W-RW6, W-RW22), grey "No sessions" sign (design D9). Static halls A and B only for now (overflow next chunk).
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
- **Depends on:** 18, 19, 10 (CEO C26: fibre rebuild needs chunk 10).
- **Tasks:** Scene layer diffs layouts: `entering` halls rise from the ground (1.5 s), `retiring` halls power down LEDs then sink and fade (3 s), then all owned geometry, materials, and textures are disposed. The fade darkens through the hall's colour attribute or happens by sinking below the ground, never through a per-hall transparent material, since hall bodies share one opaque material (CEO W-RW6, W-RW22). Fibre lines, signs and overflow conduit lines (cyan, parent to overflow) rebuilt per change; existing halls never move. Delivery truck drives gate to dock to hall door on rack or hall creation (D12), queued if several at once. Automated leak test: Playwright runs `churn` at 60x for 5 min, reads `renderer.info` and heap (Chromium) via a debug hook.
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
- **Depends on:** 21, 09 (CEO C26: cooling ramp needs chunk 09; chunk 10 arrives through 20).
- **Tasks:** Packets along fibre lines with rate proportional to that hall's tokens/min. Heat wash: tint on aisle tiles from hot-aisle °C (amber to red), written to the aisle tiles' colour attribute through chunk 06's `setAisleTint` (CEO W-RW6, W-RW22). Cooling tower duty bound to total hall heat. Technician cart: on agent error, drives the waypoint graph to the rack, plays a node-swap animation, stays until the error clears (D12). Multiple errors queue with a cap of 3 carts.
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
- **Tasks:** Raycasting with instance IDs for racks, agents, carts; object picking for halls, towers, generators. Selection model in the store (`{kind, id}`). Moving instanced meshes (agents, carts, job tokens) recompute their bounding sphere each frame they move, or picking uses store positions on the CPU, so raycasts never miss moved instances (eng review P2). Selection ring (cyan, animated) and HTML label above target. Click = select + glide, double-click = zoom close (cancelling any home glide from chunk 05, CEO S-RW25), Esc = deselect and return focus to the canvas. The live campus summary replaces chunk 05's static canvas `aria-label` (keeping its key-help description, design-review DR15) (design D22; chunk 05 makes the canvas focusable with `role="application"`, CEO C19, S-RW14). Hover highlight. URL hash sync for selection and camera area.
- **Acceptance:** Every entity kind is selectable in all three browsers. Reloading with a hash restores the selection. Picking a moving agent tracks it with the ring. Picking cost under 1 ms per click with 400 agents. Clicking an agent that has walked away from its spawn point still selects it (G8, perf P2). Removing the selected entity (hall retires) closes the panel cleanly (G9).
- **README:** "Interaction" section. Image `24-selection.png`.

#### [ ] 25. Area switcher and shortcuts
- **Goal:** Fly between Halls, Cooling, Power, Network.
- **Depends on:** 24.
- **Tasks:** Camera presets per area computed from current layout (Halls preset reframes as halls are added). Keyboard: 1-4 areas, `/` search focus, D day/night, W weather cycle, Esc deselect. Shortcut help overlay on `?`, combined with the scene legend and listing chunk 05's camera keys (CEO C19); the legend auto-shows once on first visit (section 4b, design D13). With localStorage blocked, the legend still works and shows once per page load without errors (G19).
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
- **Tasks:** Fuzzy search over projects, session IDs, rack IDs, agents, tool names; dropdown and toast behaviour per section 4b (design D12), extending the 04b toast host (CEO C15); Enter flies to the result. Alert rules: agent error, waiting on user over 2 min, estimated rack temp over 35 °C, overflow hall created, log parse failure, hall cap reached. Only live (non-backfill) events raise toasts or announcements (E4); outside live mode toasts and alert rows carry a `REPLAY` or `MOCK` tag (E5); tests for both (G14). Keyboard-only e2e: Tab to the table, Down, Enter selects and glides to the entity (G16). Attention chip counts match the store and clicking it flies to the oldest waiting agent (G17). Alerts announced via `aria-live` (polite for info/waiting, assertive for errors) (design D22). Alert list with acknowledge, toasts capped at 3 with "+N more alerts" overflow (design D12), alert counts in the top-bar attention chip, the single alert entry point, with an alert panel tabbed "Needs you" / "All alerts" (design D6, D26).
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
- **Acceptance:** Smooth transition, no frame drops. Scene stays readable at night. Contrast check passes in forced-day, dusk and forced-night (dusk is the 0.30 glass level, CEO S-RW30): panel text at least 4.5:1, large numerals at least 3:1 against the rendered backdrop (design D21). Screenshot views fixed at noon via `freeze`.
- **README:** Day and night images `34-day.png`, `34-night.png`.

#### [ ] 35. Weather states
- **Goal:** Clear, Heatwave, Monsoon, Storm, visual and panel only.
- **Depends on:** 34.
- **Tasks:** Weather section of the Ambience menu (design D25) with manual select and auto-cycle (configurable interval); shortcut W still cycles. Heatwave: heat shimmer, towers shown at max duty, warmer grade. Monsoon: instanced rain, wet ground tint. Storm: rain, lightning flashes, wind on vapour, generator test sequence (generators spin up, lights flicker 1 s, test log in panel). Weather panel with condition, outside temp (estimated), and generator test log. Assert simulation independence (D13).
- **Acceptance:** Unit test: switching weather changes no store value outside the `weather` slice. Rain costs one draw call. Each state looks distinct in screenshots. The 04b contrast helper passes in forced day + heatwave at the 72% glass level (design D21, CEO S-RW9).
- **README:** Image per state `35-<state>.png`.

#### [ ] 36. Cross-browser performance pass
- **Goal:** Meet the budget in all three browsers.
- **Depends on:** 35.
- **Tasks:** Perf scenario: 12 halls, 200 racks, 400 agents, storm, night, with `calm=0` so the 60 fps cap holds (CEO C16). Measure fps and p95 frame time in Chrome, Safari, Firefox on the target machine (an M1 Air-class Mac; required here because chunk 03 measured on an M1 Max, CEO C11). Auto quality tiering (shadows, bloom, pixel ratio, vapour density, glass fallback) driven by measured fps with hysteresis, extending the 04a frame monitor (CEO S-RW5) rather than adding a second one. Draw-call and triangle budgets enforced by a test that fails CI when exceeded, starting from Phase 3's per-part caps and 150k campus total (eng-review Phase 3 D4, E28).
- **Acceptance:** Measured on the Mac via `vp run e2e:local` (eng review D6). 60 fps median at high or auto-dropped tier in all three; never under 30 fps p95. Results table appended to `docs/adr/0002-perf.md`.
- **README:** "Performance" section with the results table.

#### [ ] 37. Provenance audit, accessibility, final README
- **Goal:** Ship-ready polish.
- **Depends on:** 36.
- **Tasks:** Walk every panel and confirm every number has the right badge versus the feasibility table. Keyboard focus order, visible focus rings, colour contrast on glass. A colour-blindness simulation (protanopia, deuteranopia) of the campus confirms the error cart and waiting beacon read without colour (Phase 3 design review D19, WD13). Audit that every animated chunk honours the reduced-motion flag from chunk 04 (design D20). Error states: log server down, empty logs, parse failures. Final README pass: hero image, full gallery, architecture diagram, configuration, known limits.
- **Acceptance:** Audit checklist committed and fully ticked. axe-core e2e reports no serious issues on the dashboard. Fresh clone + README instructions reach a working app.
- **README:** Final version per section 4 skeleton.

---

## 6. Dependency summary

```text
01 → 02 → 02b (release) ; 02 → 03 (gate) → 04a → 04b → 05 → 06 → 07 → 08 → 09
                                                                   08 → 10
04a → 04c → 06                           (look, parallel to 04b and 05; CEO C22)
04a → 11 → 12 → 13 → 15 → 16 → 17       (data track, parallel to 04b-10; CEO S-RW1)
     11 → 14 ─────┘ ; 02b → 14 ; 14 → 14b (downloads)
08 + 13 → 18;  13 → 19;  18 + 19 + 10 → 20 → 21;  21 + 09 → 22 → 23   (CEO C26)
23 → 24 → 25, 26;  25 → 27 → 28, 29(+26), 30, 31 → 32(+29), 33
27 → 34 → 35 → 36 → 37
```

The data track (11-17) can run alongside world building (04-10) in a separate branch or worktree, since they share no files after chunk 04a, except `sidecar/cli.ts` from 02b, which chunk 14 extends, and the store from 04a, which chunk 11 extends (CEO S-RW1). Each store slice lives in its own file under `src/app/store/`, so 04b (`safeArea`) and chunk 11 never edit the same slice file. 04b and 04c can run in parallel; both append entries to `scripts/shots.config.ts`, which merges trivially.

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

- [x] **DT1 (P2, human: ~3h / CC: ~10min)** — tokens — Type, spacing, radius, status, motion and focus tokens
  - Surfaced by: Pass 5 — D16, D17, D20, D21
  - Files: src/styles/tokens.css, tailwind config
  - Verify: `vp check`; token values match section 4b
- [x] **DT2 (P2, human: ~4h / CC: ~15min)** — layout — GlassPanel, layout shell, safeArea, loader, WebGL failure card
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

- [x] **T1 (P1, human: ~1 day / CC: ~40min)** — spike — Shared scene, fake store and renderer settings; vanilla and R3F views with per-hall instancing, shared materials and identical per-frame work
  - Surfaced by: C10 (PQ1); RW1, RW4, RW5, RW6, RW8, RW9
  - Files: package.json, pnpm-lock.yaml, src/spike/shared/scene.ts, src/spike/shared/fakeStore.ts, src/spike/shared/render.ts, src/spike/vanilla/view.ts, src/spike/r3f/View.tsx, src/app/App.tsx
  - Verify: `/?view=spike-r3f&load=4` and `/?view=spike-vanilla&load=4` render 18-hall churn with shared materials intact; `vp check`
- [x] **T2 (P1, human: ~4h / CC: ~20min)** — spike bench — Driver, sampler, settle, churn cycles, JSON records with metadata, failure registry and fake-clock tests
  - Surfaced by: C10 (PQ1), C12 (PQ4); RW2, RW3, RW8, RW10
  - Files: src/spike/shared/bench.ts, src/spike/shared/params.ts, src/spike/shared/bench.test.ts, src/spike/shared/params.test.ts
  - Verify: `vp test` covers all 12 registry rows and one rendered frame per churn cycle
- [x] **T3 (P2, human: ~2h / CC: ~10min)** — spike tests — Stats, scene and store unit tests; local three-engine smoke skipped in CI
  - Surfaced by: C13 (PQ5)
  - Files: src/spike/shared/stats.ts, src/spike/shared/stats.test.ts, src/spike/shared/scene.test.ts, src/spike/shared/fakeStore.test.ts, e2e/spike.spec.ts
  - Verify: `vp test`; `vp run e2e:local` opens both views at load 1 and 4 in all three engines with no console errors; CI log shows the spike spec skipped
- [x] **T4 (P1, human: ~30min / CC: ~5min)** — docs — ADR 0001 with settings, method, decision rule and pass protocol, committed before any run
  - Surfaced by: C10 (PQ1), C14 (PQ6); RW1, RW11
  - Files: docs/adr/0001-render-integration.md
  - Verify: the rule commit's SHA is named in the ADR and precedes every result's start time
- [x] **T5 (P1, human: ~1.5h / CC: none)** — measurement — 48 passes on the M1 Max production build in Chrome, Safari and Firefox; raw JSON, results table, decision, consequences
  - Surfaced by: C10, C11 (PQ3), C14 (PQ6); RW10, RW12
  - Files: docs/adr/0001-results/*.json, docs/adr/0001-render-integration.md
  - Verify: table built only from `valid:true` files; rule applied as written; 1x rows labelled "M1 Max, overstates M1 Air GPU"
- [x] **T6 (P2, human: ~30min / CC: ~5min)** — docs — README "Architecture" stub linking the ADR; `spike-r3f` shots view and `03-spike.png`
  - Surfaced by: RW4; section 4 protocol
  - Files: README.md, scripts/shots.config.ts, docs/img/03-spike.png
  - Verify: `vp run shots` writes `03-spike.png` under 200 KB
- [x] **T7 (P3, human: ~30min / CC: ~5min)** — chunk 04a cleanup — Delete spike views, App branch, spike shots entry and the rejected dependency
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

- [x] **T1 (P1, human: ~1h / CC: ~5min)** — tooling, bench — Cross-origin isolated measuring server and timer-step check
  - Surfaced by: Scope Challenge — E6 (eng D2)
  - Files: vite.config.ts, src/spike/shared/bench.ts, src/spike/shared/bench.test.ts, docs/adr/0001-render-integration.md
  - Verify: `vp test`; on `vp build` then `vp preview --host 127.0.0.1`, `crossOriginIsolated === true`; `smoke.spec.ts` and `repeat.spec.ts` still green
- [x] **T2 (P2, human: ~15min / CC: ~2min)** — deps — Dependabot ignore rules for three, @types/three and postprocessing with peer-range comment
  - Surfaced by: Scope Challenge — E7 (eng D3)
  - Files: .github/dependabot.yml
  - Verify: Dependabot config check shows no error; the three rules are present
- [x] **T3 (P1, human: ~1h / CC: ~5min)** — spike render — Pin composer options in the shared constant and pass them in both views
  - Surfaced by: Scope Challenge — E8
  - Files: src/spike/shared/render.ts, src/spike/vanilla/view.ts, src/spike/r3f/View.tsx
  - Verify: both views' snapshots report the same multisampling and frame buffer type; E17 smoke passes
- [x] **T4 (P2, human: ~2h / CC: ~10min)** — spike bench — SpikeView seam, wall-clock churn hitch, awaited addHalls, dispose-event count, draw calls with autoReset off, preallocated samples, fake-view unit tests
  - Surfaced by: Scope Challenge — E9, E10; Architecture — E15, E16; Performance — P-E1
  - Files: src/spike/shared/bench.ts, src/spike/shared/bench.test.ts, src/spike/vanilla/view.ts, src/spike/r3f/View.tsx
  - Verify: `vp test` covers each rule against a fake SpikeView
- [x] **T5 (P2, human: ~30min / CC: ~5min)** — spike params — Accept shots contract params, seed the store, freeze one frame, refuse bench with freeze
  - Surfaced by: Scope Challenge — E11
  - Files: src/spike/shared/params.ts, src/spike/shared/params.test.ts, src/spike/shared/fakeStore.ts
  - Verify: `vp test`; `vp run shots` captures the spike view with no console warning
- [x] **T6 (P2, human: ~1h / CC: ~5min)** — e2e — Equal-scene assertion across views in the local spike smoke
  - Surfaced by: Test review — E17 (eng D4)
  - Files: e2e/spike.spec.ts, src/spike/vanilla/view.ts, src/spike/r3f/View.tsx
  - Verify: `vp run e2e:local` green in three engines; CI log shows the spec skipped
- [x] **T7 (P3, human: ~5min / CC: ~1min)** — verify — Run `vp check` immediately after adding R3F to prove its JSX types under TypeScript 7
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

## CEO review record: Phase 2 (/plan-ceo-review, 2026-10-13)

Target: Phase 2 (chunks 04a, 04b, 05; 04c added by C22) of `docs/PLAN.md`, branch `phase-2-scene-foundation`, base `main` at `d428146`. Reviewer: Claude (in-host). Review depth: implementation-ready, Phase 2 only. No Phase 2 design doc exists; the finder returns `docs/designs/phase-0-tooling.md` (Phase 0 CEO summary). Questions in this record are numbered SQ1, SQ2... (shown in chat as D1, D2...); ledger rows continue the CEO series at C15. Findings in this record are numbered S-F1, S-F2... so they do not collide with earlier F-numbers.

### 0A. Premise (Phase 2)

- Real problem: about 30 later chunks draw into one canvas, use one camera, one look, one panel frame and one way to navigate. Changing any of these after chunk 06 means touching every chunk built on it.
- Target outcome: the app opens on one persistent R3F canvas with the final look language, the empty dashboard frame with a correct `safeArea`, and map navigation with a programmatic glide, each chunk ending in a screenshot.
- Do-nothing cost: none to weigh; Phase 3 onward cannot start without this phase. The question is its shape.
- Phase 2 as written solves this directly, with these gaps:
  - S-F1 [P1] Forward dependencies in 04a [measured: plan text]. 04a's WebGL card is a "full-viewport glass card" (design D11) and context restore shows a toast (D11, D12), but `GlassPanel` is built in 04b (chunk 04b Tasks) and the toast system in chunk 32 (chunk 32 Tasks). 04a cannot pass its acceptance in the order written. Resolved by C15 (SQ2).
  - S-F2 [P1] The store does not exist yet [measured: `package.json` has no `zustand`; chunk 11 creates the store]. 04a adds a `reducedMotion` store flag and 04b a `safeArea` store rect. Resolved by S-RW1.
  - S-F3 [P1] Adaptive glass inputs arrive in chunks 34 and 35 [measured: plan text]. R13 keys the glass fill on day/night phase (chunk 34) and weather (chunk 35). With a test cube on a night ground, 04b can show one state only, so "glass panels stay readable over bright and dark scene regions" (chunk 04b Acceptance) cannot be produced. Chunk 34 already owns the forced-day and forced-night contrast check (chunk 34 Acceptance); chunk 35 had no check for the day + heatwave 72% level. Resolved by S-RW9 and S-RW15; the glass colour model is C21.
  - S-F4 [P2] The 04a draw-call bar conflicts with bloom [measured: ADR 0001 rule 2 table, 48 draw calls with bloom off and 65 with bloom on for the same scene]. Bloom adds 17 composer draw calls, so "Perf HUD shows under 10 draw calls" fails whenever bloom is on (D10 default), if the HUD counts every pass as the spike did (eng E10). With three's default `autoReset`, the HUD shows only the last composer pass, which means nothing. Resolved by S-RW4.
  - S-F5 [P1] Dev and test surfaces in the production build [measured: `playwright.config.ts:37` runs `vp build && vp preview`]. Every Playwright spec and `vp run shots` runs the production bundle. A perf HUD, WebGL-off flag or dev menu gated on `import.meta.env.DEV` would be missing from every automated check that 04a, 04b and 05 name. Resolved by S-RW2.
  - S-F6 [P2] Spike deletion would throw away product code [measured: `wc -l`, 3,418 lines in `src/spike/` and `e2e/spike.spec.ts`]. The pinned renderer and composer constant (`src/spike/shared/render.ts:17-42`, the ADR's settings table), `guardComposer`, the draw-call counter and the shared-material dispose-event guard are what 04a needs. Resolved by S-RW3 (corrected by S-RW31: the R3F path needs the inner composer error boundary, not `guardComposer`).
  - S-F7 [P1] No frame-rate or power policy [measured: ADR 0001 environment table, Firefox refresh interval 8.18 to 8.38 ms (about 120 Hz); bloom adds about 6.6 ms median GPU time per frame at 4x in Chrome on the M1 Max; `src/spike/shared/render.ts:20` sets `powerPreference: "high-performance"`]. The storyboard's long-term use is a tab left open all day (section 4b, step 7). R3F's default loop renders every display refresh, so Firefox on a ProMotion laptop draws up to 120 frames a second with bloom, whether or not anything moved; ADR 0001 measured Chrome at 60 Hz on this Mac (16.68 ms), and Safari stays near 60 by default. Correction from the spec review: the C16 question said Chrome and Firefox both run near 120 Hz; only Firefox was measured there. Resolved by C16 (SQ3).
  - S-F8 [P2] The 04a look cannot be judged on a test cube [inference]. "Lighting rig ... tuned to match the approved mockup (design D14)" has only a cube and ground to tune against, so the acceptance cannot fail. The mockup lives outside the repo (`~/.gstack/projects/bjorkgard-ai-center/designs/main-dashboard-20261012/variant-B-2.png`), so only this machine can compare against it. Resolved by C17 (SQ4).

### 0B. Existing code leverage (Phase 2)

| Sub-problem | Existing code | Plan as written | Reuse |
|---|---|---|---|
| Renderer, tone mapping, shadows, composer and bloom settings | `src/spike/shared/render.ts:17-42` (`RENDER`, `applyRendererSettings`), ADR 0001 settings table | deleted with the spike in 04a | move to `src/scene/render.ts` (S-F6) |
| Composer init failure | R3F view: inner error boundary around `<EffectComposer>` (`src/spike/r3f/View.tsx:336-347`); `guardComposer` (`render.ts:44-55`) serves the vanilla view only | deleted | move the boundary pattern; drop `guardComposer` (S-RW31) |
| Draw calls across composer passes | `DrawCallCounter` (`src/spike/shared/bench.ts`) | deleted | move for the perf HUD (S-F4) |
| Shared materials that survive unmount | `createSharedMaterials` dispose-event counter (`render.ts:100-130`), ADR RW6 pattern | deleted | pattern for `scene/materials.ts` |
| URL parameters with allowlist and warnings | `src/spike/shared/params.ts` | deleted | generalise to an app parameter module (S-F5) |
| `freeze=1` single-frame render | spike `freeze` handling (eng E11) | deleted | reuse for the scene clock |
| Shots wait for first render | `ready` expression in `scripts/shots.config.ts` | spike entry removed | same hook, scene-ready signal |
| Three-engine smoke | `e2e/smoke.spec.ts`, `e2e/spike.spec.ts` | spike spec deleted | extend smoke |
| Tokens | `src/styles/tokens.css` (type, spacing, radius, status) | extended | add motion tokens; glass fill 6% and border 8% differ from D18's 8% and 12% |
| Cross-origin isolated preview | `vite.config.ts` `preview.headers` | kept | keep for chunk 36 timing |

New dependencies needed: `zustand` (D11; latest 5.0.15 [measured: `npm view`]). Optional: `@react-three/drei` 10.7.9 (peers `three >=0.159`, `@react-three/fiber ^9.0.0`, React 19 [measured: `npm view`]) if chunk 05 uses its controls; section 1's provisional pick named drei, but nothing installs it yet. Nothing is rebuilt.

Reality rows:
- REALITY: premise-table finding unverified=3 (postprocessing composer state after a WebGL context restore; bloom GPU cost on an M1 Air; `WEBGL_lose_context` restore behaviour in Safari) docs/PLAN.md:459
- REALITY: already-done pass `git log origin/main -- src/scene src/dashboard src/config src/sim` shows only `f72dee8` (scaffold `.gitkeep`); no scene, shell or controls code exists docs/PLAN.md:455
- REALITY: surface-check finding R3F's `fallback` prop renders as `<canvas>` child content (`node_modules/@react-three/fiber/dist/react-three-fiber.esm.js:182`), shown only when the browser lacks canvas, not when WebGL fails; a failed WebGL context rejects into R3F's error path (`:117`); three's `WebGLRenderer` handles `webglcontextlost` and `webglcontextrestored` itself (`node_modules/three/src/renderers/WebGLRenderer.js:403-404, 1113-1140`); `vp run shots` and `vp run e2e:local` exist (`package.json` scripts) docs/PLAN.md:458
- REALITY: binding-decisions pass D9, D10, D11, D14, D16-D22, R12, R13 and ADR 0001 (R3F) honoured; `gstack-decision-search --scope branch --recent 50` returned none; TODO E18 (#9 moved `vp dev` to `localhost`) triggers before chunk 14, not in Phase 2 docs/PLAN.md:34
- REALITY: numbers finding 04a's "under 10 draw calls" fails with bloom on, which adds 17 composer draw calls [measured: ADR 0001]; 45 fps floor, 600 ms glide and glass levels are approved budgets [estimated in their source decisions]; file counts below are [estimated] docs/PLAN.md:459
- REALITY: deferred-asks pass no brief item or TODO is scheduled into Phase 2; `vp run doctor` (X3) and E18 have triggers outside it TODOS.md:5
- REALITY: pr-count pass no `.gstack/ship-policy.json`; Phase 2 is three chunk PRs (04a, 04b, 05) plus this review's docs PR (D18); four chunk PRs after C22 adds 04c docs/PLAN.md:31

### 0C. Dream state (Phase 2)

```text
  CURRENT STATE                 THIS PLAN (04a-04c, 05)            12-MONTH IDEAL
  blank page plus throwaway --> one R3F canvas with the final  --> campus open all day on a laptop at
  spike views; ADR picks R3F;   look on a placeholder scene;       near-zero cost when calm and a steady
  no scene, store, layout or    dashboard frame with glass and     60 fps when busy; panels readable at
  controls                      safeArea; map controls + glide     any time of day; the camera flies to
                                                                   whatever needs you; every look change
                                                                   caught by a screenshot diff
```

Phase 2 moves toward the ideal. Gaps: no power policy (S-F7), and the look acceptance cannot be checked before chunk 08 (S-F8).

### Mode (Phase 2)

SELECTIVE EXPANSION, chosen by the user (SQ1, 2026-10-13; question answer, not auto-decided). The recommendation was SCOPE REDUCTION by the file-count rule: about 63 planned changed files [estimated] across 04a, 04b and 05, 18 of them spike deletions. Under SELECTIVE EXPANSION, Phase 2 scope is held and hardened, and each addition is offered separately for Add, Defer or Skip. No approach decision was needed before the mode.

### Required work applied without a new choice (Phase 2)

Each item cites the approved contract it serves; all are applied to the chunk text above.
- S-RW1 (S-F2; D11 Zustand store): the store and its `ui` slice are created in 04a; chunk 11 extends it.
- S-RW2 (S-F5; D18 Playwright on the production build, section 4 shots contract): one allowlisted parameter module, read in production builds, gates the HUD, dev menu and WebGL-off flag.
- S-RW3 (S-F6; ADR 0001 settings, RW1, RW6, RW7, eng E10): the pinned settings, composer guard, draw-call counter and material guard move to `src/scene/` before the spike is deleted.
- S-RW4 (S-F4; D10 bloom on by default, eng E10 counting): the HUD splits scene and post-processing draw calls; the "under 10" bar reads scene draw calls.
- S-RW5 (D10 "bloom auto-disabled below 45 fps", design D18 glass fallback "triggers and recovers"): neither has an owner before chunk 36, which already plans hysteresis; 04a builds the one frame monitor both need.
- S-RW6 (D11 WebGL card; surface check): detection uses a pre-check and an error boundary, not R3F's `fallback` prop; a composer failure disables bloom only.
- S-RW7 (section 4 `freeze` contract, D10 loader): one first-frame signal feeds the loader, shots and smoke.
- S-RW8 (design D18 GlassPanel spec, now written into section 4b "Glass panel"): glass tokens corrected to 8% and 12%.
- S-RW9 (S-F3; R13 lookup, D21 contrast check): the lookup and contrast helper are built in 04b at the night level; the day + heatwave check is added to chunk 35, which had none.

Added after the first spec review (reviewer findings, each tied to an approved contract):
- S-RW10 (D11 "restore automatically"; Prime Directive 1): the composer is rebuilt after a restore (by remounting under its error boundary, S-RW31), and a context that does not come back within 10 s shows the card.
- S-RW11 (design D18 "the fallback triggers and recovers in Firefox"): a `dev=1` hook feeds the frame monitor synthetic intervals, since Playwright can throttle only Chromium.
- S-RW12 (C16 approved cap): the 60 fps cap is proven by a unit test at 120 Hz, because headless Chromium drives rAF at 60 Hz and an e2e frame count would pass without a cap; the driver tolerates rAF jitter.
- S-RW13 (D11 toast, D12 lifetimes): the restore toast stays while `restoring` and clears on `ok`; the 6 s rule is for normal toasts.
- S-RW14 (C19 approved focusable canvas): chunk 24 now replaces the static label instead of adding the role.
- S-RW15 (R13 table): weathers other than heatwave use the clear level, so the lookup is defined for every input.
- S-RW16 (reuse ladder: installed dependency before a new one; C16, C20): chunk 05 uses three's `MapControls`, not drei; settling controls count as camera motion for calm mode.
- S-RW17 (C17 approved baseline): the look-dev baseline is committed under `e2e/__screenshots__/`, runs in Chromium on the Mac only and is skipped in CI.
- S-RW18 (housekeeping): the section 4b mockup path names the repo copy; chunk 36 extends the 04a frame monitor; `calm` and `lookdev` join the parameter list; the smoke spec drops its heading check; ADR 0001 notes the C16 renderer change.

Added after the second spec review (reviewer findings, each tied to an approved contract):
- S-RW19 (D10 loader "until the first frame", D11 card): with no WebGL no frame renders, so the loader also ends on `unavailable`, and the `webgl=0` specs wait on the card.
- S-RW20 (S-RW7 ready signal; eng T2 repeat check): `e2e/repeat.spec.ts` and every shots entry wait on the ready signal, or their first capture can precede the first WebGL frame.
- S-RW21 (D20 "every animated chunk checks both modes in its acceptance"; S-RW16): chunk 05's acceptance checks reduced motion and that settling damping holds the cap.
- S-RW22 (labels): "D18" for the glass panel now reads "design D18" (section 1 D18 is the test policy), and section 4b gains a "Glass panel" subsection holding the spec.
- S-RW23 (record accuracy): the C16 answer carries a note on its superseded details.
- S-RW24 (C17 baseline; `playwright.config.ts` projects have no `testMatch`): the three browser projects ignore the look-dev spec, which opens the section 4 URL after the ready signal.
- S-RW25 (C20 double-click, chunk 24 double-click): empty ground is a nearest hit on the ground mesh, and an entity double-click cancels a home glide.
- S-RW26 (D9 "perspective toggle" had no trigger): a `dev=1` HUD button in 04a and the `P` camera key in chunk 05; controls rebind on a toggle; perspective has a distance clamp. `P` joins the C19 key set.
- S-RW27 (S-RW11): synthetic intervals replace real ones while set, so recovery is deterministic.
- S-RW28 (S-RW9 contrast helper): empty slots show placeholder titles so the helper has text to sample.
- S-RW29 (C16 cap, S-RW5 monitor): deadline-accumulation pacing and a windowed mean, with tests at 60, 75, 90, 120 and 144 Hz; a fixed minimum-interval cap misreads 90 and 144 Hz displays.
- S-RW30 (D18 CI smoke, section 4 `freeze`, D21): confirm WebGL2 in CI with a written fallback; `freeze` re-renders its frame after a resize or restore; `=` works as `+`; chunk 34 also checks the dusk glass level.

Added after the third spec review (cap reached; fixes checked by Claude against the text, not re-reviewed):
- S-RW31 (S-RW6, S-RW10; `src/spike/r3f/View.tsx:336-347`): in R3F the composer is guarded by an inner error boundary and rebuilt by remounting; `guardComposer` was vanilla-only and is dropped.
- S-RW32 (S-RW4 HUD; section 4 shots contract): the scene/post-processing draw-call split is measured with a snapshot after the render pass; `04a-core.png` is captured with `dev=1` through a per-entry extra query, and the frozen HUD shows counts, not fps.
- S-RW33 (D11 "restore automatically"): a restore after the 10 s timeout still returns to `ok`.
- S-RW34 (S-RW5 monitor in e2e): the monitor pauses under `freeze=1`, so slow software rendering cannot flip glass or bloom in contrast checks and shots.
- S-RW35 (S-RW20, S-RW30): the CI fallback also skips `e2e/repeat.spec.ts` in a browser without WebGL2; both SwiftShader flags are named, unverified.
- Also applied: chunk 05 acceptance gains the C20 corner-scroll e2e and names the double-click check as e2e; section 4b says 04c (not 04) compares to the mockup; section 6 draws `08 → 10` and `04a → 04c → 06` separately; store slices live in separate files so 04b and chunk 11 do not collide; 04a defines the camera ranges that chunk 05 clamps to.

Added in the review sections:
- S-RW36 (04a/04b smoke "no console errors"; Section 1 A-2): `safeArea` writes are coalesced to one per animation frame.
- S-RW37 (section 4b "a selected object is never behind a panel", D5; Section 1 A-3): glides retarget when `safeArea` changes mid-glide.
- S-RW38 (D5 framing contract; Section 2 E-2): a `safeArea` with no width or height falls back to the full canvas with one console warning.
- S-RW39 (04a "toggle switches ortho/perspective without jump"; Section 4 D-1): a toggle cancels a glide in flight and keeps the framing.
- S-RW40 (Prime Directive 1; Section 8 O-1): `[scene]` console lines for every state transition, and README "Known limits" lines for both cards.

### 0G. Selective-expansion checks (Phase 2)

Hold-scope checks:
- Complexity: about 63 files [estimated] is far over the 8-file mark, with new modules for the store, scene, shell and camera rig. Challenge result: 18 are mechanical spike deletions; S-RW3 reuses about 300 lines of spike code instead of rewriting them; each chunk is its own PR (D18). No smaller set reaches the phase goal, since every later chunk needs the canvas, store, shell and camera.
- Minimum change: every Phase 2 item is required by an approved design decision (D9, D10, D11, D14, D18, D20, D21) or by a later chunk. No deferral proposed.
- Invariants kept: D1 (three browsers), D9, D10, D11, D14, D16-D22, D18 (one PR per chunk), R12, R13, ADR 0001 (R3F, pinned settings), section 4 protocol. Repairs needed to meet them: S-RW1 to S-RW9 above, and S-F1 (pending C15, which amends R12's split).

10x check: the 10x version of Phase 2 is a foundation that costs almost nothing while the campus is calm, cannot change its look without a failing screenshot, and moves like a good map app. That is about 2x the effort of the phase as written, mostly in the render loop and a look-dev view.

Delight scan (adjacent improvements of about 30 CC-minutes or less):
1. Frame-rate and power policy for an all-day tab (S-F7).
2. Look-dev view with a baseline screenshot, so materials and lighting are tuned and guarded from 04a on (S-F8).
3. Startup quality probe that picks the first tier from a short warm-up instead of starting high and stuttering.
4. Keyboard camera controls when the canvas has focus (arrows, zoom keys, rotate keys, reset).
5. Map feel: zoom toward the cursor, reset view, light damping.
6. Loader fades into the first frame over `--dur-ui` instead of cutting.

Platform potential: the render settings, frame monitor, parameter module and first-frame signal are reused by every scene chunk (06-37) and every Playwright spec. Item 6 is a design detail of the approved D10 loader and goes to the design pass in Section 11, not to the menu. Items 1-5 are offered below, one question each.

### Decision ledger (CEO, Phase 2)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| C15 04a forward dependencies (Claude, 0G) | R12 split (re-review D1 A): WebGL card and context restore in 04a, `GlassPanel` in 04b; D11 "full-viewport glass card" and "Restoring 3D view" toast; toasts built in chunk 32 (docs/PLAN.md:680); S-F1 | 04a acceptance needs a glass card and a toast that do not exist yet | A: detect in 04a (store `webgl` state, auto-restore, plain card); 04b gives the card the glass look and adds a minimal toast host that chunk 32 extends | none | approved | SQ2 answer "Detect in 04a, style in 04b (recommended)", 2026-10-13; scope: placement of the WebGL card look and the restore toast across 04a, 04b and 32; R12 split otherwise unchanged; applied to chunks 04a, 04b and 32 |
| C16 frame-rate and power policy (Claude, 0G) | S-F7; storyboard step 7 (all-day tab); ADR 0001 refresh and bloom GPU numbers | none | A: 04a render loop with `frameloop="never"` driver, 60 fps cap, 30 fps calm mode after 5 s idle, `powerPreference: "default"`, `calm=0` parameter, tests | none | approved | SQ3 answer "Add to this plan's scope (recommended)", 2026-10-13; scope: chunk 04a render loop and power policy, plus `calm=0` in chunk 36's perf scenario; applied to chunks 04a and 36 |
| C17 look-dev view and baseline (Claude, 0G) | S-F8; D14 "tuned to match the approved mockup" | none | A: `?view=lookdev` in 04a, `04a-lookdev.png`, `toHaveScreenshot` baseline in `e2e:local`, mockup copy in `docs/designs/`, chunks 06-10 extend it | none | approved | SQ4 answer "Add to this plan's scope (recommended)", 2026-10-13; scope: look-dev view, shot, baseline and mockup copy in 04a; Phase 3 chunks add their materials; applied to chunk 04a and the Phase 3 heading; moved to chunk 04c by C22 |
| C18 startup quality probe (Claude, 0G) | D10 bloom auto-disable; chunk 36 auto tiering; S-RW5 frame monitor | none | B: deferred to `TODOS.md` (P3, trigger: chunk 36 shows a startup stutter on the M1 Air-class Mac) | none | deferred | SQ5 answer "Defer to TODOS.md (recommended)", 2026-10-13; scope: startup probe postponed, not rejected; Phase 2 starts at the high tier and relies on S-RW5; no chunk text changed |
| C19 keyboard camera controls (Claude, 0G) | D22 canvas `role="application"` and keyboard access; chunk 25 shortcuts (1-4, `/`, D, W, Esc, `?`) | none | A: chunk 05 camera keys while the canvas has focus (arrows, `+`/`-`, `Q`/`E`, `0`/Home to `cameraRig.home()`), focusable canvas, tests; chunk 25 lists them | none | approved | SQ6 answer "Add to this plan's scope (recommended)", 2026-10-13; scope: keyboard camera controls and `cameraRig.home()` in chunk 05, help-overlay listing in chunk 25; applied to chunks 05 and 25 |
| C20 map feel (Claude, 0G) | chunk 05 controls (approved); chunk 24 double-click on an entity zooms close | none | A: chunk 05 zoom toward the cursor, light damping on pan and rotate, double-click on empty ground glides home, zoom maths unit test | none | approved | SQ7 answer "Add to this plan's scope (recommended)", 2026-10-13; scope: chunk 05 control feel only; chunk 24's entity double-click unchanged; applied to chunk 05 |
| C21 glass fill colour model (Claude, spec review) | design D18 "8% white fill" against D21 "steps from 8% up to 72% dark" (night 8%, dusk 30%, day 60%, day + heatwave 72%); spec review Consistency 1 | ambiguous: night 8% white or 8% dark, day dark or white | A: constant 8% white tint (D18) over a dark `--color-bg` underlay whose alpha is the lookup level: night 0, dusk 0.30, day 0.60, day + heatwave 0.72 | none | approved | SQ8 answer "White tint over dark underlay (recommended)", 2026-10-13; scope: GlassPanel fill model and `glassFill` return value; border, blur, fallback and contrast checks unchanged; applied to section 4b D21 and chunk 04b |
| C22 04a size (Claude, spec review 2) | brief: each chunk fits one sitting (docs/PLAN.md:4); R12 split chunk 04 at 314 words; 04a is now 1,242 words [measured: `wc -w`] after S-RW1 to S-RW18, C16 and C17 | one chunk 04a | A: 04a scene core (canvas, loop, store, parameters, camera, HUD, tiers, failure handling, test cube) and new 04c look (rig, materials, look-dev view, baseline, mockup copy); 04b and 04c depend on 04a; 06 depends on 04c and 05 | none | approved | SQ9 answer "Split into 04a core + 04c look (recommended)", 2026-10-13; scope: chunk boundaries and dependencies only, no task added or removed; README images `04a-core.png`, `04c-scene.png`, `04c-lookdev.png`; applied to chunks 04a, 04c, 06, section 6 and the section 4b mockup note |
| C23 scene runtime errors (Claude, Section 2) | Prime Directive 1 (zero silent failures); D11 card text "Your browser could not start 3D (WebGL)."; Section 1 A-1; chunk 04a outer error boundary (S-RW6) | a frame error can freeze the scene silently; a scene component error shows the WebGL card | A: driver requests the next frame first, catches and logs frame errors, stops after 3 consecutive and sets `sceneError`; outer boundary shows a separate "The 3D view stopped after an error." card with Reload for scene errors; tests | none | approved | SQ11 answer "Catch, then an honest card (recommended)", 2026-10-13; scope: scene runtime error handling in 04a and the card's glass look in 04b; WebGL paths unchanged; applied to chunks 04a and 04b |
| UI-1 scene-error card copy (Claude, Section 11) | C23 card text "The 3D view stopped after an error."; D11 card style | C23 text as written | wording review next to the D11 card | approved | design review D2 board (variant C, rated 4) and D3 confirmation, 2026-10-13: compact card with inline icon, Sans body line, Reload + Copy error details, Mono error line with expand chevron; applied to chunk 04a |
| UI-2 focus ring on the full-viewport canvas (Claude, Section 11) | D21 2 px cyan focus ring; C19 focusable canvas | full-viewport ring | keep, inset, or a small focus badge | approved | design review D2 board (corner brackets, rated 4) and D3 confirmation, 2026-10-13: four small cyan corner brackets frame the visible canvas area while it has keyboard focus; applied to chunk 05 |
| UI-3 loader fade (Claude, 0G delight item 6) | D10 loader "until the first frame"; D20 `--dur-ui` | cut at first frame | fade over `--dur-ui` | approved | design review D6 (DR2) answer "2A Moving line, delay, fade (recommended)", 2026-10-13: indeterminate sweep, 300 ms delay, fade over `--dur-ui`, instant cut under reduced motion; applied to chunk 04b |

### Answered decision C15 (SQ2)

Answer: A, "Detect in 04a, style in 04b (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| WebGL detection, store `webgl` state, auto-restore | D11, S-RW1, S-RW6 (approved or required) | 04a | 04a | 04a | 04a |
| WebGL card look | D11 "glass card" (approved) | 04a, glass, but `GlassPanel` is built in 04b | 04a plain card with the D11 text; 04b gives it the glass look | 04a, glass | 04a, inline styles imitating glass |
| `GlassPanel` component | R12 (approved): 04b | 04b | 04b | 04a (adaptive fill stays in 04b) | 04b |
| "Restoring 3D view" toast | D11, D12 (approved); toast system in chunk 32 | 04a, no toast system exists | 04b minimal toast host (D12 placement, 6 s auto-dismiss); chunk 32 extends it | 04a minimal toast host; chunk 32 extends it | console line until chunk 32 |
| 04a acceptance on card and toast | 04a (approved) | not passable in order | store state and plain card in 04a; glass card and toast in 04b | passes as written | reworded to drop the toast |
| R12 split (04a scene, 04b UI shell) | re-review D1 A (approved) | as approved | kept; only the card's look moves | amended: `GlassPanel` and toast host move into 04a | kept |
| Effort | - | - | S | S | S |

Question: D2 — C15: How should chunk 04a get its WebGL card and restore toast, when the glass panel arrives in 04b and toasts in chunk 32?
Project/branch/task: Synapse Horizon, branch phase-2-scene-foundation, chunk 04a acceptance (design D11).
ELI10: Chunk 04a must show a glass error card when 3D cannot start and a "Restoring 3D view" toast when the graphics context resets. But the glass panel is built in the next chunk, 04b, and the toast system only in chunk 32, so 04a cannot pass its own checklist in the order written. We can split the work (detect in 04a, make it look right in 04b), pull the glass panel and a small toast host forward into 04a, or drop the toast until chunk 32.
Stakes if we pick wrong: 04a either cannot pass its acceptance, grows past one sitting, or ships the context-reset path with no message to the user for about 27 chunks.
Recommendation: A because every D11 behaviour still lands by 04b while 04a, already the largest chunk, does not grow, and chunk 32 extends one toast host instead of replacing a stand-in.
Completeness: A=9/10, B=9/10, C=6/10
Net: same result one chunk later (A), same result now in a bigger 04a (B), or a missing toast until chunk 32 (C).
Header: 04a order
A) Detect in 04a, style in 04b (recommended)
04a ships detection, the store `webgl` state, auto-restore and a plain full-viewport card with the D11 text; 04b gives the card the GlassPanel look and adds a minimal toast host (D12 placement, 6 s auto-dismiss) that shows "Restoring 3D view"; chunk 32 extends the same host. Effort S, risk low. ✅ Both chunks keep their approved scope and only the card's look moves to 04b ✅ Chunk 32 extends one toast host instead of throwing away a stand-in ❌ For the one chunk between 04a and 04b the WebGL card is plain, not glass
B) Pull GlassPanel and toasts into 04a
04a builds GlassPanel (without adaptive fill) and the minimal toast host, so its acceptance passes exactly as written; 04b keeps adaptive fill, layout shell, safeArea and loader. Effort S, risk low. ✅ 04a passes its acceptance word for word, glass card and toast included ✅ No plain-card interim between the two chunks ❌ 04a, already the largest chunk with the spike deletion, store and parameters, grows further
C) Keep as written, toast waits for chunk 32
04a imitates glass with inline styles and logs the context restore to the console; the toast arrives with chunk 32. Effort S, risk medium. ✅ No restructuring of the R12 split at all ✅ Smallest change to 04a's task list ❌ D11's "Restoring 3D view" message is missing for about 27 chunks, and 04a's acceptance still needs rewording

### Answered decision C16 (SQ3)

Answer: A, "Add to this plan's scope (recommended)", 2026-10-13.

Superseded details (spec reviews 1 and 2; the question below is kept as asked): ADR 0001 measured only Firefox near 120 Hz on this Mac, Chrome at 60 Hz (S-F7); the frame-count e2e in the grid is replaced by fake-clock unit tests at 60 to 144 Hz plus a calm-mode e2e (S-RW12, S-RW29); the cap paces by deadline accumulation (S-RW29).

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Render loop | ADR 0001 (R3F); R3F default `frameloop="always"` | every display refresh (up to 120 Hz in Chrome and Firefox on ProMotion) | R3F `frameloop="never"` driven by one `requestAnimationFrame` driver calling `advance()`, the pattern the spike measured | unchanged until the TODO is worked | unchanged |
| Frame cap | pending | none | 60 fps on any display | none | none |
| Calm mode | pending | none | after 5 s with no input, camera motion or glide, cap drops to 30 fps; any input returns to 60 within one frame [values estimated] | none | none |
| `powerPreference` | ADR 0001 settings (race only), S-RW3 | `"high-performance"` | `"default"` (a later decision under S-RW3) | `"high-performance"` | `"high-performance"` |
| Frame monitor (S-RW5) | required work | judged against the frame rate in force | same; a 30 fps calm cap never trips D10's 45 fps rule | same | same |
| Tests | pending | none | fake-clock unit tests (cap, calm entry and exit, hidden tab); Chromium e2e counts at most 61 frames in 1 s with `?dev=1` | none | none |
| HUD | S-RW4 | draw calls, fps | also shows cap and mode | unchanged | unchanged |
| Effort | - | - | S (human ~4h / CC ~20 min) | S (zero now) | S (zero) |

Question: D3 — C16: Add a frame-rate and power policy to chunk 04a?
Project/branch/task: Synapse Horizon, branch phase-2-scene-foundation, chunk 04a render loop.
ELI10: This dashboard is meant to sit open in a tab all day. As planned, the 3D scene redraws on every screen refresh, which is 120 times a second in Chrome and Firefox on your MacBook's screen, with bloom costing about 6.6 ms of GPU time per frame (ADR 0001), even when nothing moves. That drains battery and spins fans. The addition caps drawing at 60 frames a second, drops to 30 when you have not touched it for a few seconds, and stops asking for the faster graphics chip. Every later animation chunk builds on this loop, so it is cheap now and a retrofit later.
Stakes if we pick wrong: either the all-day tab costs real battery and fan noise from the first release, or a later loop change touches every animated chunk.
Recommendation: A because the render loop is the one thing chunks 20-35 all build their animations on, and the spike already proved the `frameloop="never"` driver, so this costs about 20 CC-minutes now.
Note: options differ in kind, not coverage — no completeness score.
Net: a calm, battery-friendly loop from day one (A), a tracked TODO with a retrofit later (B), or full-rate rendering always (C).
Header: Power
A) Add to this plan's scope (recommended)
04a drives R3F with `frameloop="never"` from one rAF driver: 60 fps cap on every display, 30 fps calm mode after 5 s without input or camera motion, `powerPreference: "default"`; the frame monitor judges against the cap in force; fake-clock unit tests and a frame-count e2e. Effort S (human ~4h / CC ~20 min), risk medium. ✅ The all-day tab draws at most half the frames on a 120 Hz screen, and a quarter when calm ✅ Animation chunks 20-35 inherit one loop with a known frame rate instead of each guessing ❌ Calm mode makes ambient animation look choppier at 30 fps, and the first frame after waking is up to 33 ms late
B) Defer to TODOS.md
Record the policy as a TODO with a trigger (before chunk 22, the first ambient-animation chunk); Phase 2 keeps R3F's default loop. Effort S (zero now), risk medium. ✅ Phase 2 stays exactly as scoped, and the loop is chosen once real animations exist ✅ No calm-mode tuning before there is anything moving to tune it against ❌ Switching the loop later touches every chunk that already animates, and testing runs uncapped until then
C) Skip
Keep R3F's default loop: render on every display refresh, `"high-performance"` GPU. Effort S (zero), risk high. ✅ Nothing to build, test or tune in the render loop ✅ Every frame is as smooth as the display allows ❌ The all-day tab renders up to 120 frames a second with bloom whether or not anything changes

### Answered decision C17 (SQ4)

Answer: A, "Add to this plan's scope (recommended)", 2026-10-13.

Placement superseded by C22 (SQ9): the look-dev view, baseline, mockup copy and images now live in chunk 04c (`04c-lookdev.png`); the content is unchanged.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| What the 04a look is tuned against | D14 (approved): "tuned to match the approved mockup" | a test cube and ground | a fixed look-dev vignette: hall slab and wall with a window strip, one 8-rack row with LEDs in all six D17 status colours, a cyan fibre segment, Claude and Codex trim swatches, ground grid; 04a rig, ortho camera, bloom on | test cube and ground | test cube and ground |
| View and shot | section 4 shots contract | `04a-scene.png` only | `?view=lookdev` plus `docs/img/04a-lookdev.png` | none | none |
| Regression guard on the look | pending | none | `toHaveScreenshot` baseline of the look-dev view in `vp run e2e:local` (Chromium, `maxDiffPixelRatio: 0.005` as in `e2e/repeat.spec.ts`) | none | none |
| Mockup in the repo | D14 mockup path outside the repo | `~/.gstack/.../variant-B-2.png`, this machine only | compressed copy at `docs/designs/variant-B-2.png` for side-by-side review in PRs | outside the repo | outside the repo |
| Later chunks | pending | none | chunks 06-10 add their new materials to the look-dev view | none | none |
| Effort | - | - | S (human ~3h / CC ~15 min) | S (zero now) | S (zero) |

Question: D4 — C17: Add a look-dev view with a baseline screenshot to chunk 04a?
Project/branch/task: Synapse Horizon, branch phase-2-scene-foundation, chunk 04a materials and lighting (design D14).
ELI10: Chunk 04a must tune the lights and materials "to match the approved mockup", but all it draws is a test cube on a ground plane, so nobody can tell whether the slate walls, window glow, rack LEDs and cyan lines look right. A look-dev view is a small fixed scene with one of each: a wall with windows, a row of racks with every status colour, a fibre line, the vendor trims. It gets its own screenshot, and a baseline test fails whenever a code change alters the look by accident. The mockup also moves into the repo so the comparison works on any machine.
Stakes if we pick wrong: the look drifts chunk by chunk with nothing to catch it, and 04a's "matches the mockup" is a judgement no one can check.
Recommendation: A because it turns an uncheckable acceptance into a picture and a failing test for about 15 CC-minutes, and every later world chunk reuses the same view.
Note: options differ in kind, not coverage — no completeness score.
Net: a checkable look from 04a on (A), a TODO until the campus exists (B), or tuning by eye on a cube (C).
Header: Look-dev
A) Add to this plan's scope (recommended)
04a adds `?view=lookdev`: a fixed vignette with one of each material under the 04a rig, captured as `04a-lookdev.png`, guarded by a `toHaveScreenshot` baseline in `e2e:local`, with a compressed copy of the mockup in `docs/designs/`; chunks 06-10 add their materials to it. Effort S (human ~3h / CC ~15 min), risk low. ✅ 04a's "matches the mockup" becomes a side-by-side picture in the PR instead of a claim ✅ Any accidental change to materials, lights or bloom fails a test before it merges ❌ Each deliberate look change needs a baseline update, and the baseline comes from headless Chromium's software renderer, not a GPU
B) Defer to TODOS.md
Record the look-dev view as a TODO with a trigger (before chunk 08, where D14 compares the campus to the mockup); 04a tunes against the cube. Effort S (zero now), risk medium. ✅ Phase 2 stays as scoped, and the view is built once there are real halls to show ✅ No baseline churn while the first materials are still being tuned ❌ Chunks 04a to 07 change materials with no picture or test to catch drift
C) Skip
Keep 04a as written: lighting and materials tuned by eye on a test cube; chunk 08 compares the campus to the mockup. Effort S (zero), risk medium. ✅ Nothing extra to build or maintain ✅ The look is judged once, on the full campus ❌ Material mistakes surface at chunk 08, after six chunks have used them

### Answered decision C18 (SQ5)

Answer: B, "Defer to TODOS.md (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Starting quality tier | 04a quality tier object (approved) | high on every machine | picked from a probe: about 1 s of frames at high behind the loader, first frames discarded (shader compile), mapped to high, medium or low [values estimated] | high | high |
| Runtime tier changes | S-RW5 (required), chunk 36 (approved) | frame monitor drops after 2 s of slow frames | unchanged; the probe only sets the start | unchanged | unchanged |
| Loader duration | D10 (approved): until the first frame | first frame | first frame plus the probe, about 1 s longer | first frame | first frame |
| Remembered pick | pending | none | stored per browser in localStorage, wrapped in try/catch (as the D13 legend does); rechecked when the monitor drops a tier | none | none |
| Tests | pending | none | fake-clock unit tests: probe maps intervals to tiers, ignores compile frames, survives blocked storage | none | none |
| Effort | - | - | S (human ~2h / CC ~10 min) | S (zero now) | S (zero) |

Question: D5 — C18: Add a startup quality probe to chunk 04a?
Project/branch/task: Synapse Horizon, branch phase-2-scene-foundation, chunk 04a quality tiers (design D10).
ELI10: The scene starts at the highest quality on every machine. On a slower laptop, the frame monitor notices after about 2 seconds of stutter and drops bloom or shadows. A probe would render about one second of frames behind the loading screen, judge the machine, and start at the right tier, remembering the pick for next time. The cost is a loading screen about a second longer and a little logic that has to ignore the slow first frames while shaders compile. Chunk 36 measures on an M1 Air-class Mac and could judge whether the startup stutter is real before anyone builds this.
Stakes if we pick wrong: either slower Macs see a short stutter on every launch, or every launch waits about a second for a probe that fast Macs never needed.
Recommendation: B because the stutter it prevents lasts about 2 seconds and has not been measured on target hardware yet; chunk 36 measures there and can pick this up with evidence.
Note: options differ in kind, not coverage — no completeness score.
Net: a smart start now (A), decided with M1 Air numbers in chunk 36 (B), or always start high (C).
Header: Start tier
A) Add to this plan's scope
04a renders about 1 s of frames at high behind the loader, discards the shader-compile frames, picks high, medium or low, and remembers the pick per browser in localStorage (try/catch); the frame monitor still adjusts at runtime. Effort S (human ~2h / CC ~10 min), risk medium. ✅ Slower Macs start at a tier they can hold, with no visible stutter and drop ✅ The remembered pick means the probe cost is paid once per browser ❌ The loader stays about a second longer on every first launch, and a cold GPU can make the probe pick too low
B) Defer to TODOS.md (recommended)
Record the probe as a TODO with a trigger: chunk 36 shows a visible startup stutter on the M1 Air-class Mac. Phase 2 starts at high and relies on the frame monitor. Effort S (zero now), risk low. ✅ Built only if target-hardware numbers show the stutter it fixes ✅ Phase 2 keeps D10's loader exactly as approved, ending at the first frame ❌ Until then, a slower Mac may stutter for about 2 s before the monitor drops a tier
C) Skip
Always start at high and let the frame monitor and chunk 36's tiering adjust at runtime. Effort S (zero), risk low. ✅ Nothing extra to build, test or remember ✅ Simplest startup path, matching D10 exactly ❌ The startup stutter on slower Macs is never addressed by design

### Answered decision C19 (SQ6)

Answer: A, "Add to this plan's scope (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Keyboard path into the scene | D22 (approved): table rows and search results, Enter glides | rows and search only (chunks 24, 32) | unchanged, plus direct camera keys | unchanged | unchanged |
| Camera keys while the canvas has focus | pending | none | arrows pan, `+` and `-` zoom, `Q` and `E` rotate 45 degrees, `0` or Home glides to the home view; keys act only while the canvas (`role="application"`) has focus and never while typing in inputs | none | none |
| Motion | D20 (approved), C16 (approved) | - | steps use the D20 easing over `--dur-ui`; instant under `reducedMotion`; a key press counts as input for calm mode | - | - |
| Shortcut conflicts | chunk 25 (approved): 1-4, `/`, D, W, Esc, `?` | - | none; chunk 25's help overlay lists the camera keys | - | - |
| Home view | chunk 05 `cameraRig` (approved) | none | `cameraRig.home()`: glide to the whole campus framed in the `safeArea` | none | none |
| Tests | pending | none | unit test of the key map and focus gate; e2e in three engines: focus canvas, press keys, camera moves and stays in bounds | none | none |
| Effort | - | - | S (human ~2h / CC ~10 min) | S (zero now) | S (zero) |

Question: D6 — C19: Add keyboard camera controls to chunk 05?
Project/branch/task: Synapse Horizon, branch phase-2-scene-foundation, chunk 05 camera controls (design D22).
ELI10: Chunk 05 moves the camera with the mouse and trackpad only. The plan's keyboard access (D22) lets you reach things through the table and search, but there is no way to look around the campus without a mouse. The addition lets the arrow keys pan, plus and minus zoom, Q and E rotate, and 0 or Home fly back to the full campus, but only while the 3D view has focus, so the keys never clash with typing or chunk 25's shortcuts.
Stakes if we pick wrong: keyboard-only users can jump to an object but cannot look around the campus, and retrofitting keys later means re-testing every shortcut chunk 25 adds.
Recommendation: A because D22 already makes the canvas a focusable application, so the keys cost about 10 CC-minutes and close the one gap in keyboard access to the scene.
Note: options differ in kind, not coverage — no completeness score.
Net: full keyboard navigation from chunk 05 (A), tracked for later (B), or mouse-only camera (C).
Header: Keys
A) Add to this plan's scope (recommended)
Chunk 05 adds camera keys while the canvas has focus: arrows pan, `+`/`-` zoom, `Q`/`E` rotate 45 degrees, `0` or Home glides to `cameraRig.home()`; steps use the D20 easing (instant under `reducedMotion`) and count as input for calm mode; chunk 25's help overlay lists them. Effort S (human ~2h / CC ~10 min), risk low. ✅ Keyboard-only users can look around the whole campus, not only jump to rows ✅ A home key gives every user a one-press way back after getting lost ❌ Six more keys for chunk 25's shortcut list to document and keep free of clashes
B) Defer to TODOS.md
Record keyboard camera controls as a TODO with a trigger: chunk 37's accessibility audit, or before chunk 25 fixes the shortcut map. Effort S (zero now), risk low. ✅ Chunk 05 stays mouse and trackpad only, as scoped ✅ The full shortcut map is designed once, with chunk 25's keys in view ❌ Until then the scene has no keyboard navigation of its own
C) Skip
Keep the camera mouse and trackpad only; keyboard users reach objects through the table and search (D22). Effort S (zero), risk medium. ✅ Nothing extra to build or test in chunk 05 ✅ Fewer keys to document and keep free of clashes ❌ Looking around the campus stays impossible without a pointing device

### Answered decision C20 (SQ7)

Answer: A, "Add to this plan's scope (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Scroll zoom target | chunk 05 (approved): ortho zoom, clamped | zooms about the screen centre | zooms toward the point under the cursor, still clamped to bounds and zoom range | screen centre | screen centre |
| Pan and rotate feel | chunk 05 (approved) | stops dead on release | light damping (eases to a stop over about 250 ms [estimated]); off under `reducedMotion`; the loop stays at 60 fps while the camera settles (C16) | stops dead | stops dead |
| Double-click on empty ground | chunk 24 (approved): double-click on an entity zooms close | nothing | glides to `cameraRig.home()` (C19) | nothing | nothing |
| Glide interruption | chunk 05 (approved): cancels on drag | cancels on drag | unchanged; damping stops on a new drag or glide | unchanged | unchanged |
| Tests | pending | none | unit test: zoom-to-cursor keeps the world point under the cursor fixed, within bounds; e2e: scroll over a corner moves it toward the centre less than a centre zoom would | none | none |
| Effort | - | - | S (human ~2h / CC ~10 min) | S (zero now) | S (zero) |

Question: D7 — C20: Add map-style feel to chunk 05's camera controls?
Project/branch/task: Synapse Horizon, branch phase-2-scene-foundation, chunk 05 camera controls.
ELI10: Map apps zoom toward wherever your cursor is, glide to a stop when you let go, and give you a quick way home. As planned, chunk 05 zooms about the middle of the screen and stops dead when you release the mouse. The addition makes scroll zoom aim at the cursor, adds a short ease-out when you let go of a pan or rotate, and makes a double-click on empty ground fly back to the full campus. Damping keeps the frame rate at 60 for a moment after you let go, which the power policy already allows.
Stakes if we pick wrong: zooming into a hall at the edge of the screen takes a zoom plus a pan every time, and the camera feels stiff next to the map apps people know.
Recommendation: A because zoom-to-cursor removes a pan from the most common move, and all three behaviours sit inside chunk 05's controls for about 10 CC-minutes.
Note: options differ in kind, not coverage — no completeness score.
Net: map-app feel from chunk 05 (A), tracked for later (B), or plain controls (C).
Header: Map feel
A) Add to this plan's scope (recommended)
Chunk 05 zooms toward the cursor (clamped to bounds and zoom range), adds light damping to pan and rotate (off under `reducedMotion`), and glides to `cameraRig.home()` on a double-click on empty ground; a unit test pins the zoom-to-cursor maths. Effort S (human ~2h / CC ~10 min), risk low. ✅ Zooming into any hall takes one gesture instead of a zoom plus a pan ✅ The camera feels like the map apps people already know ❌ Damping keeps the loop at 60 fps for a moment after each release, and zoom-to-cursor needs care at the bounds
B) Defer to TODOS.md
Record map feel as a TODO with a trigger: after chunk 08, once there is a campus to navigate. Effort S (zero now), risk low. ✅ Chunk 05 stays exactly as scoped ✅ Feel is tuned against a real campus instead of a test cube ❌ Controls get reworked after chunks 06-08 have been built and screenshotted on them
C) Skip
Keep chunk 05's controls as written: centre zoom, no damping, no double-click home. Effort S (zero), risk low. ✅ Fewest moving parts in the camera code ✅ No damping frames to account for in the power policy ❌ Every zoom toward an off-centre hall needs a second pan gesture

### Answered decision C21 (SQ8)

Answer: A, "White tint over dark underlay (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Night panel fill | design D18 "8% white fill"; D21 "night 8%" (both approved) | ambiguous | 8% white tint, no dark underlay (exactly D18) | 8% dark (`--color-bg`) | 8% white tint (exactly D18) |
| Dusk, day, day + heatwave | D21 levels 30%, 60%, 72% dark; R13 lookup (approved) | ambiguous | 8% white tint over a dark underlay at 30%, 60%, 72% | dark fill at 30%, 60%, 72% | dark fill at 30%, 60%, 72%, white tint removed |
| What `glassFill` returns | S-RW9, S-RW15 (required) | one number | underlay alpha (0, 0.30, 0.60, 0.72); tint fixed | fill alpha (0.08, 0.30, 0.60, 0.72) | fill colour and alpha per level |
| Night to dusk change | D20 motion (approved) | - | the underlay darkens smoothly | the fill darkens smoothly | colour flips from white tint to dark fill |
| Border, blur, 85% solid fallback | D18 (approved) | 12% white border, backdrop blur, solid 85% dark under 45 fps | unchanged | unchanged | unchanged |
| D21 contrast check at every level | D21, S-RW9 (approved, required) | night in 04b, day and night in 34, heatwave in 35 | unchanged | unchanged | unchanged |
| Effort | - | - | S | S | S |

Question: D8 — C21: What should the glass panel fill be at each brightness level?
Project/branch/task: Synapse Horizon, branch phase-2-scene-foundation, chunk 04b GlassPanel and adaptive glass (design D18, D21).
ELI10: Two approved design notes disagree. D18 says the glass panel has an 8% white fill. D21 says the fill steps "from 8% up to 72% dark" as the scene gets brighter: night 8%, dusk 30%, day 60%, day with a heatwave 72%. So is a night panel lightly white or lightly dark, and is a daytime panel dark glass or something else? The builder needs one rule before writing the glass panel that every later panel uses.
Stakes if we pick wrong: every panel in chunks 26-33 inherits the fill, so changing it later means retuning contrast across the whole dashboard.
Recommendation: A because it keeps both approved notes true at once: a night panel is exactly D18's 8% white glass, and brighter scenes add a dark layer underneath that deepens smoothly, with no colour flip at dusk.
Note: options differ in kind, not coverage — no completeness score.
Net: two layers that honour both notes (A), dark glass at every level (B), or a white-to-dark switch at dusk (C).
Header: Glass fill
A) White tint over dark underlay (recommended)
Every panel keeps D18's 8% white tint; under it sits a dark layer in `--color-bg` whose alpha follows the table: night 0%, dusk 30%, day 60%, day + heatwave 72%. `glassFill` returns the underlay alpha. Effort S, risk low. ✅ Night panels look exactly like the approved D18 glass and the mockup ✅ Brighter scenes deepen the same panel smoothly, with no colour change at dusk ❌ D21's "night 8%" now names the white tint, not a dark level, which the plan text must say plainly
B) Dark fill only
Panels use one dark fill in `--color-bg` at 8%, 30%, 60% and 72%, read literally from D21; D18's white tint is dropped and the 12% white border stays. Effort S, risk medium. ✅ One layer and one number per level, the simplest panel to build ✅ Matches D21's table word for word ❌ Night panels lose D18's frosted look and read as nearly clear glass over a dark scene
C) White at night, dark from dusk
Night panels use D18's 8% white fill; from dusk on, the fill switches to dark at 30%, 60% and 72%. Effort S, risk medium. ✅ Night matches D18 exactly and daytime matches D21's dark levels ✅ Each level is a single fill, easy to reason about ❌ The panel changes colour at the dusk step, which shows as a visible flip during the day/night cycle

### Answered decision C22 (SQ9)

Answer: A, "Split into 04a core + 04c look (recommended)", 2026-10-13.

Size after the split [measured: `wc -w` on the chunk text]: 04a 1,319 words, 04b about 520, 04c 347, 05 about 480. The 04a text grew again with the second spec review's fixes, which are mostly acceptance and failure detail rather than new work items, so 04a remains the largest chunk; the C22 option's "fits a sitting again" is not yet shown. Flagged for `/plan-eng-review` to check 04a's size.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Spike promote and delete, store, parameters, render loop and power (C16), frame monitor, WebGL detection and restore, first-frame signal and `freeze`, canvas, camera with ortho/perspective toggle, perf HUD, quality tier, motion tokens and `reducedMotion`, test cube and ground | approved (04a, S-RW, C15, C16) | 04a | 04a "Scene core" | 04a | 04a plumbing (loop, store, params, monitor, WebGL) and a second chunk for camera, HUD and tiers |
| Lighting rig, material library, ground grid look, look-dev view, baseline and mockup copy, `04a-scene.png` and `04a-lookdev.png` | approved (04a, D14, C17) | 04a | new chunk 04c "Look", depending on 04a; images become `04c-scene.png` and `04c-lookdev.png` | 04a | a third chunk "Look" |
| Order and dependencies | R12: 04a, then 04b, then 05; 06 depends on 05 | 04a, 04b, 05 | 04a, then 04b and 04c (both need only 04a), then 05; 06 depends on 04c and 05 | unchanged | four chunks before 05 |
| PRs (D18: one per chunk) | approved | 3 in Phase 2 | 4 | 3 | 5 |
| Effort to amend the plan | - | - | S (human ~30 min / CC ~3 min) | S (zero) | S (human ~45 min / CC ~5 min) |

Question: D9 — C22: Split chunk 04a again, now that it has grown?
Project/branch/task: Synapse Horizon, branch phase-2-scene-foundation, chunk 04a size.
ELI10: Chunk 04 was split once because it was about three times a normal chunk. This review then added the fixes and additions you approved, mostly to 04a, which is now about 1,240 words of tasks against about 100 for a typical chunk. That is several sittings with no runnable checkpoint in between. The natural cut is between plumbing and looks: 04a builds the canvas, store, render loop, error handling and camera on a test cube; a new 04c tunes the lights and materials with the look-dev view. Nothing is added or removed.
Stakes if we pick wrong: 04a runs over several sittings with half-finished work and no checkpoint, or the plan gains one more PR to track.
Recommendation: A because it restores the one-sitting rule at the place the work naturally divides, and the look work can run beside 04b since both need only 04a.
Note: options differ in kind, not coverage — no completeness score.
Net: two clean checkpoints (A), one large chunk (B), or three small ones with more PR overhead (C).
Header: 04a split
A) Split into 04a core + 04c look (recommended)
04a "Scene core": spike promote and delete, store, parameters, render loop and power, frame monitor, WebGL detection and restore, first-frame signal, canvas, camera and toggle, HUD, quality tier, motion tokens, test cube and ground. New 04c "Look": lighting rig, materials, look-dev view, baseline, mockup copy and the two images. 04b and 04c both depend on 04a; 06 depends on 04c and 05. Effort S (human ~30 min / CC ~3 min), risk low. ✅ Each chunk fits a sitting again and ends in something runnable and testable ✅ Look tuning, which is slow visual work, can run beside the 04b shell ❌ One more PR, chunk number and README image step to track
B) Keep one 04a
Leave 04a as amended: one chunk, one PR, about 1,240 words of tasks. Effort S (zero), risk medium. ✅ No renumbering, and the scene foundation lands in one commit ✅ One acceptance pass covers plumbing and look together ❌ Breaks the one-sitting rule by a wide margin, with no checkpoint between plumbing and look
C) Split into three
04a plumbing (spike, store, parameters, loop, monitor, WebGL handling), a second chunk for camera, HUD and quality tiers, and 04c look. Effort S (human ~45 min / CC ~5 min), risk low. ✅ The smallest chunks, each quick to review ✅ Camera work gets its own checkpoint before the look ❌ Five Phase 2 PRs, and the camera chunk has little to show on screen without the look

### Scope document approval (Phase 2)

SQ10 answer "Approve and continue (recommended)", 2026-10-13: the working plan (this file, Phase 2 chunks 04a, 04b, 04c, 05 and this record) and the CEO summary (`~/.gstack/projects/bjorkgard-ai-center/ceo-plans/2026-10-13-phase-2-scene-foundation.md`) are approved as of that answer. Spec review: 3 refuter runs, scores 6, 7, 7; Scope PASS in all three; issues verified: 12 of 12 for the third run's findings (applied edits, checked by Claude, not re-reviewed: spec not re-verified after the last fixes). Metrics appended to `~/.gstack/analytics/spec-review.jsonl` (iterations 3, found 36, fixed 23, remaining 12, score 7).

### 0I. Temporal interrogation (Phase 2)

```text
  HOUR 1 (foundations):   zustand + store slices (src/app/store/); params module from the spike parser;
                          promote RENDER, composer boundary, draw-call counter, material guard to src/scene/;
                          delete the rest of src/spike/ and e2e/spike.spec.ts; confirm WebGL2 in CI (S-RW30)
  HOUR 2-3 (core logic):  Canvas frameloop="never" + rAF driver (deadline pacing, calm mode, hidden tab);
                          frame monitor (windowed mean, hysteresis, simulate hook); webgl state machine
                          (pre-check, outer boundary, restore, 10 s timeout, late restore); camera module
                          with ortho and perspective ranges; HUD with the draw-call split
  HOUR 4-5 (integration): ready signal into shots, repeat spec and smoke; freeze=1 re-render; 04b shell,
                          GlassPanel two-layer fill, safeArea, loader, toast host; 04c rig, materials,
                          look-dev project with committed baseline; 05 MapControls, clamps, glide, keys
  HOUR 6+ (polish/tests): fake-clock suites (pacing at 60-144 Hz, monitor, webgl timeout, key map, zoom
                          maths); e2e in three engines; contrast helper at night; shots and README images
```

What will surprise the implementer:
- R3F `frameloop="never"` turns `invalidate()` into a no-op; every frame comes from the driver. Use no library that relies on `invalidate()` (drei is not added).
- Headless Chromium drives rAF at 60 Hz, so the 60 fps cap can only be proven in fake-clock tests (S-RW12, S-RW29).
- Safari on macOS delivers trackpad pinch as `gesturestart`/`gesturechange` events, and an unhandled pinch can zoom the page instead of the scene [unverified on Safari 27]; chunk 05 must check pinch zoom in Safari explicitly (its acceptance already requires trackpad zoom in all three browsers).
- Writing `safeArea` to the store straight from a ResizeObserver callback can raise "ResizeObserver loop completed with undelivered notifications", which Playwright reports as a page error (Section 1, A-2).
- The look-dev baseline is rendered by headless Chromium on the Mac; it is a regression guard, not a GPU-accurate picture.

Feasibility blockers: none found. Open verifications with owners: WebGL2 in CI browsers (04a, S-RW30); composer behaviour after a context restore (04a, S-RW31); Safari pinch (05).

Effort [estimated, task-type ratios: features ~30x, tests ~50x]: 04a human ~2 days / CC ~1.5 h; 04b human ~1 day / CC ~45 min; 04c human ~1 day of tuning / CC ~30 min plus human look review; 05 human ~1 day / CC ~45 min.

### Section 1: Architecture (Phase 2)

```text
  URL ──► src/app/params.ts (allowlist) ──► dev, webgl, calm, view, freeze, seed ...
                     │
                     ▼
  src/app/store/ (zustand: ui slice now; data slices from chunk 11)
     ui: reducedMotion · quality · webgl · safeArea
       ▲          ▲            ▲            ▲
       │          │            │            └── 04b Shell: ResizeObserver + panel toggles
       │          │            └── src/scene/webgl: pre-check · outer boundary · restore · 10 s timeout
       │          └── src/scene/loop/monitor: windowed mean ──► bloom off (D10) · glass solid (D18)
       └── matchMedia(prefers-reduced-motion) change listener
                     │
  src/scene/loop/driver (rAF, deadline pacing, calm mode) ──► R3F Canvas frameloop="never" advance(t)
                     │                                           ├── scene graph (04a cube, 04c look)
                     │                                           ├── composer in inner boundary (bloom)
                     │                                           └── HUD (dev=1): draw-call split, cap, tier
                     ▼
  ready signal (data-scene-ready, __sceneReady) ──► 04b Loader · shots · repeat spec · smoke
  src/scene/camera (ortho + perspective ranges) ◄── 05 MapControls + clamps ◄── keys, wheel, drag
                     ▲
  05 cameraRig: glideTo · home ── reads safeArea (transient subscribe)
  04b GlassPanel ── glassFill(phase, weather) (night, clear until chunks 34-35)
  04b ToastHost ── webgl === 'restoring' ──► "Restoring 3D view" (chunk 32 extends)
```

State machines (new stateful objects):

```text
  webgl:   ok ──contextlost──► restoring ──restored──► ok
           restoring ──10 s, no restore──► unavailable ──late restore──► ok
           (start) ──pre-check fails / Canvas rejects──► unavailable
           Not allowed: unavailable ──► restoring without a new contextlost; ok ──► unavailable
           except through a failed pre-check, a Canvas rejection or the timeout.

  driver:  active (cap 60) ──5 s without input, camera motion or glide──► calm (cap 30)
           calm ──any input / glide / damping──► active (within one frame)
           active | calm ──tab hidden──► paused (no rAF) ──visible──► previous mode, monitor ignores first frames
           freeze=1: frozen (one frame; re-render on resize or restore only)

  quality: normal ──mean > 1.33 x cap interval for 2 s──► degraded (bloom off, glass solid)
           degraded ──mean < 1.08 x cap interval for 10 s──► normal
           Not allowed: flapping inside the hysteresis windows; judging while paused or frozen.

  camera:  idle ──drag/wheel/key──► user ──release──► damping ──settled──► idle
           any ──glideTo/home──► gliding ──done──► idle; gliding ──drag or new glide──► user | gliding(new)
```

- Coupling: scene, shell and camera rig meet only in the store (`safeArea`, `webgl`, `quality`, `reducedMotion`); before, the app had no shared state. Justified by D11 (one store). Chunk 11 now depends on 04a for the store module (S-RW1).
- Scaling: there is no data in Phase 2. The first thing to break at 10x panels is `safeArea` churn during a window drag (every panel and the rig react); A-2 coalesces updates to one per frame.
- Single points of failure: the rAF driver. If one frame throws before the next frame is requested, the scene freezes with no message (A-1).
- Security architecture: no endpoints or data mutations; see Section 3.
- Rollback: each chunk is one PR (D18); revert it. The spike deletion in 04a is the only removal, and ADR 0001 and its results stay.
- Value test: the perf HUD and the look-dev view are product tooling consumed by the developer and by e2e (`04a-core.png`, the baseline); the look-dev view stays as the material regression guard, so it does not retire.
- Elegance and platform: four small modules (`app/params`, `app/store`, `scene/loop`, `scene/webgl`) are what every later chunk plugs into; README "Architecture" names them (04a README step).
- Cherry-pick fit: C16's `frameloop="never"` fits C20's damping because settling counts as camera motion (S-RW16); C19's keys share the rig's glide; C17 sits outside the render path. No accepted cherry-pick adds coupling beyond the store.

Findings:
- A-1 [P1] (confidence 8/10) A frame that throws inside `advance()` (a `useFrame` callback, a material update) can end the rAF chain if the next frame was not yet requested; the scene freezes and nothing tells the user. R3F's own loop is off under `frameloop="never"`, so this is now the driver's job. Pending: C23 (Section 2).
- A-2 [P2] (confidence 7/10) Writing `safeArea` from a ResizeObserver callback can trigger the browser's "ResizeObserver loop" error, which the smoke test counts as a page error. Required for the 04a/04b smoke acceptance ("no console errors"); applied as S-RW36.
- A-3 [P2] (confidence 8/10) `glideTo` frames its target inside `safeArea` when the glide starts; a panel that opens during the 600 ms glide leaves the target behind the panel, breaking the section 4b invariant "a selected object is never behind a panel". Required for that invariant (D5); applied as S-RW37.
- A-4 [P3] Under `frameloop="never"`, R3F's `invalidate()` does nothing; recorded as an implementer note in 0I. No change.

Section 1 dispositions: A-1 resolved by C23 (SQ11); A-2 applied (S-RW36); A-3 applied (S-RW37); A-4 note.


### Section 2: Error & Rescue Map (Phase 2)

```text
  METHOD/CODEPATH             | WHAT CAN GO WRONG                                  | ERROR
  ----------------------------|----------------------------------------------------|---------------------------
  app/params.parse            | unknown value, malformed number, unknown view      | InvalidParam
  scene/webgl precheck        | no WebGL2 context                                  | WebGLUnavailable
  R3F Canvas create           | renderer promise rejects                           | CanvasInitError
  composer (inner boundary)   | EffectComposer throws on mount or remount          | ComposerError
  context events              | webglcontextlost                                   | ContextLost
                              | no webglcontextrestored within 10 s                | RestoreTimeout
                              | restore after the timeout                          | LateRestore
  scene/loop driver tick      | advance() or a useFrame callback throws            | FrameError        <- C23
  scene components (React)    | a component throws while rendering                 | SceneRenderError  <- C23
  scene/loop monitor          | sustained slow frames                              | SlowFrames
                              | tab hidden, window resized                         | (frames ignored)
  shell safeArea              | ResizeObserver loop                                | ROLoop (prevented, S-RW36)
                              | rect smaller than 1 px (window below 1280x720)     | EmptySafeArea
  cameraRig.glideTo / home    | target outside bounds, zoom outside range          | (clamped)
                              | safeArea changes mid-glide                         | (retarget, S-RW37)
  look-dev baseline           | pixels differ                                      | BaselineMismatch (intended)

  ERROR              | RESCUED | RESCUE ACTION                                   | USER SEES
  -------------------|---------|-------------------------------------------------|------------------------------------
  InvalidParam       | Y       | fallback value, one console warning              | nothing; warning names the parameter
  WebGLUnavailable   | Y       | webgl = unavailable, loader ends                 | D11 card (plain in 04a, glass in 04b)
  CanvasInitError    | Y       | outer boundary, webgl = unavailable              | D11 card
  ComposerError      | Y       | inner boundary, bloom off, console.warn          | scene without bloom; HUD shows bloom off
  ContextLost        | Y       | webgl = restoring                                | "Restoring 3D view" toast (04b)
  RestoreTimeout     | Y       | webgl = unavailable                              | D11 card
  LateRestore        | Y       | webgl = ok, card hides, rendering resumes        | scene returns
  FrameError         | Y (C23) | catch, log once, continue; 3 in a row: stop      | nothing for one-offs; scene-error card
                     |         | and set sceneError                               | after 3 consecutive failures
  SceneRenderError   | Y (C23) | outer boundary, sceneError                       | "The 3D view stopped after an error." + Reload
  SlowFrames         | Y       | degraded tier, hysteresis                        | no bloom, solid glass
  EmptySafeArea      | Y       | frame inside the full canvas, console.warn       | target framed in the full canvas (S-RW38)
  BaselineMismatch   | Y       | test fails; update baseline on purpose           | failing e2e:local run
```

- E-1 [P1] (confidence 8/10) FrameError and SceneRenderError were the gaps (Section 1 A-1). Resolved by C23 (SQ11).
- E-2 [P3] (confidence 7/10) A window smaller than the supported 1280x720 with the right panel open can leave a `safeArea` with no width; required for the D5 framing contract not to divide by zero; applied as S-RW38 (frame inside the full canvas, one console warning).
- Logging: each rescued error logs one line with its kind and context (Section 8 sets the format).

### Answered decision C23 (SQ11)

Answer: A, "Catch, then an honest card (recommended)", 2026-10-13.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Next frame requested before the frame runs | Prime Directive 1 (pending) | not stated | yes | yes | not stated |
| Frame error handling | pending | not stated; a throw can end the rAF chain | caught per frame; each distinct message logged once with `console.error` and the frame time; HUD error count; rendering continues | same as A | none |
| Repeated frame errors | pending | - | after 3 consecutive failing frames [estimated], the driver stops and raises the scene-error state | same as A, but the state shows the WebGL card | - |
| React error in a scene component | S-RW6 outer boundary (required) | outer boundary shows the WebGL card | outer boundary tells kinds apart: scene error shows a separate card, "The 3D view stopped after an error." with the message and a Reload button; panels keep working; loader ends | outer boundary shows the D11 WebGL card text | same as B |
| WebGL unavailable, restore, timeout | D11, S-RW6, S-RW10, S-RW33 (approved or required) | unchanged | unchanged | unchanged | unchanged |
| Tests | pending | none | fake-clock unit tests: a throwing frame callback keeps the loop alive and logs once; 3 consecutive throws raise the state; a throwing component shows the scene-error card, not the WebGL card | same, asserting the WebGL card | none |
| Effort | - | - | S (human ~2h / CC ~10 min) | S (human ~1.5h / CC ~8 min) | S (zero) |

Question: D11 — C23: What should happen when scene code fails while the app is running?
Project/branch/task: Synapse Horizon, branch phase-2-scene-foundation, chunk 04a render loop and error boundary.
ELI10: The plan handles the graphics card failing (WebGL off, context lost), but not a bug in our own scene code. With the new render loop, an error inside one frame can stop the loop for good: the scene freezes and nothing says why. A crash inside a scene component falls into the error boundary that shows "Your browser could not start 3D", which blames the browser for our bug. Option A keeps the loop alive through a one-off error, stops after repeated errors, and shows an honest "3D view stopped after an error" card with a Reload button, while the panels keep working.
Stakes if we pick wrong: a scene bug either freezes the campus with no message, which looks like live data that stopped changing, or tells users their browser cannot do 3D when it can.
Recommendation: A because it closes both silent-failure paths and names the real cause for about 10 CC-minutes (zero silent failures, every error has a user-visible result and a test).
Completeness: A=9/10, B=6/10, C=3/10
Net: honest error states with tests (A), caught but mislabelled (B), or a freeze and a wrong message (C).
Header: Scene errors
A) Catch, then an honest card (recommended)
The driver requests the next frame first, catches frame errors, logs each distinct message once and keeps rendering; after 3 consecutive failing frames it stops and raises a scene-error state. The outer boundary shows a separate card, "The 3D view stopped after an error.", with the message and Reload; panels keep working and the loader ends. Fake-clock and component tests. Effort S (human ~2h / CC ~10 min), risk low. ✅ No scene bug can freeze the campus silently; one-off glitches do not even interrupt it ✅ Users see the real cause and a one-click recovery, and the console has the message ❌ One more card and state for chunk 04b to style and for the design review to word
B) Catch, reuse the WebGL card
Same frame-error catching and 3-strike stop, but scene errors show the existing D11 card ("Your browser could not start 3D (WebGL)."). Effort S (human ~1.5h / CC ~8 min), risk medium. ✅ No silent freeze, and no new card to design or style ✅ Same tests for the loop as A ❌ The card blames the browser for our own bug, so users may switch browsers instead of reporting it
C) Keep as written
No frame-error handling; React errors in scene components show the WebGL card through the outer boundary. Effort S (zero), risk high. ✅ Nothing extra to build in 04a ✅ The plan text stays unchanged ❌ A single thrown frame freezes the campus with no message, which reads as live data that stopped


### Section 3: Security & threat model (Phase 2)

| Threat | Likelihood | Impact | Mitigated? |
|---|---|---|---|
| New runtime dependency `zustand` | Low | Low | Yes: MIT, widely used, lockfile, Dependabot weekly (X2) |
| URL parameters read in production (`dev`, `webgl`, `calm`, `view`, `freeze`, `seed`, ...) | Low | Low | Yes: allowlist with fallback (S-RW2); values go to the console only, never into the DOM |
| `window.__sceneDev.simulateFrameInterval` and `window.__sceneReady` in the production bundle | Low | Low | Accepted: the hook exists only with `dev=1`, is same-origin, and changes only the quality tier; no data |
| Scene-error card shows an error message (C23) | Low | Low | Yes: message only, no stack; React escapes text, so no markup injection |
| Committed mockup copy in a public repo (C17) | Low | Low | Accepted: an approved design image with made-up data [inference: AI-generated mockup] |

No endpoints, secrets, stored data, background jobs or network calls are added; nothing leaves localhost (D16). localStorage is not used in Phase 2 (C18 deferred). No issues found beyond the table.

### Section 4: Data flow and interaction edge cases (Phase 2)

```text
 prefers-reduced-motion ─► matchMedia + change listener ─► store.reducedMotion ─► glide, damping, keys, D20 tokens
   nil: matchMedia missing ─► false        changed at runtime ─► listener updates the flag live
 window resize / panel toggle ─► ResizeObserver ─► coalesce to 1 per rAF ─► store.safeArea ─► cameraRig (transient)
   empty: rect has no width or height ─► full canvas + warning (S-RW38)   stale: changed mid-glide ─► retarget (S-RW37)
   storm: 60 resize events per second ─► at most 1 store write per frame (S-RW36)
 rAF ─► driver (pace, calm, freeze, hidden) ─► advance(t) ─► monitor (windowed mean) ─► quality ─► bloom, glass
   hidden: no rAF ─► paused     first frames after visible or resize ─► ignored     freeze ─► monitor paused (S-RW34)
   error: frame throws ─► caught, logged once, continue; 3 in a row ─► sceneError (C23)
 webglcontextlost ─► webgl=restoring ─► toast   restored ─► composer remount ─► ok   10 s ─► unavailable ─► card
   late restore ─► ok (S-RW33)   remount throws ─► inner boundary ─► bloom off (S-RW31)
```

Async ordering:
- Invariant 1 (section 4b, D5): a glide ends with its target inside the `safeArea` in force at the end. Operations: glide (600 ms) and a `safeArea` write (coalesced to the next frame). Order A: write lands before the glide starts, so the glide uses the new rect. Order B: write lands mid-glide, so the glide retargets (S-RW37). Order C: chunk 24 opens the panel and starts the glide in the same tick, so the glide starts with the old rect and retargets one frame later when the coalesced write lands (S-RW37). Regression proof: the S-RW37 rig unit test with a fake clock releases the `safeArea` write before, during and in the same tick as the glide.
- Invariant 2 (D11): exactly one of `ok` or `unavailable` holds after a lost context settles. Operations: the restore event and the 10 s timer. Order A: restore first, timer cleared, `ok`. Order B: timer first, `unavailable`, then a late restore returns `ok` (S-RW33). Regression proof: the S-RW10 fake-clock tests fire restore at 9.99 s and 10.01 s.

| Interaction | Edge case | Handled? | How |
|---|---|---|---|
| Drag pan or rotate | pointer leaves the window mid-drag | Y | MapControls pointer capture |
| Right-drag rotate | context menu | Y | suppressed (05 acceptance) |
| Wheel or trackpad zoom | fast wheel, trackpad momentum | Y | zoom range clamp (05) |
| Safari trackpad pinch | page zooms instead of the scene | Verify | owner chunk 05; recorded in 0I [unverified] |
| Double-click empty ground | during a glide | Y | new glide replaces the old (camera state machine) |
| Double-click an entity (chunk 24) | home glide in flight | Y | entity double-click cancels it (S-RW25) |
| Camera keys | held key auto-repeat | Y | each repeat restarts a short step; latest wins, nothing queues |
| Camera keys | typing in an input | Y | focus gate (C19) |
| Perspective toggle (`P`, HUD) | pressed during a glide | Gap | S-RW39: the toggle cancels the glide and keeps the current framing |
| HUD toggle button | double click | Y | the toggle is a state flip; the second click flips back |
| Window resize | during a glide | Y | S-RW37 |
| Tab hidden | during a glide | Y | the glide is time-based and ends on the first visible frame |
| `?webgl=0&freeze=1` | no frame ever renders | Y | loader ends on `unavailable` (S-RW19); card shows |

- D-1 [P3] (confidence 7/10) A perspective toggle during a glide was undefined; required for the "toggle switches without jump" acceptance (04a); applied as S-RW39.

### Section 5: Code quality (Phase 2)

- Q-1 [P3] The driver's per-frame decision (hidden, freeze, cap, calm, error count) has more than 5 branches; keep it a pure function of state and time so the fake-clock tests drive it directly. Implementation note for 04a; no plan change.
- Q-2 [P3] The outer boundary must tell WebGL failures from scene errors by error class (thrown by the pre-check and the Canvas init path), not by matching message text. Implementation note for C23; no plan change.
- Q-3 [P3] The parameter allowlist and the shots URL builder (`scripts/shots.config.ts` `viewUrl`) describe the same contract; the shots entries should take their keys from the app's parameter module so the two cannot drift. Implementation note for 04a; no plan change.

Fits existing patterns: the spike's single-constant settings (`src/spike/shared/render.ts`), its allowlist parser and its error boundaries are reused rather than rewritten (S-RW3, S-RW31). No duplicated behaviour or over-engineering found beyond these notes.

### Section 6: Test review (Phase 2)

```text
 NEW THING                          | TYPE          | IN PLAN?            | HAPPY                        | FAILURE                         | EDGE
 -----------------------------------|---------------|---------------------|------------------------------|---------------------------------|-----------------------------
 params (S-RW2)                     | unit          | yes                 | each key parsed              | junk -> fallback + warning      | unknown view
 reducedMotion flag (D20)           | unit + e2e    | yes (determined)    | follows emulated OS setting  | -                               | changes at runtime
 driver pacing and calm (C16)       | unit (fake)   | yes                 | 60 fps at 60-144 Hz          | -                               | jitter, hidden tab, freeze
 calm mode in a browser (C16)       | e2e           | yes                 | <= 31 fps after 5 s idle     | -                               | -
 frame errors (C23)                 | unit (fake)   | yes                 | one-off error, loop lives    | 3 in a row -> sceneError        | same message logged once
 frame monitor (S-RW5, S-RW29)      | unit (fake)   | yes                 | normal at cap                | slow -> degraded                | recover, 90 and 144 Hz
 webgl state (D11, S-RW10, S-RW33)  | unit + e2e    | yes                 | restore -> ok                | timeout -> card                 | late restore, 9.99/10.01 s
 composer boundary (S-RW31)         | unit          | yes                 | bloom on                     | throw -> bloom off, no card     | throw on remount
 scene-error card (C23)             | component+e2e | yes                 | -                            | throwing component -> card      | not the WebGL card
 draw-call split (S-RW4, S-RW32)    | e2e + unit    | yes                 | scene < 10, post shown       | -                               | bloom off: post = 0
 ready signal (S-RW7, S-RW20)       | e2e (implied) | yes                 | shots and specs wait         | webgl=0: wait on card           | freeze + resize re-render
 safeArea (eng E6, S-RW36, S-RW38)  | unit + smoke  | yes                 | rect on resize and toggle    | no RO loop error                | empty rect -> full canvas
 glassFill + contrast (S-RW9, C21)  | unit + e2e    | yes                 | 12 inputs mapped             | -                               | night level on every slot
 glass fallback (D18, S-RW11)       | e2e (Firefox) | yes                 | triggers                     | -                               | recovers
 toast host (C15, S-RW13)           | e2e           | yes                 | shows while restoring        | -                               | clears on ok
 look-dev baseline (C17, S-RW17)    | e2e:local     | yes                 | matches baseline             | drift -> fails                  | skipped in CI
 shared materials (04c)             | e2e or unit   | yes                 | 0 dispose events             | -                               | unmount and remount
 controls and bounds (05)           | e2e x3        | yes                 | pan, rotate, zoom            | -                               | ortho and perspective bounds
 glide and retarget (05, S-RW37)    | unit (fake)   | yes (determined)    | ends in ~600 ms              | drag cancels                    | panel opens mid-glide
 keys (C19)                         | unit + e2e x3 | yes                 | each key moves               | typing ignored                  | auto-repeat
 zoom-to-cursor, double-click (C20) | unit + e2e    | yes                 | point stays fixed            | -                               | corner vs centre
 reduced motion in controls (S-RW21)| e2e + unit    | yes                 | instant cuts                 | -                               | settling holds the cap
 perspective toggle mid-glide (S-RW39) | unit       | yes                 | glide cancelled              | -                               | framing kept
 Safari trackpad pinch (05)         | manual        | yes (manual)        | scene zooms                  | page zoom                       | -
```

Assertion checks for approved items: C16's cap test asserts at most 60 rendered frames per simulated second at 120 and 144 Hz and exactly 60 at 60 Hz with jitter (rejects 30 or 120; `no_claim`=real browser rAF timing, fake clock only). C23's tests assert the loop is still scheduled after a thrown frame and that `sceneError` is set on the third consecutive throw, not the second (rejects a frozen loop and an early card; `no_claim`=errors from WebGL driver crashes, simulated with a throwing callback). S-RW33 asserts `ok` after a restore at 10.01 s (rejects a permanent card; `no_claim`=real Safari restore behaviour, which `WEBGL_lose_context` only approximates).

Determined checks spelled out (implementation of approved behaviour, no new approval): the reduced-motion flag is tested with Playwright `emulateMedia` before load and after load; a resize of a `freeze=1` page re-renders the same frame (driver unit test); glide duration is asserted in the rig's fake-clock unit test, and e2e asserts only the end state, so the e2e cannot flake on timing; the Safari pinch check is manual and recorded in the 05 PR, since Playwright cannot drive a trackpad.

Test ambition: the 2am-Friday test is a lost context with no restore that must show the card after 10 s; the hostile test resizes the window below 1280x720 mid-glide with the right panel open (S-RW37, S-RW38); the chaos test throws from a `useFrame` callback every frame and expects the scene-error card after 3. Pyramid: about 14 unit suites, about 10 e2e specs across three engines, one Mac-only baseline. Flakiness: the calm e2e waits 5 s and asserts an upper bound only; glide timing lives in unit tests; the baseline is skipped in CI.

Section 6 dispositions: 0 gaps; S-RW39 added its own unit test.

### Section 7: Performance (Phase 2)

- P-1 [P2] (confidence 6/10) `backdrop-filter` blur on up to five glass slots over a canvas that redraws at up to 60 fps re-blurs every frame; its cost is unmeasured and likely highest in Firefox and Safari [inference]. Mitigation in scope: the frame monitor drops glass to the solid fallback (D18, S-RW5). Measurement owner: chunk 36, which already tiers the glass fallback; no new work.
- P-2 [P3] (confidence 6/10) Composer memory at the ADR 0001 settings: a HalfFloat RGBA target is 8 bytes per pixel, so a 2880x1800 canvas at DPR 2 needs about 41 MB per target and about 166 MB for the 4x multisampled one, plus bloom mips [estimated]. Notable on an 8 GB M1 Air; the quality tier's pixel-ratio knob is the lever. Owner: chunk 36.
- Slowest new paths: bloom (about 6.6 ms median GPU per frame at 4x, M1 Max, Chrome, ADR 0001), glass blur (unmeasured), the 2048 shadow map (04c). No queries, caches, jobs or connection pools.

No decision needed; both items sit with chunk 36, which owns measured tiering.

### Section 8: Observability (Phase 2)

- O-1 [P2] (confidence 8/10) Quality drops, WebGL state changes, composer failures and frame errors are visible to the user (no bloom, a card, a toast) but leave the team nothing to read afterwards except the frame-error log from C23. Required by Prime Directive 1 (surface every failure to system, team and user); applied as S-RW40: each transition logs one console line with a `[scene]` prefix, the transition, its reason and the mean frame interval where relevant (for example `[scene] quality normal -> degraded (mean 31.2 ms over 2 s)`), and the README's "Known limits" names the WebGL card and the scene-error card with what to do (check hardware acceleration; reload and report the console line).
- Dashboard: the `dev=1` HUD is the operator view (fps, cap and mode, tier, draw-call split, `webgl` state, frame-error count).
- Debuggability: a bug report three weeks later can include the `[scene]` console lines; there is no server log in Phase 2.

### Section 9: Deployment and rollout (Phase 2)

```text
 docs PR (this review, title docs:) ──► no release
 04a PR (feat:) ──► CI: check, test, Chromium + Firefox smoke (WebGL2 or S-RW30 fallback) ──► squash ──► release 0.3.0
        └─ deletes src/spike/ and e2e/spike.spec.ts; ADR 0001, its results and 03-spike.png stay
 04b PR (feat:) ─┐
 04c PR (feat:) ─┴─ parallel after 04a (shots.config.ts appends merge trivially) ──► releases 0.4.0, 0.5.0
 05 PR (feat:)  ──► after 04b ──► release 0.6.0
 rollback: revert the PR, merged as "fix: revert <title>" (CONTRIBUTING runbook) ──► patch release
```

- Dep-1 [P2] (confidence 6/10) CI WebGL2 in headless browsers is unproven (S-RW30 carries the check and the fallback); the 04a PR is where it shows.
- Dep-2 [P3] The look-dev baseline is Mac-only; a contributor on Linux cannot regenerate it. Accepted for a single-contributor repo (C17, S-RW17).
- No migrations, flags or deploy windows. Post-merge check: `release.yml` green, `vp run serve` shows the scene at `127.0.0.1:7317`.

### Section 10: Long-term trajectory (Phase 2)

- Debt: (1) C16 depends on R3F 9's `frameloop="never"` and `advance()`; R3F 10 (alpha, WebGPU-first) may change the loop API [unverified]; (2) the look-dev baseline needs a deliberate update on each look change; (3) 04a remains the largest chunk (C22 note); (4) the frame-monitor thresholds are estimates until chunk 36 measures; (5) C18's probe is deferred.
- Reversibility: chunk code 4/5 (one PR each); the C16 loop 3/5 once animation chunks build on it; the store layout 3/5 once chunk 11 adds slices.
- Path forward: Phase 3 builds halls with 04c's materials and look-dev view; the data track (11-17) extends the 04a store; every scene chunk inherits the loop, monitor, ready signal and error handling.
- Platform potential: the parameter module and ready signal are the test seam for every later Playwright spec; the toast host and `GlassPanel` are reused by chunks 26-33.
- Cherry-pick retrospective: C16, C17, C19 and C20 all landed inside existing chunks without new coupling; C18's deferral removes nothing they depend on.
- 1-year question: a new engineer reads ADR 0001, section 4b and this record and can see why the loop is capped, why glass has two layers and why 04a and 04c are separate.

### Section 11: Design and UX (Phase 2)

```text
  open app ─► loader (wordmark + cyan line) ─┬─► first frame ─► campus (cube in 04a, look in 04c) + shell slots
                                             ├─► webgl unavailable ─► WebGL card (D11)
                                             └─► scene error ─► "The 3D view stopped after an error." + Reload (C23)
  campus ─► context lost ─► "Restoring 3D view" toast ─┬─► restored ─► campus
                                                       └─► 10 s ─► WebGL card ─► late restore ─► campus
  campus ─► slow frames ─► bloom off, solid glass ─► frames recover (10 s) ─► normal
  campus ─► drag / wheel / keys ─► camera moves ─► 5 s idle ─► calm (30 fps, invisible to the user)
```

```text
  FEATURE          | LOADING                 | EMPTY                    | ERROR                                   | SUCCESS             | PARTIAL
  scene canvas     | loader until 1st frame  | test cube / dormant      | WebGL card; scene-error card (C23)      | campus renders      | bloom off, solid glass
  shell slots      | -                       | placeholder titles       | -                                       | glass slots         | solid fallback < 45 fps
  restore toast    | -                       | -                        | card after 10 s                         | clears on restore   | -
  perf HUD (dev=1) | -                       | -                        | frame-error count                       | live numbers        | "frozen" under freeze=1
  camera           | -                       | home view                | clamped at bounds                       | moves, glides       | instant under reduced motion
```

- UI-1 [P3] The scene-error card (C23) needs copy review next to the D11 card; owner `/plan-design-review`. Pending, not a task here.
- UI-2 [P3] The D21 2 px cyan focus ring on a focused full-viewport canvas (C19) would outline the whole screen; owner `/plan-design-review` (keep the ring, inset it, or show a small focus badge). Pending.
- UI-3 [P3] Delight item 6 from 0G, a loader fade over `--dur-ui` instead of a cut, is a detail of the approved D10 loader; owner `/plan-design-review`. Pending.
- Responsive: desktop only from 1280x720 (D1, section 4b); S-RW38 covers smaller windows without breaking. Accessibility: keyboard camera (C19), reduced motion (D20, S-RW21), contrast helper (S-RW9, S-RW28).

Recommendation: Phase 2 has significant UI scope (shell, glass, cards, toast, keyboard camera). Consider running /plan-design-review for UI-1 to UI-3 before 04b starts.


### Outside voice (Phase 2)

`codex_reviews` is disabled (stored config). Recorded as `outside_status: disabled` (review log, commit `d428146`). No external or native challenge ran; this is an opt-out, not missing coverage to replace. The three refuter spec reviews in 0H are same-harness reviews and are not outside coverage.

### TODOS.md (Phase 2)

One TODO from this review, already answered: C18 startup quality probe (SQ5, deferred, P3, added to `TODOS.md`). No other TODO proposal remains.

### Approval readiness (Phase 2)

Checked rows and answers: C15 (SQ2), C16 (SQ3), C17 (SQ4), C18 deferred (SQ5), C19 (SQ6), C20 (SQ7), C21 (SQ8), C22 (SQ9), C23 (SQ11); scope documents (SQ10, document approval only). Mode: SQ1 (SELECTIVE EXPANSION, user choice; not a remedy approval). Required work without a new choice, each citing its contract: S-RW1 to S-RW9 (Step 0), S-RW10 to S-RW18 (spec review 1), S-RW19 to S-RW30 (spec review 2), S-RW31 to S-RW35 (spec review 3), S-RW36 to S-RW40 (Sections 1, 2, 4, 8). Every Phase 2 chunk edit and every edit to chunks 06, 11, 24, 25, 32, 34, 35, 36, sections 4b and 6 and ADR 0001 maps to one of these. Pending rows UI-1 to UI-3 are not applied to any chunk text.

Approval readiness: PASS

### NOT in scope (Phase 2)

- Deferred: startup quality probe (C18, SQ5) to `TODOS.md`, trigger chunk 36.
- Handed off, not decided here: UI-1 scene-error card copy, UI-2 canvas focus ring, UI-3 loader fade (owner `/plan-design-review`).
- Not added: `@react-three/drei` (chunk 05 uses three's installed `MapControls`, S-RW16); a fourth spec review (cap of three reached).
- Rejected by user choice: keeping 04a whole and a three-way split (SQ9); dark-only or white-to-dark glass (SQ8); reusing the WebGL card for scene errors and leaving errors unhandled (SQ11); pulling GlassPanel into 04a (SQ2).
- Outside Phase 2, unchanged: TODO E18 (#8 and #9 against C8 and C2, before chunk 14); chunk 36's "200 racks" overrun noted in the Phase 1 review.

### What already exists (Phase 2)

The spike's pinned render settings, R3F composer boundary, draw-call counter, shared-material guard and allowlist parser (`src/spike/`) are promoted, not rewritten (S-RW3, S-RW31). Playwright's three engines and production-build server, the shots pipeline and its `ready` hook, the repeat check, the tokens file, the cross-origin isolated preview and three's `MapControls` are reused. Nothing is rebuilt.

### Dream state delta (Phase 2)

After Phase 2: one R3F canvas that costs about half the frames on a 120 Hz display and a quarter when calm, never freezes or blames the browser silently, frames its targets inside the panels' safe area, moves like a map app by mouse or keyboard, and has a look-dev view whose screenshot catches material drift. Still missing from the 12-month ideal: the campus itself (06-10), measured numbers on an M1 Air-class Mac (chunk 36), and day and weather states for the glass (34-35).

### Error and rescue registry (Phase 2)

See "Section 2: Error & Rescue Map (Phase 2)": 16 codepath rows, 12 error classes, all rescued after C23, each with a user-visible result and a named test.

### Failure modes registry (Phase 2)

```text
  CODEPATH            | FAILURE MODE                          | RESCUED? | TEST?             | USER SEES?                        | LOGGED?
  --------------------|---------------------------------------|----------|-------------------|-----------------------------------|--------
  app params          | unknown or malformed value            | Y        | Y (unit)          | nothing; console warning          | Y
  webgl pre-check     | no WebGL2                             | Y        | Y (e2e webgl=0)   | WebGL card                        | Y [scene]
  Canvas init         | renderer promise rejects              | Y        | Y (unit)          | WebGL card                        | Y [scene]
  composer            | throws on mount or remount            | Y        | Y (unit)          | scene without bloom               | Y [scene]
  context             | lost, then restored                   | Y        | Y (unit + e2e)    | "Restoring 3D view" toast         | Y [scene]
  context             | lost, no restore in 10 s              | Y        | Y (unit + e2e)    | WebGL card                        | Y [scene]
  context             | restore after the timeout             | Y        | Y (unit)          | scene returns                     | Y [scene]
  render driver       | one frame throws                      | Y        | Y (unit)          | nothing                           | Y (once)
  render driver       | 3 consecutive frames throw            | Y        | Y (unit)          | scene-error card                  | Y [scene]
  scene component     | throws while rendering                | Y        | Y (component)     | scene-error card                  | Y [scene]
  frame monitor       | sustained slow frames                 | Y        | Y (unit + e2e)    | no bloom, solid glass             | Y [scene]
  frame monitor       | 90 or 144 Hz display misread as slow  | Y        | Y (unit)          | none needed                       | n/a
  shell safeArea      | ResizeObserver loop error             | Y        | Y (smoke)         | none needed                       | n/a
  shell safeArea      | empty rect                            | Y        | Y (unit)          | target framed in the full canvas  | Y (warn)
  camera rig          | panel opens mid-glide                 | Y        | Y (unit)          | target ends inside the panel gap  | n/a
  camera rig          | projection toggled mid-glide          | Y        | Y (unit)          | framing kept                      | n/a
  controls            | Safari trackpad pinch zooms the page  | ?        | manual (05 PR)    | page zoom (visible, not silent)   | n/a
  CI                  | no WebGL2 in a headless browser       | Y        | Y (CI)            | card-path smoke instead           | Y
  look-dev            | material or lighting drift            | Y        | Y (e2e:local)     | failing baseline                  | Y
```
CRITICAL GAPS: 0.

### Scope expansion decisions (Phase 2)

Full record in the CEO plan (`~/.gstack/projects/bjorkgard-ai-center/ceo-plans/2026-10-13-phase-2-scene-foundation.md`).
- Accepted: C16 render loop and power policy; C17 look-dev view and baseline; C19 keyboard camera controls; C20 map feel.
- Deferred: C18 startup quality probe.
- Skipped: none.

### Diagrams produced (Phase 2)

Dream state (0C), temporal sequence (0I), system architecture and state machines (Section 1), error and rescue map (Section 2), data flow with shadow paths (Section 4), test map (Section 6), deployment sequence and rollback (Section 9), user flow and interaction states (Section 11).

### Stale diagram audit (Phase 2)

- Section 3 architecture picture: accurate (Phase 2 adds no data path).
- Section 4b screen layout: accurate; section 4b gains a "Glass panel" subsection (S-RW22).
- Section 6 dependency summary: was stale after C22 and S-RW1; updated (04c branch, `08 → 10`, chunk 11 after 04a).
- Phase 0 and Phase 1 review diagrams: historical; unaffected.

### Reality rows (Phase 2)

The seven REALITY rows are in "0B. Existing code leverage (Phase 2)" above, with `file:line` receipts updated after C22.

PLAN_REALITY: phase=ceo rows=7/7 missing=none unverified=3 verdict=complete


## Implementation Tasks (CEO review, Phase 2)

Synthesized from this review's findings. Each task derives from a specific finding above. Effort ratios assumed: features ~30x, tests ~50x, scaffolding ~100x; 04c look tuning is mostly human review time.

- [x] **T1 (P1, human: ~4h / CC: ~15min)** — 04a foundations — Add the store and parameter module; promote spike code to `src/scene/`; delete the rest of the spike
  - Surfaced by: Step 0 — S-F2, S-F5, S-F6; S-RW1, S-RW2, S-RW3, S-RW31
  - Files: package.json, pnpm-lock.yaml, src/app/store/index.ts, src/app/store/ui.ts, src/app/params.ts, src/app/params.test.ts, src/scene/render.ts, src/app/App.tsx, scripts/shots.config.ts, src/spike/ (deleted), e2e/spike.spec.ts (deleted)
  - Verify: `vp check`, `vp test`; `vp run shots` passes; `docs/img/03-spike.png` unchanged
- [x] **T2 (P1, human: ~6h / CC: ~25min)** — 04a render loop — rAF driver with deadline pacing, calm mode, freeze, hidden tab and frame-error handling
  - Surfaced by: C16 (SQ3), C23 (SQ11); S-RW12, S-RW29; Section 1 — A-1
  - Files: src/scene/loop/driver.ts, src/scene/loop/driver.test.ts, src/scene/SceneCanvas.tsx
  - Verify: fake-clock tests at 60, 75, 90, 120 and 144 Hz; calm e2e (31 or fewer fps after 5 s); a throwing frame keeps the loop alive
- [x] **T3 (P1, human: ~3h / CC: ~15min)** — 04a quality — Frame monitor with windowed mean and hysteresis, simulate hook, quality tier
  - Surfaced by: S-RW5, S-RW11, S-RW27, S-RW29, S-RW34
  - Files: src/scene/loop/monitor.ts, src/scene/loop/monitor.test.ts, src/scene/render.ts (`qualitySettings`), src/app/store/ui.ts (tier) (eng D1)
  - Verify: fake-clock tests (drop at 2 s, recover at 10 s, paused under freeze); `simulateFrameInterval` drives bloom off and on in e2e
- [x] **T4 (P1, human: ~5h / CC: ~20min)** — 04a failure handling — WebGL pre-check, outer boundary with error kinds, composer inner boundary, restore, 10 s timeout, late restore, plain WebGL and scene-error cards
  - Surfaced by: C15 (SQ2), C23 (SQ11); S-RW6, S-RW10, S-RW19, S-RW31, S-RW33; Section 2 — E-1
  - Files: src/scene/webgl.ts, src/scene/webgl.test.ts, src/scene/SceneBoundary.tsx, src/scene/SceneBoundary.test.ts, src/app/App.tsx (eng D1)
  - Verify: unit tests for restore, rebuild failure, timeout and late restore; e2e `?webgl=0` card; `WEBGL_lose_context` with and without restore; throwing component shows the scene-error card
- [x] **T5 (P2, human: ~5h / CC: ~20min)** — 04a camera, HUD and test seams — Camera module with ortho and perspective ranges and toggle, HUD draw-call split, ready signal, transition logs, CI WebGL check
  - Surfaced by: S-RW4, S-RW7, S-RW20, S-RW26, S-RW30, S-RW32, S-RW35, S-RW39, S-RW40
  - Files: src/scene/camera.ts, src/scene/PerfHud.tsx, e2e/smoke.spec.ts, e2e/repeat.spec.ts, playwright.config.ts, scripts/shots.config.ts, README.md, docs/img/04a-core.png
  - Verify: HUD shows under 10 scene draw calls; CI Chromium and Firefox smoke green (WebGL2 or the S-RW30 fallback); `vp run e2e:local` green in three engines
- [x] **T6 (P1, human: ~1 day / CC: ~40min)** — 04b shell — Tokens, two-layer GlassPanel, `glassFill`, layout slots with placeholder titles, coalesced `safeArea`, loader, toast host, glass cards, night contrast helper
  - Surfaced by: C15 (SQ2), C21 (SQ8), C23 (SQ11); S-RW8, S-RW9, S-RW13, S-RW15, S-RW19, S-RW28, S-RW36
  - Files: src/styles/tokens.css, src/dashboard/GlassPanel.tsx, src/dashboard/glassFill.ts, src/dashboard/glassFill.test.ts, src/dashboard/shell/, src/dashboard/ToastHost.tsx, src/app/store/ui.ts, e2e/shell.spec.ts, e2e/contrast.ts, README.md, docs/img/04b-shell.png
  - Verify: shell matches section 4b at 1280x720 and 1920x1080; contrast helper passes at night; Firefox fallback triggers and recovers; toast shows and clears
- [x] **T7 (P2, human: ~1 day / CC: ~30min)** — 04c look — Lighting rig, material library, look-dev view, committed baseline project, mockup copy
  - Surfaced by: C17 (SQ4), C22 (SQ9); S-RW17, S-RW24; Step 0 — S-F8
  - Files: src/scene/lights.tsx, src/scene/materials.ts, src/scene/LookDev.tsx, e2e/lookdev.spec.ts, e2e/__screenshots__/, playwright.config.ts, scripts/shots.config.ts, docs/designs/variant-B-2.png, docs/img/04c-scene.png, docs/img/04c-lookdev.png, README.md
  - Verify: baseline matches in `vp run e2e:local`; spec skipped in CI; shared materials get 0 dispose events on remount; PR shows the shot beside the mockup
- [x] **T8 (P1, human: ~1 day / CC: ~45min)** — 05 camera — MapControls with clamps, glide with retarget and home, keys, map feel, reduced motion, dev menu
  - Surfaced by: C19 (SQ6), C20 (SQ7); S-RW16, S-RW21, S-RW25, S-RW26, S-RW37, S-RW38; Section 1 — A-3
  - Files: src/scene/controls.tsx, src/scene/cameraRig.ts, src/scene/cameraRig.test.ts, src/scene/keys.ts, src/scene/keys.test.ts, src/dashboard/DevMenu.tsx, e2e/camera.spec.ts, README.md
  - Verify: e2e in three engines (pan, rotate, zoom, keys, bounds, corner scroll, double-click home, reduced motion); rig unit tests (glide timing, retarget, empty `safeArea`); Safari trackpad pinch checked by hand and noted in the PR

_No new tasks from Security (Section 3), Code quality (Section 5), Performance (Section 7, owned by chunk 36) or Long-term trajectory (Section 10)._

### Completion summary (Phase 2)

```text
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | no scene code; 3,418 spike lines to promote |
  |                      | or delete; Playwright runs prod build; R3F  |
  |                      | fallback is canvas-only; 120 Hz in Firefox  |
  | Step 0               | C15 04a/04b order; C16-C20 additions (4     |
  |                      | accepted, 1 deferred); C21 glass; C22 split |
  | Section 1  (Arch)    | 4 issues found (A-1 C23, A-2/A-3 fixed)     |
  | Section 2  (Errors)  | 16 error paths mapped, 0 GAPS after C23     |
  | Section 3  (Security)| 0 issues found, 0 High severity             |
  | Section 4  (Data/UX) | 13 edge cases mapped, 0 unhandled (S-RW39;  |
  |                      | Safari pinch: manual verify)                |
  | Section 5  (Quality) | 0 issues found (3 P3 notes)                 |
  | Section 6  (Tests)   | Diagram produced, 0 gaps                    |
  | Section 7  (Perf)    | 2 issues found (owned by chunk 36)          |
  | Section 8  (Observ)  | 1 gap found (O-1, S-RW40)                   |
  | Section 9  (Deploy)  | 2 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 4/5 code, 3/5 loop;          |
  |                      | debt items: 5                               |
  | Section 11 (Design)  | 3 issues, handed to /plan-design-review     |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (5 groups, 12 items)                |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 16 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 19 total, 0 CRITICAL GAPS                   |
  | TODOS.md updates     | 1 item proposed (C18, added)                |
  | Scope proposals      | 5 proposed, 4 accepted (SELECTIVE)          |
  | CEO plan             | written                                     |
  | Outside voice        | codex disabled (config)                     |
  | Lake Score           | N/A (no scored question offered a 10/10)    |
  | Diagrams produced    | 9 (dream, temporal, arch, state, error,     |
  |                      | data flow, tests, deploy, user flow)        |
  | Stale diagrams found | 1 (section 6, fixed)                        |
  | Unresolved decisions | 3 (UI-1 to UI-3, to /plan-design-review)    |
  | Reality rows         | 7/7 rows (PLAN_REALITY complete), 3 unverif.|
  +====================================================================+
```

Lake Score basis: the coverage-scored questions were C15 (9, 9, 6) and C23 (9, 6, 3); neither offered a 10/10 option, so Y = 0. Spec review: 3 refuter runs, last score 7/10, spec not re-verified after the third run's fixes.

### Unresolved decisions (Phase 2)

- UI-1 scene-error card copy (owner `/plan-design-review`).
- UI-2 focus ring on the full-viewport canvas (owner `/plan-design-review`).
- UI-3 loader fade over `--dur-ui` (owner `/plan-design-review`).

Open verifications (not decisions): WebGL2 in headless CI browsers and the SwiftShader flag (S-RW30, S-RW35); postprocessing after a context restore (S-RW31); Safari trackpad pinch (chunk 05); R3F 10 loop API (Section 10).


## Eng review record: Phase 2 (/plan-eng-review, 2026-10-13)

Target: `docs/PLAN.md` Phase 2 (chunks 04a, 04b, 04c, 05) as amended by the Phase 2 CEO review (C15-C23, S-RW1 to S-RW40), branch `phase-2-scene-foundation`, base `d428146` plus uncommitted CEO review edits. Reviewer: Claude (in-host). Report file: this plan. Design doc: `docs/designs/phase-2-scene-foundation.md` (the promoted CEO summary). Question numbers D1, D2... are this review's own sequence; ledger rows continue the eng series at E19.

### Scope record (eng, Phase 2)

feature answers: none proposed (no cut or deferral offered; every item traces to an approved decision or required fix); structure: B "Smaller arrangement (recommended)", eng D1, 2026-10-13; accepted scope: Phase 2 feature list unchanged; in 04a the quality tier is a `qualitySettings(tier)` table in `src/scene/render.ts` with the tier in the store `ui` slice (no `src/scene/quality.ts`), and the WebGL failure handling is one state-machine module `src/scene/webgl.ts` (pre-check, restore, 10 s timeout, late restore) plus `src/scene/SceneBoundary.tsx`; the driver (`src/scene/loop/driver.ts`) and monitor (`src/scene/loop/monitor.ts`) stay separate; pending remedies: E20.

04a size flag (CEO C22 note): 04a's tasks T1-T5 estimate to about 95 CC-minutes [estimated, CEO task table], against chunk 03's estimate of about 1.5 h, which shipped as one PR (#11). The word count (1,319) is mostly acceptance and failure detail. No cut proposed; the smaller arrangement removes two modules.

### Scope Challenge (eng, Phase 2)

- What already exists: the spike's settings constant, R3F composer boundary, draw-call counter, shared-material guard and allowlist parser (CEO S-RW3, S-RW31); the spike's boundary tests call the class methods directly (`src/spike/r3f/View.test.ts:4-21`), so the C23 boundary tests need no DOM library; three's `MapControls` (CEO S-RW16); Playwright's three engines, shots `ready` hook and repeat check.
- Minimum change: every item is approved; no deferral proposed.
- Complexity: 04a about 43 files (25 added or edited, 18 deleted) and 8 new modules before D1, 6 after [estimated]; Phase 2 about 70 files [estimated].
- Search check: [Layer 1] R3F `frameloop="never"` plus a custom `requestAnimationFrame` loop that calls `advance()` is the documented way to own the frame rate; [Layer 2] R3F issue #2688 plans to change `advance()` to take a delta and pause effects, so the C16 driver depends on R3F 9's timestamp API (E23); [Layer 2] three.js maintainers advise recreating app-owned render targets after `webglcontextrestored`, which matches CEO S-RW31's composer remount.
- TODOS: C18 probe (deferred, trigger chunk 36), E18 (#8/#9, before chunk 14) and `vp run doctor` neither block nor belong in Phase 2.
- Distribution: no new artifact; binaries stay in chunk 14b. The mockup copy in `docs/designs/` is a 2.2 MB source image compressed on commit (CEO C17).

Findings:
- E19 [P1] (confidence: 9/10) src/spike/r3f/View.tsx:94 — `state.advance(t);` passes the rAF timestamp in milliseconds; R3F's `update()` in `frameloop="never"` mode sets `delta = timestamp - state.clock.elapsedTime` (`node_modules/@react-three/fiber/dist/events-9ce18a08.esm.js:17406`), while in its default mode `delta` comes from `clock.getDelta()` in seconds (`:17402`). Promoting the spike pattern (CEO C16 "the pattern ADR 0001 measured") would hand every `useFrame` callback in chunks 20-35 a delta 1000 times R3F's convention; the spike had no `useFrame` consumer, so it never showed. Factual correction, no behaviour choice: the driver passes seconds to `advance()`. Applied.
- E20 [P2] (confidence: 8/10) same lines — in `frameloop="never"` the clock starts at 0 (`setFrameloop`, `:1128-1130`), so the first frame's delta is the time since page load, and a frame after a hidden tab or a long pause gets the whole gap. The plan does not say what scene time does across gaps. Pending (behaviour choice).
- E21 [P2] (confidence: 8/10) docs/PLAN.md 04b Tasks — the minimal toast host shows "Restoring 3D view" but is not announced; design D22 (section 4b, "Alerts are announced: `aria-live="polite"` for info and waiting") covers it. Required by D22; applied.
- E22 [P3] (confidence: 9/10) vite.config.ts:21-23 — `__THREE_VERSION__` and `__R3F_VERSION__` defines exist only for spike result files (declared in `src/spike/spike-globals.d.ts`), and the `preview.headers` comment cites the spike bench. Deleting the spike (CEO S-RW3) leaves dead defines and a stale comment. Covered by S-RW3's approved deletion; applied.
- E23 [P3] (confidence: 6/10) Medium confidence, verify when upgrading R3F: R3F issue #2688 plans an `advance(delta)` API that pauses all effects under `frameloop="never"`. The C16 driver and E19's units would need a small change on that upgrade. Recorded in Section 4 trajectory notes; no plan change.



Scope Challenge dispositions: E19 applied (factual correction); E20 approved (eng D2, A); E21 applied (design D22); E22 applied (CEO S-RW3); E23 recorded, no change. Scope Challenge result: scope accepted as-is (the smaller arrangement keeps the scope).

### 1. Architecture review (eng, Phase 2)

```text
 src/main.tsx (StrictMode) ─► App
   ├─ src/app/params.ts ─────────────► dev, webgl, calm, view, freeze, seed, source, scenario
   ├─ src/app/store/index.ts ◄─ ui.ts (reducedMotion, quality tier, webgl, sceneError, safeArea)
   │                         ◄─ chunk 11 data slices (separate files)
   ├─ src/scene/SceneBoundary.tsx (outer; WebGLUnavailableError ─► D11 card; anything else ─► scene-error card)
   │    └─ R3F <Canvas frameloop="never" gl={createRenderer}>      (R3F rethrows inner errors: esm.js:61)
   │         ├─ createRenderer: new WebGLRenderer(...) in try/catch ─► WebGLUnavailableError   (E24)
   │         ├─ scene graph (04a cube, 04c look, later chunks)
   │         ├─ composer boundary (inner) ─► bloom off on error (S-RW31)
   │         └─ PerfHud (dev=1)
   ├─ src/scene/webgl.ts: pre-check, contextlost/restored, 10 s timeout, late restore ─► store.webgl
   ├─ src/scene/loop/driver.ts: rAF, deadline pacing, calm, scene time (E20) ─► advance(seconds)
   │    └─ src/scene/loop/monitor.ts ─► store quality tier ─► render.ts qualitySettings(tier)
   ├─ src/scene/camera.ts (ortho + perspective ranges) ◄─ chunk 05 controls, cameraRig
   └─ chunk 04b shell: GlassPanel, glassFill, safeArea, loader, ToastHost (aria-live)
```

Production failure per new path:

| Path | Realistic failure | Handled? |
|---|---|---|
| Renderer creation | pre-check passes but `new WebGLRenderer` throws (GPU process blocklisted, context limit) | Gap: three throws a plain `Error` (`WebGLRenderer.js:421`) and R3F rethrows it like any scene error, so C23's boundary would show the scene-error card instead of the D11 card (E24) |
| Driver and listeners under StrictMode | `vp dev` mounts, unmounts and remounts effects; a driver or listener without cleanup runs twice | Gap: two rAF loops double the frame rate in development only, and production-build e2e cannot see it (E25) |
| Context restore | browser never restores | Y: 10 s timeout, late restore (S-RW10, S-RW33) |
| Frame monitor | thresholds wrong for a display | Y: windowed mean, tests at 60-144 Hz (S-RW29) |
| Ready signal | never fires | Y: loader ends on `unavailable`; webgl=0 specs wait on the card (S-RW19) |
| Distribution | none: no new artifact; binaries in chunk 14b | n/a |

- E24 [P2] (confidence: 9/10) node_modules/@react-three/fiber/dist/react-three-fiber.esm.js:61 — `if (error) throw error;` rethrows renderer-creation and scene errors alike, and `node_modules/three/src/renderers/WebGLRenderer.js:421` throws `new Error( 'THREE.WebGLRenderer: Error creating WebGL context.' )`. To meet C23's approved contract ("WebGL failures show the D11 card; scene errors show a separate card"), 04a creates the renderer through R3F's `gl` factory (`configuration.d.ts:11`, `(defaultProps) => Renderer`), catches construction errors and rethrows them as `WebGLUnavailableError`, the same class the pre-check throws. Covered by C23 (SQ11); applied.
- E25 [P2] (confidence: 8/10) src/main.tsx:7 — `<StrictMode>` double-invokes effects in `vp dev`. The C16 driver, the frame monitor's visibility and resize listeners, the reduced-motion `matchMedia` listener, the ResizeObserver and the WebGL context listeners must each stop and remove themselves on cleanup, or development runs two loops and leaks listeners while every production-build test passes. Required for C16's 60 fps cap and the RW9 listener-leak contract; applied: each starter returns a stop function, and a unit test mounts, unmounts and remounts the driver and asserts one scheduled callback and baseline listener counts.
- Coupling: chunk 11 now depends on 04a's store module (CEO S-RW1); slices in separate files keep 04b and 11 apart.
- Security: no endpoints, auth or data access; the URL parameters are allowlisted (CEO S-RW2). No issues.

Section 1 dispositions: E24 applied (covered by C23); E25 applied (required by C16 and RW9).


### 2. Code quality review (eng, Phase 2)

No issues found that need a decision. Notes for the implementer (no plan change):
- Q-E2 [P3] (confidence: 8/10) src/spike/shared/bench.ts:169-184 — the spike injected `raf` and `cancelAnimationFrame` through `Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">`; the 04a driver and monitor reuse that seam (the production caller passes `window`), so their fake-clock tests need no global faking.
- Q-E3 [P3] (confidence: 8/10) src/spike/spike-globals.d.ts — it declares the spike's window globals and is deleted with the spike (E22); the new `window.__sceneReady` and `window.__sceneDev` get one declaration file under `src/app/`.

Shared-code candidates (rubric): (1) the URL contract keys in `scripts/shots.config.ts:18` (`viewUrl`) and the proposed `src/app/params.ts`: two callers in different runtimes (Node script, browser), savings under 10 lines [estimated]; not proposed, the CEO Q-3 note stands. (2) A fake-clock helper for the driver, monitor, WebGL and camera-rig tests: Vitest's fake timers plus the injected scheduler (Q-E2) cover it; no new helper. Diagram accuracy: the CEO Section 1 diagram and tasks T3/T4 match the D1 arrangement after the file-list update.

### 3. Test review (eng, Phase 2)

Framework: Vitest through Vite+ (`vp test`, `vite.config.ts` `test`) and Playwright (`playwright.config.ts`, production build, Chromium, Firefox and WebKit); no CLAUDE.md testing section exists. Existing tests on the paths this phase touches: `e2e/smoke.spec.ts` (title, heading, version meta, no console errors), `e2e/repeat.spec.ts` (two captures within 0.5%), the spike suites in `src/spike/**` (to be promoted or retired) and `src/styles/tokens.test.ts`.

```text
CODE PATHS (proposed)                                   USER FLOWS (proposed)
[+] src/app/params.ts                                   [+] Open the app
  ├── [PLANNED ★★★] each key, junk fallback, warning      ├── [PLANNED ★★★][→E2E] loader → first frame → scene (S-RW7)
[+] src/scene/loop/driver.ts                              ├── [PLANNED ★★★][→E2E] webgl=0 → WebGL card, loader ends (S-RW19)
  ├── [PLANNED ★★★] pacing 60-144 Hz, jitter, calm        └── [PLANNED ★★ ][→E2E] scene component throws → scene-error card (C23)
  ├── [PLANNED ★★★] scene time: first 0, gap ≤ 0.1 s,   [+] Graphics context lost
  │                  freeze 0, seconds (E19, E20)         ├── [PLANNED ★★★][→E2E] restore → toast (aria-live) → ok (C15, E21)
  ├── [PLANNED ★★★] frame errors, 3-strike (C23)          └── [PLANNED ★★★][→E2E] no restore → card at 10 s (S-RW10)
  └── [PLANNED ★★ ] mount/unmount/mount: one loop (E25) [+] Idle laptop tab
[+] src/scene/loop/monitor.ts                             └── [PLANNED ★★ ][→E2E] ≤ 31 fps after 5 s idle (C16)
  └── [PLANNED ★★★] drop, recover, paused, 90/144 Hz    [+] Slow GPU
[+] src/scene/webgl.ts + SceneBoundary.tsx                └── [PLANNED ★★★][→E2E] simulateFrameInterval → glass solid,
  ├── [PLANNED ★★★] restore, timeout, late restore                       bloom off, recover (Firefox) (S-RW11)
  ├── [PLANNED ★★ ] gl factory rethrows WebGLUnavailableError (E24, gap filled)
  └── [PLANNED ★★★] boundary: WebGL class → D11 card;   [+] Navigate the campus (05)
                     other → scene-error card (C23)       ├── [PLANNED ★★★][→E2E] drag, wheel, keys, bounds, 3 engines
[+] src/scene/render.ts                                   ├── [PLANNED ★★ ][→E2E] corner scroll vs centre; double-click home
  ├── [PLANNED ★★ ] promoted settings + composer tests    ├── [PLANNED ★★ ][→E2E] reduced motion: instant cuts
  └── [PLANNED ★★ ] qualitySettings(tier) table (D1)      └── [MANUAL] Safari trackpad pinch (PR note)
[+] HUD draw-call split                                 [+] Shell (04b)
  └── [PLANNED ★★ ] scene < 10, post shown, bloom off 0   ├── [PLANNED ★★★][→E2E] layout 1280x720 / 1920x1080, safeArea
[+] 04b glassFill + contrast helper                       ├── [PLANNED ★★ ][→E2E] night contrast on titles and tab labels
  └── [PLANNED ★★★] 12 inputs; night level on slots       └── [PLANNED ★★ ][→E2E] toast in an aria-live region (E21, gap filled)
[+] 05 cameraRig + keys                                 [+] Look (04c)
  ├── [PLANNED ★★★] glide timing, retarget, empty rect    └── [PLANNED ★★ ] look-dev baseline (e2e:local only); browser
  └── [PLANNED ★★★] key map, focus gate, toggle mid-glide                 projects do not list the spec (S-RW24, gap filled)

Legend: [PLANNED ★★★] behaviour + edge + error planned | [PLANNED ★★] happy path planned | [MANUAL] hand check
        [→E2E] needs a browser test
COVERAGE (planned): 34/35 paths have a planned test; 1 manual (Safari pinch). No path is built yet.
GAPS FOUND AND FILLED: 3 (E24 gl factory test, E21 aria-live assertion, S-RW24 project list check)
```

Gaps and required proof (each covered by an existing approval, so added without a question):
- E24: `src/scene/webgl.test.ts` stubs `WebGLRenderer` to throw and asserts the `gl` factory rethrows `WebGLUnavailableError`. Value: protects=a context-creation failure shows the D11 card; fails_when=the factory stops wrapping the constructor; why_new=the pre-check test does not reach construction; seam=none (the factory is the production path); no_claim=a real GPU-process failure (stubbed constructor; unit only).
- E21: the 04b toast e2e asserts the "Restoring 3D view" text sits inside an `aria-live="polite"` region. Value: protects=design D22 announcement; fails_when=the live region is dropped; why_new=the toast e2e checks visibility only; seam=none; no_claim=screen-reader output (DOM attribute only).
- S-RW24: `playwright test --list --project=chromium` (and firefox, webkit) does not list the look-dev spec. Value: protects=the baseline never runs where it has no snapshot; fails_when=`testIgnore` is dropped; why_new=no test reads the project config; seam=none; no_claim=CI skipping (covered by the `CI` guard).

Regression rule: behaviour at risk and its approved contract, carried forward: the version meta tag stays asserted in `e2e/smoke.spec.ts`, and only the heading check goes (CEO S-RW18, intended change); `e2e/repeat.spec.ts` keeps its 0.5% bound on the home view and waits on the ready signal (CEO S-RW20); `01-scaffold.png` and `02-pipeline.png` regenerate with the new look under the section 4 protocol (intended). No new regression contract was needed.

Tests made obsolete (proposal; each needs a retirement card when the spike is deleted): `src/spike/shared/bench.test.ts`, `fakeStore.test.ts`, `scene.test.ts`, `stats.test.ts` and `e2e/spike.spec.ts` (spike-only behaviour); `params.test.ts`, `render.test.ts` and `src/spike/r3f/View.test.ts` move with their code (CEO S-RW3).

Test plan artifact: `~/.gstack/projects/bjorkgard-ai-center/nathanael-phase-2-scene-foundation-eng-review-test-plan-20261013-174235.md`.

Section 3 dispositions: 3 gaps filled under existing approvals (E24, E21, S-RW24); no pending test decision.

### 4. Performance review (eng, Phase 2)

- P-E2 [P3] (confidence: 6/10) Medium confidence, verify this is actually an issue: src/spike/shared/render.ts:20 — `renderer: { antialias: true, ... }` alongside the composer's `multisampling: 4` (`:24`). While bloom is on, the default framebuffer's multisampled buffer receives only the composer's final pass; at 2880x1800 it costs about 83 MB [estimated: 2880 x 1800 x 4 bytes x 4 samples], notable on an 8 GB M1 Air. Turning `antialias` off would drop anti-aliasing in the bloom-off tier unless the composer stays on. Owner: chunk 36, which measures memory and tiers on the M1 Air-class Mac; no change now.
- Note: the monitor's 0.5 s window and the driver keep their samples in typed arrays sized up front, so nothing is allocated per frame (the spike's P-E1 rule, `src/spike/shared/bench.ts`). Implementation note, no plan change.
- No database, queries, caches or jobs in Phase 2. `safeArea` writes are capped at one per frame (CEO S-RW36).

Section 4 dispositions: P-E2 to chunk 36 (measurement owner); no decision needed now.

### Outside voice (eng, Phase 2)

`codex_reviews` is disabled (stored config). Recorded as `outside_status: disabled` (review log, commit `d428146`). No external or native challenge ran.

### TODOS.md (eng, Phase 2)

No TODO proposals. E23 (R3F's planned `advance(delta)` API) is a note for the R3F 10 migration already listed in ADR 0001's consequences; P-E2 belongs to chunk 36.

### Decision ledger (eng review, Phase 2)

### E20: Scene time across gaps
Finding: E20 [P2] (confidence: 8/10), `node_modules/@react-three/fiber/dist/events-9ce18a08.esm.js:1128-1130, 17406` and the 04a render loop (CEO C16), reviewer Claude (in-host)
Plan baseline: CEO C16 (SQ3): R3F `frameloop="never"`, one rAF driver calling `advance()`, 60 fps cap, 30 fps calm mode, paused while the tab is hidden; `freeze=1` stops the scene clock (section 4, CEO S-RW7). Scene time across gaps is unspecified. E19 (applied): `advance()` receives seconds.
Runtime evidence: R3F sets `clock.elapsedTime = 0` when the frameloop is `never` and then uses `delta = timestamp - clock.elapsedTime` on each `advance()`; so the first frame's delta is whatever scene time is passed, and a frame after a hidden tab carries the whole gap. No `useFrame` consumer exists yet (the spike had none).
Comparison grid:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Units passed to `advance()` | E19 (applied, factual) | seconds | seconds | seconds | seconds |
| Scene clock origin | pending | unspecified (R3F counts from 0, the caller picks the timestamp) | 0 at the first rendered frame, so the first delta is 0 | 0 at the first rendered frame | unspecified |
| Gap after a hidden tab, long frame or GC pause | pending | the whole gap reaches `useFrame` | at most 0.1 s per frame [estimated]; animation pauses across the gap | the whole gap (real time) | each animation chunk decides |
| `freeze=1` | section 4, S-RW7 (approved, required) | clock stopped | delta 0 on every render | delta 0 | delta 0 |
| Store and replay time (chunks 11-12) | D4, chunk 12 (approved) | separate | unchanged: data uses event time, not scene time | unchanged | unchanged |
| Tests | pending | none | fake-clock driver tests: first delta 0; 60 s hidden gives at most 0.1 s; freeze gives 0 | fake-clock: first delta 0; gap passes through | none |
| Effort | - | - | S (human ~30 min / CC ~3 min) | S (human ~20 min / CC ~2 min) | S (zero now) |

Question D2:
D2 — E20: What should scene time do across gaps such as a hidden tab or a long pause?
Project/branch/task: Synapse Horizon, branch phase-2-scene-foundation, chunk 04a render driver (CEO C16).
ELI10: With the new render loop, our driver decides what time the 3D scene sees each frame. Animations move by "time since the last frame". Two moments are undefined: the very first frame, where R3F would see all the seconds since the page opened, and the first frame after the tab was hidden for, say, ten minutes. If that whole gap reaches the animations, a packet or cart jumps across the campus in one frame. Option A starts scene time at zero and caps each step at a tenth of a second, so animations pause while you are away and resume smoothly. Live data is not affected: racks and agents follow the store's event times, not scene time.
Stakes if we pick wrong: every animated chunk from 20 to 35 either jumps after a hidden tab, or each one has to remember its own guard and some will not.
Recommendation: A because one cap in the driver protects every later animation and turns the first frame and hidden-tab cases into tested behaviour (edge cases over speed, explicit over clever).
Completeness: A=9/10, B=6/10, C=4/10
Net: one tested guard for all animations (A), real time with jumps (B), or no rule (C).
Header: Scene time
Options:
A) Start at 0, cap each step (recommended)
The driver owns scene time: it starts at 0 on the first rendered frame, advances by the real interval capped at 0.1 s per frame [estimated], and stays still under `freeze=1`; it passes seconds to `advance()`. Fake-clock tests: first delta 0, a 60 s hidden gap gives at most 0.1 s, freeze gives 0. Effort S (human ~30 min / CC ~3 min), risk low. ✅ No animation can jump across the campus after a hidden tab or a long pause ✅ The first frame and frozen frames are defined and tested once, for every later chunk ❌ Ambient animation pauses while the tab is hidden instead of catching up, which differs from wall-clock time
B) Real time from the first frame
Scene time starts at 0 on the first rendered frame and then follows real time with no cap; gaps pass straight to `useFrame`. Fake-clock tests for the first frame and pass-through. Effort S (human ~20 min / CC ~2 min), risk medium. ✅ Scene time always equals elapsed wall-clock time since the first frame ✅ Slightly less driver code than A ❌ After a hidden tab every animation gets the whole gap in one frame unless its own code guards against it
C) Leave it to each animation chunk
No rule in 04a; chunks 20-35 handle first-frame and gap deltas themselves. Effort S (zero now), risk high. ✅ Nothing extra to build or test in 04a ✅ Each animation can choose its own behaviour ❌ Repeats the same guard in a dozen chunks, and any that forget it jump after a hidden tab

State: approved
Actual answer: A) Start at 0, cap each step (recommended), eng D2, 2026-10-13
Accepted scope: the 04a driver owns scene time: 0 at the first rendered frame, advances by the real interval capped at 0.1 s per frame [estimated], still under `freeze=1`, passed to `advance()` in seconds; fake-clock tests (first delta 0, a 60 s hidden gap gives at most 0.1 s, freeze gives 0); store and replay time unchanged.
History: none

Approval readiness: PASS. Checked: E20 (eng D2, A). Structure (eng D1, B) is a scope selector, not a remedy approval. Required work applied without a new choice, each citing its approved contract: E19 (factual: R3F's seconds convention, `events-9ce18a08.esm.js:17402-17406`), E21 (design D22), E22 (CEO S-RW3), E24 (CEO C23, SQ11), E25 (CEO C16 and RW9), and the Section 3 test gaps (E24, E21, S-RW24 proofs). No unanswered remedy is in the plan.


### NOT in scope (eng, Phase 2)

- Further splitting 04a: not proposed; its estimate (about 95 CC-minutes) is close to chunk 03's, which shipped as one PR (eng D1 record).
- Turning off renderer `antialias` while the composer runs (P-E2): left to chunk 36, which measures memory on the M1 Air-class Mac.
- A shared URL-contract module for `params.ts` and `shots.config.ts`: not proposed (two callers in different runtimes, savings under 10 lines).
- Adapting to R3F's planned `advance(delta)` API (E23): belongs to the R3F 10 migration listed in ADR 0001.
- Codex outside voice: disabled by config.

### What already exists (eng, Phase 2)

- R3F `gl` factory (`configuration.d.ts:11`): reused for E24 instead of a wrapper component.
- R3F `advance()` under `frameloop="never"` (`events-9ce18a08.esm.js:17498`): reused by the driver with seconds (E19, E20).
- The spike's boundary-method tests (`src/spike/r3f/View.test.ts:4-21`) and injected scheduler (`src/spike/shared/bench.ts:169-184`): reused for the C23 and driver tests; no DOM library or new test dependency is needed.
- Playwright `--list` (`playwright test --help`): reused for the S-RW24 check.

### Failure modes (eng, Phase 2)

```text
  NEW PATH                 | REALISTIC FAILURE                                    | TEST                   | HANDLING                          | USER SEES
  -------------------------|------------------------------------------------------|------------------------|-----------------------------------|------------------------------
  renderer creation (E24)  | context creation fails after the pre-check passed    | unit (stubbed ctor)    | gl factory -> WebGLUnavailable    | D11 WebGL card
  driver under StrictMode  | effect runs twice in vp dev, two loops               | unit (remount)         | stop functions as cleanup         | none needed
  scene time (E19, E20)    | ms passed to advance(); hidden-tab gap jumps          | unit (fake clock)      | seconds; origin 0; 0.1 s cap      | smooth resume
  restore toast (E21)      | toast not announced                                  | e2e (aria-live attr)   | polite live region                | announced toast
  look-dev spec            | browser projects run it without a snapshot           | --list check           | testIgnore                        | none needed
  composer memory (P-E2)   | MSAA default framebuffer unused while bloom is on    | chunk 36 measurement   | quality tier, pixel ratio         | possible memory pressure
```
Critical gaps: 0 (no row lacks both a test and handling while failing silently).

### Worktree parallelization strategy (eng, Phase 2)

| Step | Modules touched | Depends on |
|------|----------------|------------|
| 04a scene core | `src/app/`, `src/scene/`, `e2e/`, `scripts/`, `vite.config.ts`, `playwright.config.ts`, package files | — |
| 04b UI shell | `src/dashboard/`, `src/styles/`, `src/app/store/` (ui slice), `e2e/`, `scripts/shots.config.ts` | 04a |
| 04c look | `src/scene/` (lights, materials, look-dev), `e2e/`, `playwright.config.ts`, `scripts/shots.config.ts`, `docs/designs/` | 04a |
| 05 camera | `src/scene/` (controls, cameraRig, keys), `src/dashboard/` (dev menu), `e2e/` | 04b |
| 11 data track | `src/data/`, `src/app/store/` (new slice files) | 04a |

Lane A: 04a (shared foundations, sequential first). Lane B: 04b → 05 (`src/dashboard/`, then camera). Lane C: 04c (`src/scene/` look files). Lane D: chunk 11 (`src/data/`). Execution order: build 04a and merge it; then launch B, C and D in parallel worktrees; merge C before 05 starts if 05 touches `src/scene/` files near the look. Conflict flags: `scripts/shots.config.ts` and `e2e/` receive appends from B and C (trivial merges); `playwright.config.ts` is edited by 04a (CI WebGL options) and 04c (look-dev project), so C starts after 04a merges; `src/app/store/` takes one slice file per lane.

## Implementation Tasks (eng review, Phase 2)

Synthesized from this review's findings; they extend the CEO Phase 2 tasks T1-T8 rather than replace them. Effort ratios assumed: features ~30x, tests ~50x, config ~30x.

- [x] **T1 (P1, human: ~1h / CC: ~5min)** — 04a render loop — Pass scene time in seconds; start at 0; cap each step at 0.1 s; still under freeze
  - Surfaced by: Scope Challenge — E19; eng D2 (E20)
  - Files: src/scene/loop/driver.ts, src/scene/loop/driver.test.ts
  - Verify: `vp test` (first delta 0, 60 s hidden gap gives at most 0.1 s, freeze gives 0, `advance()` receives seconds)
- [x] **T2 (P2, human: ~1h / CC: ~5min)** — 04a WebGL — Create the renderer through the `gl` factory and rethrow `WebGLUnavailableError`
  - Surfaced by: Architecture — E24
  - Files: src/scene/webgl.ts, src/scene/webgl.test.ts, src/scene/SceneCanvas.tsx, src/scene/SceneBoundary.tsx
  - Verify: `vp test` stubbed-constructor test; e2e `?webgl=0` still shows the D11 card
- [x] **T3 (P2, human: ~1h / CC: ~5min)** — 04a lifecycle — Stop functions for the driver and every listener; StrictMode remount test
  - Surfaced by: Architecture — E25
  - Files: src/scene/loop/driver.ts, src/scene/loop/monitor.ts, src/scene/webgl.ts, src/app/store/ui.ts, src/scene/loop/driver.test.ts
  - Verify: `vp test` (mount, unmount, remount: one scheduled callback, baseline listener counts)
- [x] **T4 (P2, human: ~30min / CC: ~3min)** — 04a structure — Apply the smaller arrangement (quality tier in the store and `render.ts`; `webgl.ts` plus `SceneBoundary.tsx`)
  - Surfaced by: Scope Challenge — eng D1
  - Files: src/scene/render.ts, src/app/store/ui.ts, src/scene/webgl.ts, src/scene/SceneBoundary.tsx
  - Verify: `vp check`; no `src/scene/quality.ts` or `src/scene/webgl/` directory exists
- [x] **T5 (P2, human: ~30min / CC: ~3min)** — 04b shell — Restore toast in an `aria-live="polite"` region, asserted in e2e
  - Surfaced by: Scope Challenge — E21; Test review gap
  - Files: src/dashboard/ToastHost.tsx, e2e/shell.spec.ts
  - Verify: `vp run e2e:local` toast spec checks the live region
- [x] **T6 (P3, human: ~15min / CC: ~2min)** — 04a cleanup — Remove the spike-only version defines, reword the preview-headers comment, add one globals declaration
  - Surfaced by: Scope Challenge — E22; Code quality — Q-E3
  - Files: vite.config.ts, src/app/globals.d.ts, src/spike/spike-globals.d.ts (deleted)
  - Verify: `vp check`; `grep -n "__THREE_VERSION__\|__R3F_VERSION__" -r src vite.config.ts` finds nothing
- [x] **T7 (P3, human: ~15min / CC: ~2min)** — 04c tests — Check the browser projects do not list the look-dev spec
  - Surfaced by: Test review — S-RW24 gap
  - Files: playwright.config.ts
  - Verify: `playwright test --list --project=chromium --project=firefox --project=webkit` output has no look-dev spec

_No new tasks from Performance review (P-E2 is owned by chunk 36)._

### Reality rows (eng, Phase 2)

- REALITY: premise-table finding unverified=3 (R3F issue #2688's `advance(delta)` change has not been confirmed as shipped; the 83 MB MSAA figure is an estimate; `WEBGL_lose_context` restore in Playwright's WebKit is unprobed) docs/PLAN.md:455
- REALITY: already-done pass `git log origin/main -- src/spike` shows only `d428146` (#11, the spike); no scene, shell or camera code on main docs/PLAN.md:455
- REALITY: surface-check pass R3F `gl` factory type (`node_modules/@react-three/fiber/dist/declarations/src/core/configuration.d.ts:11`), `advance()` (`events-9ce18a08.esm.js:17498`), the rethrow (`react-three-fiber.esm.js:61`), three's context error (`WebGLRenderer.js:421`) and `playwright test --list` (`playwright test --help`, line 43) all exist as the plan uses them docs/PLAN.md:455
- REALITY: binding-decisions pass CEO C15-C23 and S-RW1 to S-RW40 honoured; `gstack-decision-search --scope branch` returns the Phase 2 CEO record; eng D1 and D2 logged docs/PLAN.md:34
- REALITY: numbers finding 04a effort about 95 CC-minutes, 43 files, 83 MB and the 0.1 s cap are [estimated]; R3F and three line numbers are [measured: source read] docs/PLAN.md:455
- REALITY: deferred-asks pass no linked issue; nothing requested for Phase 2 is left out; C18 stays deferred with its trigger TODOS.md:19
- REALITY: pr-count pass no `.gstack/ship-policy.json`; Phase 2 is four chunk PRs (04a, 04b, 04c, 05) plus this branch's review-docs PR (D18) docs/PLAN.md:31

PLAN_REALITY: phase=eng rows=7/7 missing=none unverified=3 verdict=complete

### Unresolved decisions (eng, Phase 2)

None in this review. Carried from the CEO review and owned by `/plan-design-review`: UI-1 scene-error card copy, UI-2 canvas focus ring, UI-3 loader fade. Open verifications (not decisions): WebGL2 in headless CI browsers (S-RW30); `WEBGL_lose_context` restore in Playwright's WebKit; Safari trackpad pinch; R3F's `advance()` API on the next major upgrade (E23).

### Completion summary (eng, Phase 2)

- Step 0: Scope Challenge — scope accepted as-is (smaller arrangement, eng D1)
- Reality rows: 7/7 applicable rows emitted (`PLAN_REALITY` complete), 3 unverified premises
- Architecture Review: 2 issues found (E24, E25)
- Code Quality Review: 0 issues found (2 P3 notes)
- Test Review: diagram produced, 3 gaps identified (all filled under existing approvals)
- Performance Review: 1 issue found (P-E2, owned by chunk 36)
- Scope Challenge findings, reported separately: 5 (E19-E23); E19, E21, E22 applied, E20 decided (eng D2), E23 note
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 0 items proposed to user
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, disabled (config)
- Parallelization: 4 lanes, 3 parallel / 1 sequential first (04a)
- Lake Score: N/A (eng D2 scored 9/6/4; no 10/10 option offered)


## Design review record: Phase 2 (/plan-design-review, 2026-10-13)

Target: `docs/PLAN.md` Phase 2 (chunks 04a, 04b, 04c, 05), branch `phase-2-scene-foundation`, after the Phase 2 CEO and eng reviews. Reviewer: Claude (in-host), plus one independent Claude subagent (Codex disabled). Question numbers D1, D2... are this review's own sequence; findings are numbered DR1, DR2...

System audit: no DESIGN.md (the 2026-10-12 design review deferred one; tokens live in section 4b and `src/styles/tokens.css`); Phase 2 UI scope: canvas, loader, WebGL card, scene-error card (C23), restore toast and toast host, two-layer GlassPanel (C21), empty shell slots, keyboard-focusable canvas, and dev-only HUD, dev menu and look-dev view. Prior design review on `main` (2026-10-12): 4/10 to 7/10 overall; weakest remaining passes were design system (8), accessibility (8) and AI slop (7).

Step 0: initial rating 6/10 (states named, but loader, card, toast, glass and focus details missing). Focus: all 7 passes with mockups (D1).

### Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| Scene-error card (UI-1) | /Users/nathanael/.gstack/projects/bjorkgard-ai-center/designs/scene-error-card-20261013/variant-C.png | compact card: inline red square icon, title, one body line, outlined cyan Reload, Copy error details, Mono error line with expand chevron | not adopted from the image: mono body text (D16 Sans), the red-highlighted Errors tab, the "UTC" clock (D15 local time); canvas size and card width in the image are not to scale |
| Shell, restore toast and canvas focus (UI-2) | /Users/nathanael/.gstack/projects/bjorkgard-ai-center/designs/shell-focus-toast-20261013/variant-C.png | four cyan corner brackets frame the visible canvas area on keyboard focus; restore toast bottom-right above the tab strip with a small cyan spinner | the job tracker in the image is a vertical list; section 4b's layout and the mockup variant-B-2 still govern slot shapes |

Mockup generation: 6 images requested, 5 saved (one timed out); the vision check flagged every image for canvas size and card width, which the user was told before choosing.

### Outside voice (design, Phase 2)

CLAUDE SUBAGENT (design completeness) [single-model], 13 findings, folded into the passes below as DR1-DR13. Codex disabled (`codex_reviews`), recorded `outside_status: disabled`.

### Pending findings (each needs its own decision)

- DR1 [critical] Non-success layering: what the canvas area shows while loading, restoring, after a scene error or when WebGL is unavailable, and whether the shell sits above the loader (section 4b D10/D11; chunk 04a). Pass 1.
- DR2 [high] Loader indicator and exit: the "progress line" has nothing to measure; UI-3 fade (D10; chunk 04b). Pass 2.
- DR3 [critical] WebGL card anatomy and placement: D11 says "full-viewport glass card" while panels keep working (section 4b D11). Pass 2.
- DR4 [high] WebGL card wording after the 10 s restore timeout, when the browser did start 3D (S-RW10). Pass 2.
- DR5 [medium] Precedence when several failure states apply. Pass 2.
- DR6 [high] No message when the 3D view recovers (journey ends silently). Pass 3.
- DR7 [high] Glass blur amount and fallback transition (design D18). Pass 5.
- DR8 [medium] No secondary or muted text colour token. Pass 5.
- DR9 [medium] Toast anatomy values. Pass 5.
- DR10 [medium] Empty shell slot sizes. Pass 5.
- DR11 [medium] Dev-only surfaces (HUD, dev menu, right-panel toggle, look-dev framing) unspecified. Pass 7.
- DR12 [high] The canvas has no place in the D22 tab order. Pass 6.
- DR13 [medium] Camera key step sizes and held-key behaviour. Pass 6.
- DR14 [high] Both cards are silent to screen readers; focus and "Copy error details" content unspecified. Pass 6.
- DR15 [medium] Static canvas `aria-label` copy. Pass 6.


### Pass 1: Information architecture (Phase 2) — 7/10 → 9/10

```text
  LAYER STACK (top to bottom)                 WHAT THE USER SEES FIRST, SECOND, THIRD
  5  toast host (bottom-right)                1  a card, when one is showing (WebGL or scene error)
  4  WebGL card / scene-error card            2  the shell: top bar, KPI tiles, job tracker, tab strip
  3  shell: top bar, slots, tab strip         3  the 3D area: loader, campus, or dimmed last frame
  2  loader (3D area only)
  1  3D area: canvas | --color-bg | last frame under a 60% --color-bg overlay (scene error)
```

- DR1 resolved: D5 answer "1A Dim last frame, panels early (recommended)", applied to chunk 04b. Re-rated 9: every Phase 2 state now has a defined stack; the remaining gap is the right panel's content order, which belongs to chunk 29.


### Pass 2: Interaction state coverage (Phase 2) — 5/10 → 9/10

```text
  FEATURE          | LOADING                         | EMPTY                  | ERROR                                        | SUCCESS            | PARTIAL
  3D area          | loader: 300 ms delay, sweep     | test cube (04a)        | WebGL card (start / lost wording);           | campus renders     | bloom off, solid glass
                   | line, fade out (DR2)            |                        | scene-error card over dimmed last frame      |                    | (frame monitor)
  WebGL card       | -                               | -                      | DR3 layout, DR4 wording; Reload; help link   | late restore hides | -
  Scene-error card | -                               | -                      | approved mockup (UI-1); Reload; copy details | -                  | -
  Restore toast    | spinner while restoring         | -                      | hidden while a card shows (DR5)              | clears on ok       | -
  Shell slots      | visible from first paint (DR1)  | placeholder titles     | -                                            | glass slots        | solid fallback
```

- DR2 resolved: D6 "2A Moving line, delay, fade (recommended)" (also settles UI-3). DR3 resolved: D7 "3A Same layout, in 3D area (recommended)", reopening design D11's "full-viewport" wording on new evidence (D11's own "panels still render" and the approved card layout); section 4b D11 annotated. DR4 resolved: D8 "4A Separate, accurate wording (recommended)". DR5 resolved: D9 "5A Fixed severity order (recommended)". Re-rated 9: the remaining gap is the recovery message (Pass 3).


### Pass 3: User journey and emotional arc (Phase 2) — 7/10 → 9/10

```text
  STEP | USER DOES                                  | USER FEELS             | PLAN SPECIFIES
  -----|--------------------------------------------|------------------------|--------------------------------------------------
  1    | Opens the app                              | curious                | panels from first paint; loader only after 300 ms (DR1, DR2)
  2    | Sees the scene arrive                      | "it's alive"           | loader fades over --dur-ui (DR2); look-dev-tuned look (04c)
  3    | Tabs into the 3D view, uses arrow keys     | in control             | corner brackets on keyboard focus (UI-2); camera keys (C19)
  4    | Leaves the tab open all afternoon          | unbothered             | 30 fps calm mode (C16); no jump on return (E20)
  5    | GPU hiccup: toast "Restoring 3D view"      | slight worry           | sticky toast while restoring (S-RW13)
  6    | View comes back                            | relieved, reassured    | "3D view restored" toast, 6 s (DR6)
  7    | View does not come back                    | let down, but informed | "lost its graphics connection" card + Reload (DR4)
  8    | A bug stops the scene                      | annoyed, not lost      | dimmed last frame, scene-error card, Copy error details (UI-1, DR1)
```
Time horizons: 5 s visceral (steps 1-2), 5 min behavioural (step 3), long-term reflective (steps 4-8: the failure paths are honest and recover).

- DR6 resolved: D10 "6A Show \"3D view restored\" (recommended)", applied to chunk 04b. Re-rated 9: the remaining gap is the first visit without data, which belongs to the data chunks (D9 empty states).


### Pass 4: AI slop risk (Phase 2) — 7/10 → 7/10

Classifier: OPERATE (app UI, a dashboard). Hard rejections: none (the shell is a fixed layout, not stacked cards; the KPI tiles and error cards are the only cards and each carries data or an action). Litmus, from the approved mockups and plan text: brand in first screen YES (wordmark top-left); one visual anchor YES (the 3D campus); scannable by titles YES (slot titles); one job per section YES; cards necessary YES (KPI numbers, error actions); motion helps YES (loader fade, calm mode, no count-ups); premium without decorative shadows YES (glass border only, no shadows specified). No new issue. The score stays 7 because of the accepted dark neon-glass look (design D14, D18; earlier design review), a tradeoff the user already chose.

### Pass 5: Design system alignment (Phase 2) — 5/10 → 8/10

- DR7 resolved: D11 "7A 16 px blur, fade switch (recommended)", applied to section 4b "Glass panel" and chunk 04b.
- DR8 resolved: D12 "8A Two tinted greys (recommended)", applied to chunk 04b; contrast measured after the answer at 7.3:1 and 5.4:1 against the true night-glass composite `#1B1E25` (the question quoted 7.8:1 and 5.8:1 against an approximate `#141720`; both pass either way).
- DR9 resolved: D13 "9A Fixed 320 px, tokens (recommended)", applied to section 4b D12 and chunk 04b.
- DR10 resolved: D14 "10A Fixed, from the mockup (recommended)", applied to section 4b D5 and chunk 04b.
- DESIGN.md: still absent; the 2026-10-12 design review deferred a full DESIGN.md (tokens live in section 4b), so no new question. Re-rated 8: the remaining gap is the missing DESIGN.md file itself.


### Pass 6: Responsive and accessibility (Phase 2) — 6/10 → 9/10

- Responsive: desktop only from 1280x720 (D1, section 4b); windows below it frame targets in the full canvas (CEO S-RW38). No new issue.
- DR12 resolved: D15 "12A After the top bar (recommended)", applied to section 4b D22 and chunk 05.
- DR13 resolved: D16 "13A Relative steps, smooth hold (recommended)", applied to chunk 05.
- DR14 resolved: D17 "14A Announce, keep focus (recommended)", applied to chunks 04a and 04b.
- DR15 resolved: D18 "15A Short name + key description (recommended)", applied to chunks 05 and 24.
- Carried, no question: the corner brackets show on keyboard focus only (`:focus-visible`), which is the meaning of "keyboard focus" in the approved UI-2 direction.
Re-rated 9: the remaining gap is screen-reader testing on real assistive tech, which stays with chunk 37's audit.


### Pass 7: Unresolved design decisions (Phase 2)

```text
  DECISION NEEDED                                  | RESOLUTION
  -------------------------------------------------|-------------------------------------------------------------
  UI-1 scene-error card copy (CEO)                 | approved mockup C (D2 board, D3 confirmation)
  UI-2 focus ring on the full-viewport canvas (CEO)| corner brackets on :focus-visible (D2 board, D3)
  UI-3 loader fade (CEO)                           | D6 (DR2): sweep line, 300 ms delay, fade over --dur-ui
  DR11 dev-only screens                            | D19 "11A Fixed spots and framing (recommended)"
  DR16 Safari has no hardware-acceleration switch  | D20 "16A Advice per browser (recommended)"
```

DR16 was found in this pass: it follows from the DR3 wording and the supported browsers (D1); the Safari claim is unverified in this session. 5 resolved, 0 deferred.


Post-pass mockups: D21 answer "Keep the current mockups (recommended)"; the two approved images stay the visual reference and the written spec governs the values changed in the passes.

### Approval reconciliation (design, Phase 2)

Every applied fix has its own answer: UI-1 and UI-2 (D2 board submissions, D3 confirmation), DR1 (D5), DR2 and UI-3 (D6), DR3 (D7, reopening design D11 on new evidence), DR4 (D8), DR5 (D9), DR6 (D10), DR7 (D11), DR8 (D12), DR9 (D13), DR10 (D14), DR12 (D15), DR13 (D16), DR14 (D17), DR15 (D18), DR11 (D19), DR16 (D20). Carried without a new question: the brackets show on `:focus-visible` (the "keyboard focus" wording confirmed in D3). Pass 4 made no change. Setup and navigation answers (D1, D4, D21) approved no fix.

### NOT in scope (design, Phase 2)

- A full DESIGN.md: deferred by the 2026-10-12 design review (tokens live in section 4b); `/design-consultation` can create one later.
- Regenerated mockups after the passes: declined (D21).
- Screen-reader testing on real assistive technology: stays with chunk 37's audit.
- The right panel's content order: chunk 29.
- First-visit empty-data states: the data chunks (design D9).
- Revisiting the dark neon-glass look: an accepted tradeoff (design D14, D18).

### What already exists (design, Phase 2)

`src/styles/tokens.css` (type, spacing, radius, status palette), section 4b decisions D5-D26, the approved mockup variant-B-2, the two Phase 2 mockups above, the D11 card text and the D12 toast placement and timing. All Phase 2 values reuse these tokens; the two new tokens are the quiet text greys (DR8).

### TODOS.md (design, Phase 2)

No TODO proposals: no decision was deferred.

## Implementation Tasks (design review, Phase 2)

Synthesized from this review's findings; they extend the CEO tasks T1-T8 and the eng tasks T1-T7. Effort ratios assumed: features ~30x, tests ~50x.

- [x] **T1 (P1, human: ~2h / CC: ~10min)** — 04b loader — Indeterminate sweep line, 300 ms delay, fade over --dur-ui; loader over the 3D area only; non-drawing backgrounds and the dimmed last frame
  - Surfaced by: Pass 1 — DR1; Pass 2 — DR2 (UI-3)
  - Files: src/dashboard/shell/Loader.tsx, src/dashboard/shell/Shell.tsx, src/scene/SceneBoundary.tsx, e2e/shell.spec.ts
  - Verify: e2e: shell visible before the first frame; no loader on a start under 300 ms (fake timer); reduced motion cuts instantly
- [x] **T2 (P1, human: ~3h / CC: ~15min)** — 04a/04b cards — One card component for WebGL and scene errors: approved layout, safe-area placement, start / lost / Safari wording, precedence, role="alert", Copy error details payload
  - Surfaced by: Pass 2 — UI-1, DR3, DR4, DR5; Pass 6 — DR14; Pass 7 — DR16
  - Files: src/scene/SceneBoundary.tsx, src/dashboard/ErrorCard.tsx, src/dashboard/ErrorCard.test.ts, src/scene/webgl.ts
  - Verify: unit tests per wording branch (start, lost, Safari/unknown) and per precedence pair; e2e `?webgl=0` card centred in the safe area with panels usable; clipboard contains message, `[scene]` lines, version, user agent
- [x] **T3 (P2, human: ~1h / CC: ~5min)** — 04b toasts — 320 px token-based toast anatomy and the "3D view restored" toast
  - Surfaced by: Pass 3 — DR6; Pass 5 — DR9
  - Files: src/dashboard/ToastHost.tsx, e2e/shell.spec.ts
  - Verify: e2e: after `restoreContext()` the restored toast shows for 6 s in the polite live region; stacked toasts share one left edge
- [x] **T4 (P1, human: ~2h / CC: ~10min)** — 04b design system — Glass blur and fallback crossfade, quiet text tokens, slot sizes, placeholder titles
  - Surfaced by: Pass 5 — DR7, DR8, DR10
  - Files: src/styles/tokens.css, src/styles/tokens.test.ts, src/dashboard/GlassPanel.tsx, src/dashboard/shell/Shell.tsx
  - Verify: tokens test asserts `--color-text-2`, `--color-text-3` and the glass values; e2e slot sizes at 1280x720 and 1920x1080; Firefox fallback crossfades with tint and border kept
- [x] **T5 (P1, human: ~2h / CC: ~10min)** — 05 keyboard camera — Corner brackets on `:focus-visible`, Tab position after the top bar, label and key-help description, DR13 step sizes
  - Surfaced by: Pass 6 — UI-2, DR12, DR13, DR15
  - Files: src/scene/controls.tsx, src/scene/keys.ts, src/scene/keys.test.ts, src/dashboard/shell/FocusBrackets.tsx, e2e/camera.spec.ts
  - Verify: e2e: one Tab from the top bar focuses the canvas and shows brackets; mouse click shows none; one arrow press pans 10% of the short side
- [x] **T6 (P3, human: ~1h / CC: ~5min)** — dev surfaces — HUD position and style, dev menu under it, right-panel toggle, look-dev framing
  - Surfaced by: Pass 7 — DR11
  - Files: src/scene/PerfHud.tsx, src/dashboard/DevMenu.tsx, src/scene/LookDev.tsx
  - Verify: `04a-core.png` shows the HUD top-right without covering a slot; look-dev baseline stable across two runs

_No new tasks from Pass 4 (AI slop)._

### Completion summary (design, Phase 2)

```text
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | no DESIGN.md (deferred earlier); Phase 2 UI: |
  |                      | canvas, loader, 2 cards, toasts, glass,     |
  |                      | shell slots, focusable canvas, dev screens  |
  | Step 0               | 6/10; all 7 passes with mockups (D1)        |
  | Pass 1  (Info Arch)  | 7/10 → 9/10 after fixes                     |
  | Pass 2  (States)     | 5/10 → 9/10 after fixes                     |
  | Pass 3  (Journey)    | 7/10 → 9/10 after fixes                     |
  | Pass 4  (AI Slop)    | 7/10 → 7/10 after fixes                     |
  | Pass 5  (Design Sys) | 5/10 → 8/10 after fixes                     |
  | Pass 6  (Responsive) | 6/10 → 9/10 after fixes                     |
  | Pass 7  (Decisions)  | 5 resolved, 0 deferred                      |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (6 items)                           |
  | What already exists  | written                                     |
  | TODOS.md updates     | 0 items proposed                            |
  | Approved Mockups     | 5 generated (6 requested), 2 approved       |
  | Decisions made       | 18 added to plan                            |
  | Decisions deferred   | 0                                           |
  | Overall design score | 5/10 → 7/10                                 |
  +====================================================================+
```

Overall score basis: the lowest rated pass, before (Passes 2 and 5 at 5) and after (Pass 4 at 7). Pass 4 stays at 7 because of the accepted dark neon-glass look (design D14, D18), not an open finding; every other pass is 8 or more.

### Unresolved decisions (design, Phase 2)

None.

## CEO review record: Phase 3 (/plan-ceo-review, 2026-10-14)

Target: Phase 3 (chunks 06, 07, 08, 09, 10) of `docs/PLAN.md`, branch `phase-3-world-building`, base `main` at `5cc28e9`. Reviewer: Claude (in-host). Review depth: implementation-ready, Phase 3 only. No Phase 3 design doc exists; the finder returns `docs/designs/phase-2-scene-foundation.md` (the Phase 2 CEO summary). Questions in this record are numbered WQ1, WQ2... (shown in chat as D1, D2...); ledger rows continue the CEO series at C24. Findings are numbered W-F1, W-F2..., required work W-RW1, W-RW2..., so they do not collide with earlier series.

### 0A. Premise (Phase 3)

- Real problem: the approved mockup (design D14) is the product's identity, and every data-driven chunk (18-23) needs a place to put things: halls with rack slots, a campus with hall slots and roads, a waypoint graph for vehicles, cooling and power parts whose motion later follows load, and fibre lines for packets.
- Target outcome: a static campus that matches variant-B-2, built in code, whose moving parts (rack count, LED pulse, duty, packet rate, hall slots) already run from dev controls, so chunks 18-23 only rebind them to the store.
- Do-nothing cost: Phase 5 cannot start; chunk 18 depends on 10.
- Phase 3 as written solves this directly, with these gaps:
  - W-F1 [P1] Nobody owns the campus size [measured: `src/scene/camera.ts:21` `CAMPUS_BOUNDS` half extents 14 x 14 with the comment "chunk 06 sizes the real campus"; `src/scene/Ground.tsx:5` ground 40 units; `src/scene/LightRig.tsx:3` shadow camera +-12]. A 12-slot campus with roads, cooling, power, parking and gate is about 60 x 45 units [estimated], so camera clamps, home framing, ground and the one 2048 shadow map are all sized for the test cube. `ORTHO_ZOOM.min` is 10 (`camera.ts:15`) and the home fit of a campus that size is about 11 px per unit at 1280x720 [estimated], so a slightly larger campus could not be framed at all.
  - W-F2 [P1] Draw-call bars have no counting rule [measured: three 0.186.1 `WebGLShadowMap.js:548` draws casters through `renderBufferDirect`, which counts in `info.render.calls` (`WebGLBufferRenderer.js:15`, `WebGLInfo.js:20`)]. The 04a HUD's scene number includes the shadow pass, so a shadow-casting mesh costs 2. Chunk 06's "static hall costs 3 or fewer draw calls" cannot hold for a shadow-casting body plus emissive windows plus a sign texture (at least 4) [inference]. No budget exists for the full static campus (12 halls), although chunk 36 adds a CI test that "fails when exceeded".
  - W-F3 [P1] The first five seconds may look empty [inference from `camera.ts:302-318`: `home()` frames `CAMPUS_BOUNDS`]. Halls A and B always exist (D8) and the grid holds 12 slots, so a fresh campus is 2 halls among 10 empty slots. If home frames the whole grid, halls are about 90 px wide [estimated] and most of the frame is bare ground; variant-B-2 frames about three halls and the plant. Storyboard step 2 ("Sees the campus (5 s)", "delight") depends on this view, and `08-campus.png` becomes the README hero.
  - W-F4 [P1] Mockup parts and a later dependency have no builder [measured: chunk 34 Tasks "night mode raises emissive LEDs, hall lights, road lamps"; chunk 08 Tasks list roads, parking, gate, dock only]. Road lamps are needed by chunk 34. Variant-B-2 also shows perimeter trees, a fence and the "SYNAPSE AI DATA CENTRE" monument at the gate; no chunk builds them.
  - W-F5 [P1] Chunk 08 lost its mockup check [measured: section 4b D14 "Chunks 04c and 08 compare a frozen screenshot against variant-B-2"; section 7 risk "compare screenshot to mockup at 04 and 08"; chunk 08 Acceptance has no such item].
  - W-F6 [P2] The hall sign conflicts with design D7 [measured: chunk 06 Acceptance "at least 12 CSS px at default zoom"; D7 "Label text is never smaller than 12 CSS px on screen"]. A floor sign shrinks with zoom, so it breaks D7 when zoomed out unless it hides; "default zoom" is undefined (`ORTHO_ZOOM.default` 80 against a home fit near 11). The semantic-zoom threshold that chunk 18's billboards use is not defined anywhere. Floor text also reads upside down after a 180 degree rotation (C19 `Q`/`E`).
  - W-F7 [P1] Later per-hall looks would need per-hall materials [measured: chunk 04c "shared instances only (no per-mesh materials)"; chunk 18 dormant halls "desaturated materials"; chunk 22 heat wash "shader tint on aisle tiles" per hall]. Unless chunk 06 builds the hall so per-hall tint goes through instance or vertex colour (or shared variant materials), chunks 18 and 22 must break the 04c rule.
  - W-F8 [P1] Phase 3 has no shot views and no deterministic fakes [measured: `src/app/params.ts:79` allows `view` home and lookdev only; section 4 "Each chunk adds its view name(s)"]. Chunks 06, 07, 09 and 10 need README images. The fake load pulse (07), duty (09) and packet motion (10) must be pure functions of scene time and `seed`, or `freeze=1` shots and baselines drift (section 4; chunk 22 "no hidden randomness").
  - W-F9 [P2] Three acceptance items cannot fail or cannot run: 07 "without frame hitches" (no measure); 09 "no transparency sorting artefacts in Safari or Firefox" (Playwright WebKit is not Safari, eng E12); 09 and 10 animate but check no reduced-motion mode (design D20: "Every animated chunk checks both modes in its acceptance"; D20 already sets vapour density 30% and packets 25% speed).
  - W-F10 [P2] Pure logic without tests: the rack slot allocator (07), the hall-slot allocator and the waypoint graph (08) have no unit tests in their acceptance, and 07 does not say what a 17th rack key gets (overflow belongs to the chunk 19 reconciler, D8).
  - W-F11 [P2] Vapour could bloom [measured: `src/scene/render.ts:30` bloom `luminanceThreshold` 0.6; `src/scene/materials.test.ts` checks glow materials sit above it]. White vapour near full alpha crosses the threshold and the towers glow, the "generic neon" risk in section 7.
  - W-F12 [P2] Fibre routing is unspecified: "curved tubes from vault to each hall slot" would cut across hall footprints, while variant-B-2 runs fibre along the roads with rounded right-angle bends. "Each hall slot" and "rebuilt when hall set changes" disagree on whether empty slots get a line.
  - W-F13 [P2] Sequencing: chunk 18 depends on 10 (section 6), but binds only racks in halls A and B (chunks 07, 08); chunk 22 is the first user of cooling (09) and fibre (10). The first live-data scene waits on two set-dressing chunks.
  - W-F14 [P3] Five README images are the same shot [measured: `scripts/shots.config.ts:10-14` captures 01, 02, 04a, 04b and 04c-scene from `view=home`; four are 33.8 KB in `docs/img/`]. After chunk 08 all five become the campus.

### 0B. Existing code leverage (Phase 3)

| Sub-problem | Existing code | Plan as written | Reuse |
|---|---|---|---|
| Hall slab, wall, windows, roof | `Hall()` and `Block()` in `src/scene/LookDev.tsx:8-71`, `SLAB` and `RACK` in `src/scene/lookdevLayout.ts` | `buildHall` from scratch | generalise into `buildHall`; look-dev renders `buildHall` output |
| Rack and LED placement, six status colours | `ledPlacements()` in `lookdevLayout.ts:15-25` | chunk 07 instances | same layout maths feeds the instance matrices |
| Shared materials, dispose guard | `MATERIALS`, `statusLed()` (`src/scene/materials.ts`), `guardDisposeEvents` (`src/scene/render.ts`) | new materials | join the library; guard covers them |
| Glow above the bloom threshold test | `src/scene/materials.test.ts` | none for vapour | mirror it: vapour stays below |
| Merged static geometry | three `mergeGeometries` (`three/examples/jsm/utils/BufferGeometryUtils.js:133`, installed with three 0.186.1) | "merged geometry" | use it; it returns null and logs `console.error` on mismatched attributes |
| Ground and grid | `src/scene/Ground.tsx` (40 units) | not mentioned | size from the campus layout |
| Shadow camera | `src/scene/LightRig.tsx` (+-12) | not mentioned | fit to the campus layout |
| Bounds, home, clamps | `CAMPUS_BOUNDS`, `home()`, `clampTarget` (`src/scene/camera.ts`) | not mentioned | derive from the campus layout |
| Empty-ground double-click | `isEmptyGround` (`src/scene/pick.ts`, `userData.ground`) | not mentioned | hall floors and roads stay non-ground, so a double-click on them does not go home |
| Dev controls | collapsible Camera section in `src/scene/PerfHud.tsx:54-87`, `window.__sceneDev` (`src/scene/devHooks.ts`) under `dev=1` | "dev slider", "dev toggle", "dev menu" | new sections there; hooks for Playwright |
| Draw-call split | `src/scene/drawCalls.ts`, `MarkPass.ts` | budgets | budgets read the HUD's scene number |
| Views and shots | `src/app/params.ts`, `scripts/shots.config.ts` | images only | add view names and entries |
| Look-dev baseline | `e2e/lookdev.spec.ts`, `e2e/__screenshots__/` | each chunk extends it (C17) | as planned |
| Per-hall instanced meshes, owned geometry disposal | ADR 0001 RW6, RW8 | chunk 07 | as planned |

New dependencies needed: none.

Reality rows:
- REALITY: premise-table finding unverified=3 (campus extent about 60 x 45 units and home fit about 11 px per unit at 1280x720; Safari sorting of instanced vapour; floor-sign legibility under ACES tone mapping and bloom) docs/PLAN.md:505
- REALITY: already-done pass `git log origin/main -- 'src/scene/*hall*' 'src/scene/*campus*' 'src/scene/*rack*'` is empty; only the look-dev vignette (`src/scene/LookDev.tsx`) draws a hall-like slab docs/PLAN.md:505
- REALITY: surface-check finding `mergeGeometries` exists in three 0.186.1 (`BufferGeometryUtils.js:133`); `vp run shots` and `vp run e2e:local` exist (`package.json:17-18`); `view` accepts only `home` and `lookdev` (`src/app/params.ts:79`), so every Phase 3 view name is new docs/PLAN.md:510
- REALITY: binding-decisions pass D7, D8, D9, D10, D12, D14, D17, D20, C16 (calm mode), C17 (look-dev per chunk), C22 (06 depends on 04c and 05) and ADR 0001 (per-hall instanced meshes) honoured; `gstack-decision-search --scope branch --recent 50` returned none for this branch docs/PLAN.md:503
- REALITY: numbers finding chunk 06's "3 or fewer draw calls" counts shadow draws [measured: three source above]; chunk 08's "under 40" has no stated count rule; vapour, packet and pulse rates are unset; campus size is [estimated] docs/PLAN.md:509
- REALITY: deferred-asks pass no TODO triggers inside Phase 3 (`vp run doctor`, E18 before chunk 14, C18 at chunk 36) TODOS.md:5
- REALITY: pr-count pass no `.gstack/ship-policy.json`; Phase 3 is five chunk PRs (06-10) plus this review's docs PR (D18) docs/PLAN.md:31

### 0C. Dream state (Phase 3)

```text
  CURRENT STATE                   THIS PLAN (06-10)                   12-MONTH IDEAL
  one canvas, final look on a --> a static campus like the mockup: --> the campus is a map of your
  test cube and a look-dev        parametric halls, instanced         work: every project a hall you
  vignette; map controls and      racks, roads, gate, dock, cooling,  recognise at a glance, growing
  glide; bounds sized for a       power, fibre; every moving part     outward as you start projects,
  28 x 28 box                     on a dev control                    calm when you are idle, and the
                                                                      first glance looks like the
                                                                      mockup, not an empty lot
```

Phase 3 moves toward the ideal. Gaps: who sizes the campus (W-F1), what the first glance frames (W-F3), and the per-hall looks that Phase 5 needs (W-F7).

### Mode (Phase 3)

SELECTIVE EXPANSION, chosen by the user (WQ1, 2026-10-14; question answer, not auto-decided). The recommendation was SCOPE REDUCTION by the file-count rule: about 50 distinct changed files [estimated] across five chunk PRs. Under SELECTIVE EXPANSION, Phase 3 scope is held and hardened, and each addition is offered separately for Add, Defer or Skip. No approach decision was needed before the mode.

### Required work applied without a new choice (Phase 3)

Each item repairs a gap against an approved contract, so it is in scope under the hold-scope check; none changes a stated limit. All are applied to the chunk text above (chunks 06-10 and the Phase 3 heading), after C24-C28 settled.
- W-RW1 (W-F1; chunk 05 "clamped to campus bounds" and `cameraRig.home()` "the whole campus framed"): chunk 08 adds `src/scene/campus/layout.ts`, a pure module with the 12 hall-slot positions in slot order (A and B first), the road grid, the furniture, plant, power and gate zones, and the campus extent. `CAMPUS_BOUNDS`, the ground size, the grid and the shadow camera extent are derived from that extent instead of constants, and `ORTHO_ZOOM.min` is lowered when needed so the home fit is never clamped. Unit tests: every slot and zone lies inside the bounds; slots do not overlap each other or any zone; the home fit at 1280x720 is at least `ORTHO_ZOOM.min`. The slot assignment logic stays in chunk 19's reconciler (D8); chunk 08 owns positions and order only.
- W-RW2 (W-F2; CEO S-RW4 "the bar applies to scene draw calls"): every Phase 3 draw-call bar reads the perf HUD's scene number, which includes the shadow pass, at the high tier with shadows on; post-processing is shown, not counted. Chunk 06's per-hall number is decision C24.
- W-RW3 (W-F4; chunk 34 "road lamps"): chunk 08 builds road lamps along the road grid as one instanced post mesh and one instanced lamp-head mesh on a shared warm glow material; chunk 34 raises their emissive at night.
- W-RW4 (W-F5; section 4b D14, section 7 look risk): chunk 08 acceptance gains the frozen comparison: the PR shows `08-campus.png` beside `docs/designs/variant-B-2.png`, as 04c did for the look-dev view.
- W-RW5 (W-F6; design D7 "never smaller than 12 CSS px") [measure and visibility rule superseded by W-RW17 and W-RW24]: chunk 06 defines `SEMANTIC_ZOOM`, the ortho zoom at which the floor sign's letter height reaches 12 CSS px at the isometric angle. The floor sign fades out over 200 ms below it (D7) and chunk 18's billboards use the same constant. The sign atlas is one shared canvas texture; `setSign(slot, letter, project)` redraws only that slot's region, and the texture count stays constant. Acceptance replaces "at least 12 CSS px at default zoom" with: a unit test computes the on-screen letter height at `SEMANTIC_ZOOM` (at least 12 px), and an e2e shows the sign above it and hides it below.
- W-RW6 (W-F7; chunk 04c "shared instances only (no per-mesh materials)", chunks 18 and 22): each hall's per-hall looks (aisle tiles for the chunk 22 heat wash, the chunk 18 dormant desaturation) are driven by a colour attribute on that hall's own geometry, never by a per-hall material. Unit test: two halls built with different tints use the same material instances.
- W-RW7 (W-F8; section 4 shots contract, chunk 22 "no hidden randomness"): new `view` values in `src/app/params.ts`, each with a shots entry: `hall` (06: one hall framed, roof cut away), `racks` (07: the same hall with 16 racks at the seeded fake load), `cooling` (09) and `power` (10), the last two framed on the campus zones from W-RW1; from chunk 08 `home` shows the campus. A pure `src/scene/fake.ts` (seeded by a small RNG in `src/sim/rng.ts`, which chunk 11's mock generator reuses; CEO W-RW37) gives rack count per hall, LED load, duty and packet phase as functions of scene time and `seed`; under `freeze=1` they read the frozen time, so shots and baselines repeat. Dev controls override the fake; chunks 18 and 22 replace it with store values. Until chunk 18, halls A and B in `home` show the seeded fake rack set, so the hero has lit racks as in variant-B-2.
- W-RW8 (W-F9; design D20, eng E12) [the `renderer.info` check is e2e-only per W-RW23; vapour blending is fixed to normal blending with a sort per W-RW18]: chunk 07's "without frame hitches" becomes measurable: each hall's rack and LED InstancedMeshes are allocated once at capacity 16 (and 16 x LEDs per rack); a count change writes only `mesh.count` and instance attributes, and `renderer.info.memory.geometries` is unchanged across 0, 16 and 0 (unit test, plus an e2e through `__sceneDev`). Chunk 09's sorting check becomes: the vapour material has `depthWrite: false`, and either its blending needs no order or the instances are sorted back to front when the camera moves (unit test on the sort); the PR shows frozen vapour at duty 1 from four azimuths in Chromium, Firefox and WebKit, and a manual Safari check is recorded in the PR. Chunks 09 and 10 check reduced motion: vapour density 30% and packets at 25% speed (D20), by unit tests on the rate functions and one e2e each with reduced motion emulated.
- W-RW9 (W-F10; D8 stable slots and section 1 D18 test policy): chunk 07's rack slot allocator is pure, with unit tests: a key keeps its slot; a new key takes the lowest free slot; a freed slot is reused only after its key leaves; a 17th key gets no slot and is counted (overflow is chunk 19's); same inputs give the same layout. Chunk 08's waypoint graph has unit tests: it is connected; gate to dock and gate to every hall door have a path; no edge crosses a hall footprint.
- W-RW10 (W-F11; section 7 "reads as generic neon", D14) [test method superseded by W-RW18]: vapour colour and opacity keep its peak luminance below `RENDER.bloom.luminanceThreshold`.
- W-RW11 (W-F12; D14 mockup, D8 halls never move): chunk 10 routes fibre on the road grid from the vault to each placed hall's door side, with rounded right-angle bends, never through a hall footprint (unit test on the route); a line exists only for a placed hall; removing a slot in the dev menu disposes its line, and geometry and texture counts return to the previous values.
- W-RW12 (CEO S-RW2 parameters read in production builds; prior learning `e2e-runs-production-build`): every Phase 3 dev control (rack count, fake load, waypoint graph, duty, packet rate, hall slots) lives in new collapsible sections of the `dev=1` HUD menu (`src/scene/PerfHud.tsx`), and each has a `window.__sceneDev` hook so Playwright drives it in the production build.
- W-RW13 (Prime Directive 1; `mergeGeometries` returns null and logs on mismatched attributes, `BufferGeometryUtils.js:158-186`) [the throwing function is `mergeHallParts` per W-RW21]: `buildHall` throws a named `HallBuildError` instead of passing null on, so the C23 scene-error path reports it; unit test with mismatched parts.

Recorded without a change: W-F14 (five README images from `home`). Section 4 regenerates old images by design; the README picks which to show.

Added after the first spec review (reviewer `refuter`, score 6/10, REWORK; each fix tied to an approved contract, checked by Claude where marked):
- W-RW14 (C24 clipped roof; three `WebGLShadowMap.js:442` [measured], `localClippingEnabled` set nowhere in `src` [measured: grep]): `applyRendererSettings` enables local clipping; the toggle moves the plane's constant instead of changing the plane list, so no shader recompiles; unit and e2e checks.
- W-RW15 (C28 baseline; `playwright.config.ts:23-49` match only `lookdev.spec.ts` [measured]): the `lookdev` project matches `campus.spec.ts` too, and the three browser projects ignore it.
- W-RW16 (W-RW7 determinism, C28): vapour particle phases and fan angles come from `fake.ts`; chunk 09 checks two frozen captures match.
- W-RW17 (D7, W-RW5) [metric superseded by W-RW24: 2D screen distance at the current pose, and `SEMANTIC_ZOOM` at the iso pose only]: `SEMANTIC_ZOOM` is defined by projecting the letter through the rig at the four 90 degree azimuths (an axis-aligned floor glyph projects to about 0.41 of its height vertically, so the earlier sine-of-elevation formula gave about 8.5 px [reviewer derivation, checked by Claude: screen-up vector (-1, 2, -1)/sqrt 6 for a camera along (1, 1, 1)]); perspective compares `zoomForDistance` at the target distance.
- W-RW18 (W-RW10 made testable): vapour uses normal alpha blending with a back-to-front sort, so overlap converges to the vapour colour; the test reads the colour uniform, since a soft shader has no `emissive`.
- W-RW19 (C24, C27): only the hall body material carries the clipping plane; trees get their own shared material.
- W-RW20 (W-RW12, W-RW7): `setRackCount(hall, n)` names the hall; `view=racks` pins 16 racks.
- W-RW21 (W-RW6, W-RW13 test seams): exported `mergeHallParts(parts)` throws `HallBuildError`; `setHallTint` and `setAisleTint` write the colour ranges.
- W-RW22 (W-RW6 consistency): chunk 18's dormant look, chunk 20's fade and chunk 22's heat wash go through colour attributes or sinking, never per-hall materials; chunk 05's home line points to C25.
- W-RW23 (feasibility): `renderer.info` counts are read only in e2e (Vitest has no WebGL); the Phase 3 heading lists which meshes cast shadows.
Added after the second spec review (refuter, 8/10, REWORK; 13 of 14 first-review issues fixed):
- W-RW24 (D7 "never smaller than 12 CSS px"; camera reaches elevation 12-85 degrees and any azimuth, `src/scene/controls.ts:51-52`, `src/scene/keyboard.ts:7` [reviewer citation]): the floor sign's visibility is judged at the current pose with a named measure (2D screen distance between the projected bottom-centre and top-centre of the letter); `SEMANTIC_ZOOM` stays the iso-pose constant that chunk 18's billboards use. The unit test sweeps elevation and 45 degree azimuths in both projections.
- W-RW25 (D14 variant-B-2 open halls; W-RW7 lit racks in `home`; C28 baseline): the roof starts cut in every Phase 3 view; the cut plane sits 0.01 units above the wall top with the roof slab wholly above it.
- Record hygiene: W-RW5, W-RW8, W-RW10 and W-RW13 are tagged with what superseded them; the Phase 3 heading lists vapour phase and fan angle among the seeded values.

After the third spec review (refuter, 9/10, REWORK; cap of three reviews reached, so these fixes were checked by Claude against the text, not re-reviewed):
- W-RW26 (D7 "Label text is never smaller than 12 CSS px"): the letter measure is taken on the sign's smallest text line (the project name), not the larger hall letter; the sweep test computes its expected value from its own `project` calls; chunk 06's e2e names the `view=hall` framing.
- Record hygiene: W-RW17 is tagged as superseded by W-RW24.
- Carried to the review sections: the shared world-space cut plane during chunk 20's rise and sink (Section 4, owner chunk 20); the pose range with no hall label (low elevation and zoom above `SEMANTIC_ZOOM`) and the 200 ms fade below 12 px (Section 11).

Added in the review sections (each tied to an approved contract; see the section that found it):
- W-RW27 (C25; Section 1 A-1): `rig.setCampus({ bounds, home })`.
- W-RW28 (W-RW7; A-2): the `SceneSignals` seam.
- W-RW29 (section 4 determinism, C28; A-3): the atlas waits for Geist; the ready signal waits for the atlas; `SignAtlasError`.
- W-RW30 (C23; Section 2 E-1): `renderer.debug.onShaderError` routed to `[scene]` and the HUD.
- W-RW31 (Prime Directive 1; E-2): dev setters clamp and warn.
- W-RW32 (S-RW38; E-3): degenerate campus extent keeps the previous bounds.
- W-RW33 (Prime Directive 1; E-4): sign text truncation, empty names, bad slots.
- W-RW34 (D16; Section 3): fixed fictional names in `fake.ts`.
- W-RW35 (C20; Section 4 D-1): flat site surfaces are ground for double-click home.
- W-RW36 (S-RW40; Section 8 O-1): roof and placed-hall transition logs.
- W-RW37 (reuse; Section 5 Q-1): `src/sim/rng.ts` shared with chunk 11.
- W-RW38 (C25; Section 6): `e2e/camera.spec.ts` updated to the new home, not deleted.
- W-RW39 (C26, C28; Section 9 R-1): later PR regenerates baselines and shots.
- W-RW40 (C25; Section 9 R-2): README "Controls" line.

- Routed, not changed: reduced-motion behaviour for the chunk 07 LED pulse and the chunk 09 fans has no D20 rule, so it goes to Section 11 as UI-4 (owner `/plan-design-review`); both chunks' acceptance checks both modes against it. Upright signs (delight item 5) and the empty-slot look go to Section 11; the view-fitted shadow camera (item 6) to Section 7. Merge conflicts on the binary campus baseline when C26 lets 18 run beside 09 and 10 go to Section 9.

### 0G. Selective-expansion checks (Phase 3)

Hold-scope checks:
- Complexity: about 50 distinct files [estimated] across five PRs, with new modules for the hall builder, rack instances, campus layout, waypoint graph, cooling, power and fibre, far over the 8-file mark. Challenge result: each chunk is its own PR (D18) of about 10 files; the hall builder, layout and fake module are pure and tested without rendering; no smaller set gives chunks 18-23 their halls, slots, waypoints, plant and fibre.
- Minimum change: nothing in Phase 3 can be deferred without breaking a later chunk: 06 and 07 feed 18; 08's slots, gate, dock and waypoints feed 19, 20 and 22; 09 feeds 22's cooling ramp; 10 feeds 20's fibre rebuild and 22's packets. Parked cars and bay doors are look-only but are the approved mockup (D14) and cost little. No deferral proposed.
- Invariants kept: D7, D8, D9, D10, D12, D14, D17, D20, section 4 protocol, C16 calm mode, C17 look-dev per chunk, C22 dependencies, ADR 0001 per-hall instanced meshes. Repairs needed to meet them: W-RW1 to W-RW13 above, and the chunk 06 bar (C24).

10x check: the 10x version of Phase 3 is a campus that opens looking like the mockup with only two projects, grows outward without moving a hall, and costs a fixed, tested number of draw calls per hall, so Phase 5 only rebinds dev controls to the store. That is about 1.3x the effort of the phase as written [estimated].

Delight scan (adjacent improvements of about 30 CC-minutes or less):
1. Home frames the campus that exists (placed halls, plant, gate), with empty slots shown as reserved pads, instead of all 12 slots (W-F3).
2. Let chunk 18 start after chunk 08, so live racks arrive two chunks earlier (W-F13).
3. Site perimeter from the mockup: instanced trees, a perimeter fence and the "SYNAPSE AI DATA CENTRE" monument at the gate (W-F4).
4. A screenshot baseline for the frozen campus `home` view in `vp run e2e:local`, so the README hero cannot drift from the mockup unnoticed.
5. Floor signs that stay upright when the camera is rotated past 90 degrees (W-F6).
6. A shadow camera fitted to the visible area, so shadows stay crisp at maximum zoom.

Platform potential: the campus layout module (W-RW1) is what chunk 19 assigns slots in, chunk 20 animates, chunk 21 and 22 route vehicles on, and chunk 25 builds area presets from; the fake module (W-RW7) is the seam chunks 18 and 22 rebind. Item 5 is a design detail and goes to Section 11. Item 6 is a quality-tier knob and goes to chunk 36 (Section 7). Items 1-4 are offered below, one question each, after C24.

### Decision ledger (CEO, Phase 3)

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
|---|---|---|---|---|---|
| C24 chunk 06 per-hall draw-call bar (Claude, 0G hold check) | chunk 06 Acceptance "Static hall costs 3 or fewer draw calls"; S-RW4 bars read the HUD scene number; shadow draws count [measured: three `WebGLShadowMap.js:548`, `WebGLInfo.js:20`]; W-F2 | at most 4 (3 main + 1 shadow): one merged hall body with a colour attribute on one new shared library material, roof cut by a clipping plane with `clipShadows`, windows on the shared glow, sign from the shared atlas | none | approved | WQ2 answer "Bar 4: 3 main + 1 shadow (recommended)", 2026-10-14; scope: chunk 06 hall construction and its per-hall bar; count rule (S-RW4) and chunk 08 total unchanged |
| C25 first-glance and home framing (Claude, 0G delight 1) | chunk 05 `cameraRig.home()` "the whole campus framed"; startup pose target origin at `ORTHO_ZOOM.default` 80 (`src/scene/camera.ts:161`); storyboard step 2; variant-B-2; W-F3 | startup and home frame the extent of placed halls plus the plant, power and gate zones, read from the layout (startup once at load, home on each press); bounds cover all 12 slots | none | approved | WQ3 answer "Add to this plan's scope (recommended)", 2026-10-14; scope: chunk 08 startup pose and `home()` target (amends chunk 05 C19 "whole campus" to the placed campus); bounds (W-RW1) and empty-slot look (Section 11) unchanged |
| C26 chunk 18 start (Claude, 0G delight 2) | section 6 `10 + 13 → 18`; chunk 20 rebuilds fibre lines (10); chunk 22 first user of cooling (09) and packets (10); W-F13 | 18 depends on 08 and 13; 20 depends on 18, 19 and 10; 22 depends on 21 and 09 | none | approved | WQ4 answer "Add to this plan's scope (recommended)", 2026-10-14; scope: dependency lines of chunks 18, 20, 22 and section 6 only; no task text changes |
| C27 site perimeter (Claude, 0G delight 3) | variant-B-2 (design D14); W-F4; chunk 08 "under 40" draw calls | chunk 08: one instanced low-poly tree (colour attribute, shared material) on seeded perimeter and road-edge spots; perimeter fence (instanced posts, merged panels) open at the gate; gate monument with the wordmark from the shared sign atlas; look-dev adds a tree and a fence bay; chunk 08 bar stays under 40 | none | approved | WQ5 answer "Add to this plan's scope (recommended)", 2026-10-14; scope: chunk 08 perimeter parts only; road lamps stay W-RW3 |
| C28 campus baseline (Claude, 0G delight 4) | C17 look-dev baseline pattern (`e2e/lookdev.spec.ts`, its own Chromium project, skipped in CI); section 4b D14 compare at 08; W-RW4 | chunk 08 adds `e2e/campus.spec.ts`: frozen `home` baseline (1280x720, `freeze=1`, `seed=1`, after the ready signal, `maxDiffPixelRatio: 0.005`) in the look-dev project, Mac only; every PR that changes the campus look updates it in the same PR | none | approved | WQ6 answer "Add to this plan's scope (recommended)", 2026-10-14; scope: one spec and baseline from chunk 08; look-dev baseline and W-RW4 compare unchanged |
| C29 view-fitted shadow camera TODO (Claude, Section 7 P-1) | P-1: one 2048 shadow map over about 60 x 45 units [estimated] gives about 7 CSS px per texel at `ORTHO_ZOOM.max` 240; chunk 36 owns quality knobs | Phase 3 keeps the campus-fitted shadow camera (W-RW1); view-fitted shadows are a P3 item in `TODOS.md` | none | deferred | WQ8 answer "Add to TODOS.md (recommended)", 2026-10-14; scope: TODO only, postponed not rejected; no chunk text changed |
| UI-4 reduced motion for LED pulse and fans (Claude, Section 11) | D20 names packets, vapour, rain and lightning only; chunks 07 and 09 acceptance check both modes against UI-4 | LEDs steady at 0.8, fans at 25% | none | approved | Phase 3 design review D12 answer "7A Steady LEDs, fans 25% (recommended)", 2026-10-14; applied to chunks 07, 09 and section 4b D20 |
| UI-5 floor sign orientation (Claude, Section 11) | W-RW24 floor sign can read sideways or upside down after rotation | upright sign panel on the front wall, token values | none | approved | Phase 3 design review board D3 (variant B) and D4 confirmation, D10 "5A Token-based panel (recommended)", 2026-10-14; applied to chunk 06 and section 4b D9 |
| UI-6 empty hall-slot look (Claude, Section 11) | C25 frames placed halls; empty slots appear when panning | marked pad with its slot number under the 12 px rule | none | approved | Phase 3 design review board D3 (variant B) and D4 confirmation, D16 "11A", D17 "11bA Slot number (recommended)", 2026-10-14; applied to chunk 08 |
| UI-7 hall-label gap and fade (Claude, Section 11; refuter 3 note) | D7; W-RW24 hides signs by pose; chunk 18 billboards switch on `SEMANTIC_ZOOM` | panel when readable, else chunk 18 billboard; the 200 ms fade accepted as D7's | none | approved | Phase 3 design review D8 "3A Panel, else billboard (recommended)", 2026-10-14; applied to chunks 06, 18 and section 4b D7 |

Approval readiness: PASS. Checked rows and answers: C24 (WQ2, A), C25 (WQ3, A), C26 (WQ4, A), C27 (WQ5, A), C28 (WQ6, A), C29 (WQ8, A, deferred to `TODOS.md`); scope documents WQ7 (A). Each row's chunk text applies only that answer's scope. UI-4 to UI-7 are unresolved and kept out of accepted work (owner `/plan-design-review`). W-RW1 to W-RW40 are required repairs, each citing its approved contract.

### Answered decision C24 (WQ2)

Answer: A, "Bar 4: 3 main + 1 shadow (recommended)", 2026-10-14.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Count rule | S-RW4 (approved): HUD scene number, shadow pass included | same | same | same | same |
| Per-hall bar | chunk 06 Acceptance (approved limit) | at most 3, rule unstated | at most 4: 3 main + 1 shadow | at most 3 | none |
| Halls cast shadows | D14 rig "one directional with soft shadow" | unstated | yes (body) | no (receive only) | unstated |
| Hall body | chunk 06 "merged geometry for static parts" | merged | one merged body (slab, walls, roof, aisle tiles, door) with a colour attribute on one new shared library material | same as A | merged, split left to the implementer |
| Cutaway roof | chunk 06 "roof hidden or sliced above a height, toggleable" | toggleable | clipping plane on the shared body material, with `clipShadows` | clipping plane on the shared body material | toggleable, method open |
| Per-hall tint | W-RW6 (pending, required) | via colour attribute | via colour attribute | via colour attribute | via colour attribute |
| Full-campus budget | chunk 08 "under 40" (2 halls); chunk 36 CI budget | unchanged | unchanged | unchanged | unchanged |

Question: D2 — C24: What should chunk 06's per-hall draw-call bar be? Project: Synapse Horizon, branch phase-3-world-building, CEO review of Phase 3. ELI10: Chunk 06 promises a hall costs at most 3 draw calls. The perf HUD counts the shadow pass too, so any hall that casts a shadow pays twice for its shadow-casting part. A hall with a body, glowing windows and a sign cannot get under 4 while it casts a shadow. Stakes if we pick wrong: a bar nobody can meet gets ignored, or a bar is met by dropping shadows and the campus looks flat next to the mockup. Recommendation: A because one coloured body with a clipped roof keeps the original intent (3 main draws), keeps shadows, and gives chunks 18 and 22 their per-hall colour path for free. Note: options differ in kind, not coverage — no completeness score. Net: A changes the number to match the real counting rule; B keeps the number by dropping hall shadows; C drops the per-hall check.
Header: Hall bar
A) Bar 4: 3 main + 1 shadow (recommended)
One merged hall body on one shared vertex-coloured material, roof cut by a clipping plane, windows and sign separate. Effort M, risk low. ✅ Keeps hall shadows from the D14 rig while holding 3 main-pass draws. ✅ The colour attribute is the per-hall path chunks 18 and 22 need. ❌ Changes the approved number from 3 to 4 and adds one library material.
B) Bar 3, no hall shadows
Same merged body and clipped roof, but halls only receive shadows, so the count stays 3. Effort M, risk medium. ✅ Keeps the original number exactly as approved. ✅ Saves one draw call per hall, 12 at a full campus. ❌ Halls stop casting shadows, flatter than the mockup's night look.
C) No per-hall bar
Drop the chunk 06 number and rely on chunk 08's total and chunk 36's later budget test. Effort S, zero implementation work. ✅ No new construction rule for the implementer to follow. ✅ Nothing to argue about in chunk 06 review. ❌ Per-hall cost stays unknown until 12 halls exist in chunk 20.

### Answered decision C25 (WQ3)

Answer: A, "Add to this plan's scope (recommended)", 2026-10-14.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Startup pose | 04a/05 code: target origin, zoom 80 (`camera.ts:161`) | origin, zoom 80: about 16 world units across at 1280 px, whatever chunk 08 puts there | the home framing below, applied once at load | unchanged; TODO records the gap | unchanged |
| `home()` target | chunk 05 (C19, approved): "the whole campus framed in the safeArea" | all 12 slots and the plant (W-RW1 bounds) | the extent of placed halls plus the plant, power and gate zones, read from the layout on each press | unchanged | unchanged |
| Camera bounds | W-RW1 (required) | full campus extent | same | same | same |
| Empty-slot look | none (Section 11 design question) | bare ground | unchanged here | unchanged | unchanged |
| Hero `08-campus.png` | section 4 shots, `home` view | whatever the startup pose shows | placed halls, plant and gate, like variant-B-2 | unchanged | unchanged |

Question: D3 — C25: Should the first glance and the home key frame the campus that exists, instead of all 12 hall slots? Project: Synapse Horizon, branch phase-3-world-building, CEO review of Phase 3. ELI10: Today the app opens on the middle of the map at a fixed zoom, and the home key frames all 12 hall slots. A new user has only halls A and B, so home shows two small halls among ten empty lots, and the opening view shows whatever happens to sit in the middle. The mockup instead frames a few halls with the cooling and power plant. This choice decides what the README hero and the first five seconds look like. Stakes if we pick wrong: the first impression is an empty car park, not "my agents live here", and the README hero does not match the mockup. Recommendation: A because it makes the opening view and home match the approved mockup at the cost of one extent function in the layout module that chunk 08 builds anyway. Note: options differ in kind, not coverage — no completeness score. Net: A changes what home means (the campus that exists, growing as halls are added); B and C keep the whole grid.
Header: First glance
A) Add to this plan's scope (recommended)
Chunk 08: startup and home frame the placed halls plus plant, power and gate, read from the layout; bounds still cover all 12 slots. Effort S, risk low. ✅ The opening view and README hero look like the approved mockup with only two halls. ✅ Home grows with the campus as chunk 20 places halls, without moving any hall. ❌ Changes chunk 05's approved meaning of home from the whole grid to the placed campus.
B) Defer to TODOS.md
Keep the current startup pose and whole-grid home now; record the gap with a trigger. Effort S, zero implementation work now. ✅ No change to the approved chunk 05 home behaviour this phase. ✅ The gap is written down with a trigger to revisit. ❌ Chunk 08's hero and first glance ship looking emptier than the mockup.
C) Skip
Keep startup at the map centre and home on all 12 slots; record the reason in NOT in scope. Effort S, zero implementation work. ✅ Home always shows every slot a hall can ever take. ✅ No new framing rule to test. ❌ The first glance shows mostly empty slots for every new user.

### Answered decision C26 (WQ4)

Answer: A, "Add to this plan's scope (recommended)", 2026-10-14.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Chunk 18 depends on | section 6 and chunk 18 (approved) | 10, 13 | 08, 13 | 10, 13; TODO records the option | 10, 13 |
| Chunk 20 depends on | chunk 20 (approved) | 18, 19 (10 through 18) | 18, 19, 10 (fibre rebuild needs 10) | unchanged | unchanged |
| Chunk 22 depends on | chunk 22 (approved) | 21 (09 and 10 through 18) | 21, 09 (10 through 20) | unchanged | unchanged |
| Chunk 18 task text | chunk 18 Tasks | racks, blades, beacon, billboards, dormant style | unchanged | unchanged | unchanged |
| Implementation work | none | none | none (docs only) | none | none |

Question: D4 — C26: Should chunk 18 (racks driven by live data) be allowed to start right after chunk 08, instead of waiting for cooling (09) and power (10)? Project: Synapse Horizon, branch phase-3-world-building, CEO review of Phase 3. ELI10: The plan makes the first live-data scene chunk wait for the cooling towers and power yard, but it only lights racks inside halls A and B. Cooling and fibre are first used two chunks later (20 and 22). Changing three dependency lines lets the live racks happen as soon as the halls and campus exist, and lets cooling and power be built alongside. Stakes if we pick wrong: either the first "my agents are live" moment waits on set dressing, or a later chunk starts without a part it needs. Recommendation: A because it is a docs-only change that keeps every real need (20 still waits for fibre, 22 for cooling) and frees the order of work. Note: options differ in kind, not coverage — no completeness score. Net: A frees ordering at no build cost; the gain is only real if you choose to build 18 before 09 and 10.
Header: Chunk order
A) Add to this plan's scope (recommended)
Section 6 and chunk text: 18 depends on 08 and 13; 20 adds 10; 22 adds 09. Effort S, zero implementation work. ✅ Live racks can land before cooling and power, two chunks sooner. ✅ Every real dependency is still explicit: fibre before 20, cooling before 22. ❌ Gains nothing if you build the chunks strictly in number order anyway.
B) Defer to TODOS.md
Keep 18 after 10 now; record the reorder with a trigger. Effort S, zero implementation work. ✅ Section 6 stays exactly as approved this phase. ✅ The option is written down for when parallel work starts. ❌ Hidden coupling stays: 20 and 22 rely on 09 and 10 only through 18.
C) Skip
Keep 18 after 10 and say why in NOT in scope. Effort S, zero implementation work. ✅ One fixed order, nothing to track. ✅ No edits to Phase 5 chunk headers. ❌ Live data in the scene waits on two set-dressing chunks.

### Answered decision C27 (WQ5)

Answer: A, "Add to this plan's scope (recommended)", 2026-10-14.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Trees | variant-B-2 (D14) | none | one instanced low-poly tree mesh (trunk and canopy in one geometry with a colour attribute, shared material) along the perimeter and road edges, seeded placement | TODO | none |
| Perimeter fence | variant-B-2 | none | instanced posts plus merged panels on the campus edge, open at the gate | TODO | none |
| Gate monument | variant-B-2 "SYNAPSE AI DATA CENTRE" | none | slab with the wordmark from the shared sign atlas (W-RW5), beside the gate | TODO | none |
| Chunk 08 draw calls | chunk 08 "under 40" (approved) | about 30 [estimated] | about 37 [estimated], bar unchanged | unchanged | unchanged |
| Look-dev view | C17 | chunk 08 adds its materials | also one tree and a fence bay | unchanged | unchanged |
| Road lamps | W-RW3 (required) | in chunk 08 | same | same | same |

Question: D5 — C27: Should chunk 08 also build the site perimeter from the mockup: trees, a fence and the gate monument? Project: Synapse Horizon, branch phase-3-world-building, CEO review of Phase 3. ELI10: The mockup's campus sits in dark trees behind a fence, with a lit "SYNAPSE AI DATA CENTRE" monument at the gate. No chunk builds any of these, so the campus would float on bare ground. They are cheap: one instanced tree, one instanced fence and one sign slab that reuses the hall sign atlas. Stakes if we pick wrong: the hero looks like a model on a table instead of a place, or we spend draw calls and review time on scenery. Recommendation: A because these three parts are what make variant-B-2 read as a real site, and each is one or two draw calls in chunk 08, which already places everything around them. Note: options differ in kind, not coverage — no completeness score. Net: A buys the mockup's sense of place for about 7 draw calls; B and C keep chunk 08 to the functional parts.
Header: Perimeter
A) Add to this plan's scope (recommended)
Chunk 08 builds instanced trees, a perimeter fence open at the gate and the gate monument sign on the shared atlas. Effort S, risk low. ✅ The campus reads as a real site, as in variant-B-2, not a model on a table. ✅ Reuses the sign atlas and the layout zones that chunk 08 already builds. ❌ Adds about 7 scene draw calls [estimated], leaving chunk 08 close to its under-40 bar.
B) Defer to TODOS.md
Ship chunk 08 with roads, parking, gate, dock and lamps only; record the perimeter with a trigger. Effort S, zero implementation work now. ✅ Chunk 08 stays focused on parts later chunks use. ✅ The look gap is written down for the chunk 34 or 37 polish pass. ❌ The README hero ships without the mockup's site edge.
C) Skip
No trees, fence or monument; record the reason in NOT in scope. Effort S, zero implementation work. ✅ Fewest draw calls and the smallest chunk 08. ✅ Nothing extra to keep in step with day and night later. ❌ The campus floats on bare ground, unlike the approved mockup.

### Answered decision C28 (WQ6)

Answer: A, "Add to this plan's scope (recommended)", 2026-10-14.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B | C |
|---|---|---|---|---|---|
| Campus baseline | C17 pattern (approved for look-dev) | none | `e2e/campus.spec.ts`: frozen `home` at 1280x720 (`freeze=1`, `seed=1`, after the ready signal), `toHaveScreenshot` with `maxDiffPixelRatio: 0.005`, in the look-dev Playwright project (Chromium on the Mac, skipped in CI), baseline under `e2e/__screenshots__/` | TODO | none |
| Who updates it | C17 "a deliberate look change updates the baseline in the same PR" | n/a | chunks 08, 09, 10 and every later chunk that changes `home` (18-23, 34, 35) update it in the same PR | n/a | n/a |
| Mockup compare in PR | W-RW4 (required) | chunk 08 PR | same | same | same |
| Seeded content | W-RW7 (required) | fake module | same (the baseline needs it) | same | same |

Question: D6 — C28: Should the frozen campus home view get a screenshot baseline, like the look-dev view has? Project: Synapse Horizon, branch phase-3-world-building, CEO review of Phase 3. ELI10: The look-dev view already fails a local test if its pixels drift, so a material or light change cannot slip through unseen. The campus home view becomes the README hero in chunk 08, but nothing would catch a later change that makes it look worse. A second baseline guards it the same way, on the Mac only. Stakes if we pick wrong: the hero slowly drifts from the mockup with nobody noticing, or every scene chunk pays a baseline update. Recommendation: A because the pattern, project and threshold already exist from chunk 04c, so this is one spec file, and the hero is the image people judge the project by. Note: options differ in kind, not coverage — no completeness score. Net: A trades a baseline update in each look-changing PR for a guard on the hero.
Header: Hero guard
A) Add to this plan's scope (recommended)
Chunk 08 adds `e2e/campus.spec.ts`: frozen `home` baseline in the existing look-dev project, Mac only, updated in the same PR on deliberate changes. Effort S, risk low. ✅ A look regression on the hero fails `vp run e2e:local` instead of shipping. ✅ Reuses the look-dev project, threshold and folder from chunk 04c. ❌ Every PR that changes the campus look (09, 10, 18-23, 34, 35) must refresh the baseline.
B) Defer to TODOS.md
Rely on the look-dev baseline and the chunk 08 mockup compare for now; record the guard with a trigger. Effort S, zero implementation work now. ✅ No baseline churn while Phase 3 and 5 reshape the campus. ✅ The guard is written down for when the look settles. ❌ Drift in the hero between chunk 08 and the trigger goes unseen.
C) Skip
Keep only the look-dev baseline and the chunk 08 compare; record why in NOT in scope. Effort S, zero implementation work. ✅ One baseline to maintain. ✅ No extra spec in the Mac-only suite. ❌ Nothing automated guards the README hero.

### Scope document approval (Phase 3)

WQ7 answer "Approve and continue (recommended)", 2026-10-14: approves these versions of the working plan (chunks 06-10 and this record through W-RW26) and the CEO summary. Implementation and the items routed to Sections 7, 9 and 11 stay unapproved.

### 0I. Temporal interrogation (Phase 3)

```text
  HOUR 1 (foundations):   unit scale from lookdevLayout.ts (rack 0.55 x 1.1 x 0.8, pitch 0.8) sets hall size;
                          new library materials (hall body with vertex colours and the clip plane, tree, lamp,
                          vapour, packet); localClippingEnabled in applyRendererSettings; new view values
  HOUR 2-3 (core logic):  mergeGeometries needs identical attributes on every part (position, normal, uv, color);
                          colour ranges per hall part; the plane constant for cut and uncut; the letter measure
                          through rig.project; slot allocator; layout extent and home extent
  HOUR 4-5 (integration): CAMPUS_BOUNDS becomes a rig input, so camera.test.ts, controls.test.ts and
                          e2e/camera.spec.ts:121-193 (home frames campus corners, home centres the origin,
                          start zoom 80) change with C25; ORTHO_ZOOM.min may move; the shadow camera grows
                          (check acne and bias); every `home` shot and the look-dev baseline regenerate
  HOUR 6+ (polish/tests): vapour sort and four-azimuth shots, Safari manual check, reduced-motion e2e,
                          draw-call e2e counts, mockup compare, campus baseline wiring
```

Feasibility blockers: none. Pending choices: UI-4, upright signs, empty-slot look and the hall-label gap (Section 11); view-fitted shadows (Section 7). Effort for the phase: human ~2 weeks / CC ~5 h [estimated: five chunks of about 10 files].

### Section 1: Architecture (Phase 3)

```text
  src/app/params.ts  view: home | lookdev | hall | racks | cooling | power
          │
  src/scene/SceneCanvas.tsx ── view switch ──┬── LookDevScene (C17: buildHall, instances, tree, fence bay)
          │                                  └── Campus (08) / hall views (06, 07) / framed zones (09, 10)
          │ rig.setCampus({ bounds, home })   (W-RW27)
          ▼
  src/scene/camera.ts  bounds, home fit, SEMANTIC_ZOOM ◄──── campus/layout.ts (pure: slots 0-11, roads, zones, extent)
                                                                 │
          campus/waypoints.ts (pure graph) ◄─────────────────────┤──► Ground.tsx, LightRig.tsx (extent)
          fibre/route.ts (pure, road grid) ◄─────────────────────┤──► plant (09), power (10), perimeter (C27)
                                                                 └──► road lamps (W-RW3)
  hall/buildHall.ts ── mergeHallParts (pure) ── setHallTint / setAisleTint (colour attribute ranges)
  hall/signAtlas.ts  one CanvasTexture, waits for Geist (W-RW29)       hall/slots.ts (pure allocator)
  hall/RackInstances.tsx  capacity 16, statusLed colours               materials.ts (+ new shared entries)
  SceneSignals ◄── fake.ts (Phase 3) / store-backed (chunks 18, 22)    (W-RW28)
  PerfHud.tsx dev sections + devHooks.ts __sceneDev                    (W-RW12)
```

Findings:
- A-1 [P1] Bounds and home are imported constants [measured: `src/scene/camera.ts:21`, read by `clampTarget` at `:139` and the home fit at `:310`]. C25 says placing a hall widens the next `home()`, so both must be runtime inputs. Fixed by W-RW27 (chunk 08): `rig.setCampus({ bounds, home })`; `camera.ts` imports no campus code; camera and controls tests take bounds from a fixture.
- A-2 [P2] W-RW7 names no seam for "chunks 18 and 22 replace it". Fixed by W-RW28 (Phase 3 heading): one `SceneSignals` interface; `fake.ts` is its first implementation.
- A-3 [P1] The sign atlas can bake the fallback font [measured: Geist is `font-display: swap`, `src/styles/tokens.css:1-6`; inference: a canvas `fillText` before the font loads draws the fallback and is not redrawn]. Shots and the C28 baseline would flip between fonts with load timing. Fixed by W-RW29 (chunk 06): the atlas awaits the font with a 3 s timeout [estimated], the ready signal waits for the atlas, a timeout logs one `[scene]` warning; a null 2D context throws `SignAtlasError` into the C23 path.
- State machines: diagrams below. Invalid transitions are prevented by construction: the roof plane has two constants only; sign visibility is a pure function of the pose; placed halls only grow or shrink by whole slots in slot order (D8).
- Scaling: capped at 12 halls (D8). A full campus is about 125 scene draw calls [estimated: 12 x (hall 4 + racks 3) + about 40 for site, plant, power and perimeter]; chunk 36 owns the CI budget. Nothing grows with data in Phase 3.
- Single points of failure: the shared materials (a dispose blanks every hall; RW6 guard counts it), the one sign atlas, the one clip plane.
- Security architecture: no endpoint, no data mutation; new `view` values pass the existing allowlist; dev hooks exist only under `dev=1` (S-RW2).
- Production failures: `mergeGeometries` null (W-RW13, W-RW21), null 2D context and font timeout (A-3), WebGL context loss (the atlas re-uploads from its canvas when three rebuilds textures [inference: three re-creates GL state on restore]).
- Rollback: each chunk is one squash-merged PR; revert it as `fix: revert <title>` (CONTRIBUTING runbook). No data or migrations; images regenerate.
- Value test: the C28 baseline (consumer: `vp run e2e:local`, user-approved WQ6; retires when the hero is no longer the README image) and the W-RW4 mockup compare (consumer: the chunk 08 PR reviewer, D14; one image pair, retires after chunk 08).
- Elegant and platform: the pure layout and the `SceneSignals` seam make chunks 19-25 bind data without touching geometry.
- Cherry-pick fit: C25 needs A-1; C27 uses its own material (W-RW19); C28 needs A-3 and W-RW16; C26 has no architectural effect.

```text
  ROOF CUT (per campus, one plane)           SIGN VISIBILITY (per hall, per pose)        PLACED HALLS (dev menu until chunk 19)
  cut ──toggle──► uncut                      visible ──measure<12px──► fading(200ms)     {A,B} ──add──► {A,B,C} ... up to 12
   ▲               │                           ▲                          │                 ▲                     │
   └────toggle─────┘                           └──measure>=12px── hidden ◄┘                 └──────remove─────────┘
  (only two plane constants;                 (fading reverses if the measure recovers)    (A and B never removed; slot order fixed)
   no add/remove of planes)
```

Decision gate: A-1 to A-3 repair approved contracts (C25 behaviour, W-RW7 seam, section 4 determinism and C28), so they are applied as W-RW27 to W-RW29 without a new question.

### Section 2: Error & Rescue Map (Phase 3)

```text
  METHOD/CODEPATH                     | WHAT CAN GO WRONG                                   | ERROR CLASS
  ------------------------------------|-----------------------------------------------------|---------------------------
  mergeHallParts(parts) (06)          | parts with mismatched attributes; three returns null | HallBuildError
  buildHall({ slots, rows }) (06)     | slots not rows x n, zero or negative                | HallBuildError
  signAtlas init (06)                 | canvas.getContext("2d") is null                     | SignAtlasError
  signAtlas font wait (06)            | Geist not loaded within 3 s                         | none (timeout path)
  setSign(slot, letter, project) (06) | slot outside 0-11                                   | SignAtlasError
                                      | name too wide, empty, unusual Unicode               | none (truncate, letter only)
  custom shader compile (09, 10)      | driver rejects GLSL                                 | onShaderError callback
  slots.allocate(key) (07)            | 17th key                                            | none (null, overflow count)
  rig.setCampus(extent) (08)          | zero-size or NaN extent                             | none (warn, keep previous)
  waypoints.path(a, b) (08)           | no path between nodes                               | WaypointError
  fibre route(hall) (10)              | no route on the road grid                           | FibreRouteError
  fibre rebuild on hall change (10)   | old line not disposed                               | none (leak; e2e counts)
  __sceneDev setters (07-10)          | NaN, negative, non-integer, out of range, bad hall  | none (clamp, warn)
  applyRendererSettings (06)          | localClippingEnabled not set: roof never clips      | none (unit test)

  ERROR CLASS / PATH         | RESCUED? | RESCUE ACTION                                   | USER SEES
  ---------------------------|----------|-------------------------------------------------|-------------------------------
  HallBuildError             | Y        | C23 boundary; log with part names               | scene-error card, panels work
  SignAtlasError             | Y        | C23 boundary; log with slot                     | scene-error card, panels work
  WaypointError              | Y        | C23 boundary (static data; unit tests prevent)  | scene-error card
  FibreRouteError            | Y        | C23 boundary (static data; unit tests prevent)  | scene-error card
  font timeout               | Y        | draw with fallback font, one [scene] warning    | signs in a system font
  shader compile failure     | Y        | one [scene] line, HUD frame-error count, skip   | that effect missing (vapour or
                             |          | that mesh, keep rendering (C23 policy)          | packets), rest of scene fine
  17th rack key              | Y        | overflow counted for chunk 19                   | nothing in Phase 3
  bad setCampus extent       | Y        | keep previous bounds, one warning (S-RW38)      | camera unchanged
  dev setter input           | Y        | clamp, one console warning naming the argument  | the clamped value
```

Findings:
- E-1 [P1] Custom shader failures were silent to the user and the HUD [measured: three logs to the console only unless `renderer.debug.onShaderError` is set, `WebGLProgram.js:866-883`]. Fixed by W-RW30 (Phase 3 heading), under the approved C23 policy (log once, count, keep rendering).
- E-2 [P2] Dev setters had no input rule. Fixed by W-RW31.
- E-3 [P2] A degenerate campus extent had no rescue. Fixed by W-RW32, mirroring S-RW38.
- E-4 [P2] Sign text edge cases (long, empty, out-of-range slot) had no rule. Fixed by W-RW33.
- No catch-alls: every rescued class is named; the C23 boundary already tells WebGL failures from scene errors by class (eng E24).

Decision gate: E-1 follows the approved C23 policy; E-2 to E-4 follow S-RW38 and Prime Directive 1 without changing behaviour a user approved. Applied as W-RW30 to W-RW33. 0 GAPS remain.

### Section 3: Security & threat model (Phase 3)

| Threat | Likelihood | Impact | Mitigated? |
|---|---|---|---|
| New `view` values as an injection point | Low | Low | yes: the S-RW2 allowlist; unknown values fall back with a warning |
| A page script calls `__sceneDev` setters | Low (same origin, localhost, `dev=1` only) | Low (visual only) | yes: S-RW2 gate; W-RW31 clamps input |
| Real project names in committed README images and baselines | Medium (shots run on the developer's machine) | Medium (D16: nothing leaves localhost) | yes: W-RW34, fake names are fixed fictional strings; chunk 18 owns real names on screen |
| Sign text as a script vector | Low | Low | yes: canvas `fillText` renders text only, never HTML |

No new endpoints, dependencies, secrets or stored data. Audit logging: not applicable. One finding (S3-1, W-RW34) fixed.

### Section 4: Data flow and interaction edge cases (Phase 3)

```text
  layout.ts ──► rig.setCampus ──► clampTarget / home fit        shadow: zero or NaN extent ─► keep previous, warn (W-RW32)
     │      ──► Ground, LightRig, fibre route, waypoints        shadow: overlap or no path ─► unit tests; runtime ─► C23
  SceneSignals (fake.ts) ──► instance attributes per frame      shadow: NaN from a dev hook ─► clamped at the setter (W-RW31)
                                                                shadow: freeze=1 ─► frozen scene time, same values
  setSign ──► font wait ──► atlas region ──► CanvasTexture      shadow: font timeout ─► fallback + warning (W-RW29)
                                                                shadow: long, empty, bad slot ─► W-RW33
                                                                shadow: context lost ─► re-upload from the canvas
```

Async ordering: font load, atlas draw, first frame, ready signal, shot capture.
- Invariant: no shot or baseline capture happens before the atlas has drawn every sign with its final font.
- Mechanism: the ready signal is `first frame rendered AND atlas ready` (W-RW29).

```text
  order 1 (font first)          order 2 (frame first)            order 3 (font times out)
  font ✓ ─► atlas ✓             frame ✓ (ready waits)            frame ✓ (ready waits)
  frame ✓ ─► ready ✓            font ✓ ─► atlas ✓ ─► ready ✓     3 s ─► atlas (fallback) ─► warn ─► ready ✓
  capture: Geist                capture: Geist                   capture: fallback, the baseline fails loudly
```

- Regression proof: a unit test with a fake `document.fonts` that resolves before the first frame, after it, and never; it asserts ready waits for the atlas each time.

Interaction edge cases:

| Interaction | Edge case | Handled? | How |
|---|---|---|---|
| Roof toggle | rapid toggles | yes | two plane constants, no recompile (W-RW14) |
| Rack slider | dragged 0-16-0 fast | yes | fixed capacity, count only (W-RW8) |
| Placed halls | 12 to 2 while packets travel removed lines | yes | lines and packets disposed per hall (W-RW11) |
| Placed halls | change during a home glide | yes | the glide keeps its target; the next `home()` reads the new extent (C25) |
| Reduced motion | toggled while the scene runs | yes | rates read the store flag each frame (D20) |
| Camera | rotate to 12 degree elevation, zoom in | yes | sign hides by the pose measure (W-RW24) |
| Double-click | on a road, parking or empty slot | yes after W-RW35 | flat site surfaces carry `userData.ground` (C20) |
| Double-click | on a hall, rack or tower | yes | not ground, no home; chunk 24 adds entity zoom |
| Window resize | below 1280x720 | yes | S-RW38 full-canvas fallback |
| Context loss | during the atlas font wait | yes | canvas kept; texture re-uploads on restore |
| Chunk 20 rise and sink | the shared world-space cut plane shows a sinking hall's roof | not in Phase 3 | owner chunk 20 (carried, refuter 3 note) |

Findings: D-1 [P2] double-click home would fail on most of the campus surface, since roads, parking and slots cover it and only the bare ground mesh is "ground" [measured: `src/scene/pick.ts`]. Fixed by W-RW35 (C20 behaviour). D-2 the ordering invariant above, fixed by W-RW29.

Decision gate: S3-1 and D-1 keep approved behaviour (D16, C20) working; applied as W-RW34 and W-RW35.

### Section 5: Code quality (Phase 3)

- Q-1 [P2] No seeded RNG exists in `src` [measured: grep for mulberry, seededRandom, createRng returns nothing; the spike's was deleted in 04a], and chunk 11's mock generator needs one too. Fixed by W-RW37: one RNG in `src/sim/rng.ts` (the scaffold's empty `src/sim/`), used by `fake.ts` and chunk 11.
- Q-2 [P3] `src/scene/SceneCanvas.tsx` is 494 lines [measured: `wc -l`] and Phase 3 adds four view branches to it. Guidance for the implementer, not a requirement: a table from view name to content and framing keeps the switch flat.
- Q-3 [P3] Hall and rack sizes live in `src/scene/lookdevLayout.ts`; chunk 06 moves them into the hall module and the look-dev view renders `buildHall` output (already in chunk 06's View item), so there is one source of truth.
- Over-engineering check: `SceneSignals` has two real implementations (fake now, store in chunks 18 and 22); the layout module has five consumers (chunks 08, 10, 19, 20, 25). Neither is speculative.
- Naming: `HallBuildError`, `SignAtlasError`, `WaypointError`, `FibreRouteError` name what failed.

Decision gate: Q-1 applied as W-RW37 (shared code, reuse ladder rung 1 for chunk 11); Q-2 and Q-3 need no change.

### Section 6: Test review (Phase 3)

```text
  NEW ITEM                                   TYPE        HAPPY                         FAILURE / EDGE
  buildHall + mergeHallParts (06)            unit        merged body, 4 draws budget   mismatched parts -> HallBuildError
  clip plane + localClippingEnabled (06)     unit+e2e    flag set, one plane            toggle moves constant only; roof region changes
  setHallTint / setAisleTint (06)            unit        two tints, shared materials    range bounds
  sign measure + visibility (06)             unit+e2e    visible at view=hall           sweep 12-85 deg, 45 deg azimuths, both projections
  sign atlas font wait (06)                  unit        ready waits for atlas          font before/after first frame, never (timeout)
  setSign text rules (06)                    unit        letter and name drawn          long name truncated, empty name, bad slot throws
  slot allocator (07)                        unit        stable slot per key            lowest free, reuse after leave, 17th null
  rack instances (07)                        unit+e2e    count change only              same objects; geometries constant 0-16-0
  fake.ts / SceneSignals (07-10)             unit        same seed same values          freeze=1 frozen; dev override wins
  layout (08)                                unit        slots and zones in bounds      no overlap; home fit >= ORTHO_ZOOM.min
  rig.setCampus + C25 home (08)              unit+e2e    placed extent framed           third hall widens next home; NaN extent kept
  waypoints (08)                             unit        connected, all doors reached   no edge through a footprint
  ground flag on site surfaces (08)          unit        roads, parking are ground      halls and plant are not
  campus baseline (08, C28)                  e2e local   frozen home matches            look change fails until baseline updated
  vapour (09)                                unit+e2e    sorted, below bloom threshold  reduced motion 30%; four-azimuth shots
  fibre route + rebuild (10)                 unit+e2e    lines reach door sides         remove hall: counts return; no footprint crossing
  packets (10)                               unit+e2e    frozen captures match          reduced motion 25%
  onShaderError hook (09, 10)                unit        handler logs once, counts      stubbed compile failure keeps rendering
  dev setters (07-10)                        unit        valid input applied            NaN, negative, too large clamped and warned
```

Assertion check: every row maps to an approved requirement (C24-C28, W-RW1-W-RW38, D7, D8, D20, C20, C23). No row weakens an exact count: the 0-16-0 geometry check asserts equality, the draw-call bars assert at most the stated number. `no_claim` notes: draw-call counts from Playwright Chromium (SwiftShader) prove counts, not frame time (eng E12); the campus baseline proves pixel stability on the Mac's Chromium only, not Firefox or Safari looks; the vapour four-azimuth shots and the Safari check are reviewed by eye.

Required update (W-RW38): `e2e/camera.spec.ts:121`, `:185-187` and `:240` encode the old whole-grid home and the origin start at zoom 80; they move to the C25 contract in chunk 08, never deleted.

Test ambition:
- 2am Friday: the campus baseline, the draw-call e2e at 2 and 12 placed halls, and the 0-16-0 geometry count.
- Hostile QA: rotate to 12 degrees and zoom to the sign threshold; drag the slider end to end for 10 s; set placed halls 12 to 2 to 12 and compare geometry counts. The last is chunk 20's churn leak test at scale; Phase 3 checks one slot (chunk 10).
- Chaos: lose the WebGL context during the atlas font wait.

Pyramid: mostly unit (pure layout, allocator, routes, signals, atlas rules), a few e2e per chunk, two Mac-only baselines. Flakiness risks: time (frozen scene time), fonts (W-RW29), baselines (Mac-only, same PR updates). No load test needed: nothing scales with data in Phase 3.

Decision gate: all tests follow from approved requirements; W-RW38 keeps the chunk 05 tests honest after C25. No new verification scope was added beyond them, so no question.

### Section 7: Performance (Phase 3)

- P-1 [P2] Shadow resolution at maximum zoom: one 2048 map fitted to a campus of about 60 x 45 units [estimated] gives about 0.03 units per texel, about 7 CSS px per texel at `ORTHO_ZOOM.max` 240 (`camera.ts:15`) [estimated]. Shadows soften when zoomed close. A view-fitted shadow camera would fix it; it is not required by any approved contract and is offered as a TODO below.
- P-2 [P3] Atlas memory: a 2048 x 2048 RGBA atlas costs 16 MB plus mipmaps. Guidance: the smallest atlas that keeps the W-RW26 measure sharp; 2048 x 1024 [estimated] fits 12 slots and the monument.
- P-3 [P3] Per-frame work: LED colours for a full campus are 12 x 16 x 8 = 1,536 instances x 3 floats, about 18 KB uploaded per frame [estimated]; the vapour sort runs only on camera change. `SceneSignals` reads must not allocate per frame (guidance from eng P-E1).
- P-4 [note] Phase 3 adds ambient motion (pulse, fans, vapour, packets), so the scene never stops drawing; C16 calm mode still drops it to 30 fps after 5 s idle, as approved.
- Slowest new paths: (1) the one-time merge of up to 12 hall bodies at startup; (2) fibre rebuild on a hall-set change; (3) the vapour sort on camera moves. All are event-driven, not per frame. p99 [estimated]: a few ms each on an M1.
- No database, cache, job or connection concerns.

Decision gate: P-1 goes to the TODO choice; P-2 and P-3 are guidance; P-4 is approved behaviour.

### Section 8: Observability (Phase 3)

- Logging: every failure path in Section 2 logs one line (C23 boundary, W-RW29 font warning, W-RW30 shader line, W-RW31 setter warning, W-RW32 extent warning). O-1 [P2]: roof toggles and placed-hall changes are scene state transitions with no log line, unlike the S-RW40 rule for other scene state. Fixed by W-RW36.
- Metrics: the perf HUD already shows scene and post-processing draw calls (S-RW4) and frame errors; Phase 3 bars read them (W-RW2), and shader failures count there (W-RW30).
- Tracing, alerting, dashboards: not applicable (local app, no services).
- Debuggability three weeks later: "Copy error details" (DR14) carries the last 20 `[scene]` lines, which now include build errors, the font fallback, shader failures and the last transitions.
- Runbook: README "Known limits" gains no new card; the scene-error card text already says to reload and report the `[scene]` line (S-RW40).
- Joy to operate: the dev menu sections (W-RW12) are the operator console for every Phase 3 moving part, each scriptable through `__sceneDev`.

Decision gate: O-1 applied as W-RW36 under the approved S-RW40 rule.

### Section 9: Deployment and rollout (Phase 3)

- No migrations, feature flags or servers. Each chunk is one squash-merged `feat:` PR, so each cuts a minor release (D19) once merged.
- Order: 06, 07, 08, then 09 and 10 in parallel with 18 (C26). Rollback: revert the chunk PR as `fix: revert <title>` (CONTRIBUTING runbook); images regenerate.
- R-1 [P2] Binary merge conflicts: C26 lets chunk 18 run beside 09 and 10, and all three update the campus baseline and the `home` shots. Fixed by W-RW39 (chunk 08): the later PR rebases and regenerates; PNGs are never hand-merged.
- R-2 [P2] User-visible change at chunk 08: the startup pose and `home()` change meaning (C25). Fixed by W-RW40: the README "Controls" line says `0` or Home frames the placed campus; W-RW38 keeps the camera e2e honest.
- Post-merge checks: the release workflow (D19); `vp run e2e:local` and `vp run shots` on the Mac before ticking a chunk (D18). Environment parity: baselines run on the Mac's Chromium only (C17, C28).
- Deploy infrastructure for routine shipping: already in place (02b release pipeline); nothing new needed.

Decision gate: R-1 and R-2 keep C26 and C25 workable; applied as W-RW39 and W-RW40.

### Section 10: Long-term trajectory (Phase 3)

- Debt: (1) the floor sign's orientation (Section 11, UI-5); (2) soft shadows at maximum zoom (P-1); (3) two Mac-only baselines to keep current; (4) `fake.ts` stays as the dev and mock implementation of `SceneSignals` after chunks 18 and 22, so it must keep passing its tests; (5) the R3F 10 migration named in ADR 0001 is unchanged by this phase.
- Path dependency: the 12-slot grid positions are permanent once halls are placed (D8 "never move"); changing the grid later moves every hall. The vertex-coloured shared body ties hall looks to attribute writes, which chunks 18, 20 and 22 now assume (W-RW22).
- Reversibility: `SceneSignals` seam 5/5; per-hall colour attributes 4/5; clip-plane cutaway 4/5; campus layout grid 3/5; C25 home meaning 4/5.
- Knowledge: the record, the layout module and the `[scene]` lines are enough for a new engineer; the 1-year question passes if the layout module carries a short comment on slot order and D8.
- What comes next: Phase 5 rebinds `SceneSignals` to the store (18, 22), assigns slots (19), animates halls (20) and routes vehicles on the waypoints (21, 22). The architecture supports it without geometry changes.
- Platform potential: the layout feeds chunk 25's area presets; the waypoint graph feeds trucks (20), carts and subagents (21, 22).
- Retrospective on cherry-picks: all four offered additions were accepted (C25-C28); none was rejected, so nothing rejected turned out to be needed. C25 drove W-RW27 and W-RW38; C28 drove W-RW15, W-RW16, W-RW29 and W-RW39.

No new findings.

### Section 11: Design and UX (Phase 3)

UI scope detected: Phase 3 sets the first glance, the hall signs, the site look and the scene's motion.

```text
  open app ──► loader (until first frame AND atlas ready, W-RW29)
           ──► startup pose: placed halls + plant + gate (C25)
                 │ zoom in past the sign measure ─► floor signs visible (W-RW24)
                 │ zoom out / tilt low ─► signs fade (200 ms); chunk 18 billboards later (SEMANTIC_ZOOM)
                 │ 0 / Home / double-click ground ─► home (placed campus) (C25, W-RW35)
                 │ dev=1 ─► dev sections: racks, campus, cooling, network (W-RW12)
                 └ error ─► C23 scene-error card (HallBuildError, SignAtlasError)
```

Interaction states for the scene in Phase 3:

| Feature | Loading | Empty | Error | Success | Partial |
|---|---|---|---|---|---|
| Campus | loader until frame and atlas | halls A and B with seeded fake racks | C23 card for build errors | placed campus framed | low tier: no shadows or bloom |
| Hall signs | none until atlas ready | letter only when the name is empty | fallback font after 3 s, one warning | visible above the measure | hidden at grazing poses |
| Vapour and packets | none | duty 0 or rate 0 shows none | shader failure: effect missing, counted | animated | reduced motion: 30% and 25% |

Information architecture: the first glance is the placed campus (C25), then the lit racks (W-RW7), then the plant and fibre glow. Storyboard step 2 ("delight") now has a defined frame and a guard (C28).

AI slop risk: cyan stays reserved for fibre and packets (D17 "Cyan never means a status"); lamps and windows are warm; vapour stays under the bloom threshold (W-RW10). The look follows variant-B-2, compared in the chunk 08 PR (W-RW4).

Accessibility: no new controls in the product UI; the canvas keeps chunk 05's label and keys; reduced motion is covered for vapour and packets (D20) and pending for the LED pulse and fans (UI-4). Desktop only (D1).

Pending design decisions (owner `/plan-design-review`, not decided here):
- UI-4 Reduced-motion behaviour for the chunk 07 LED pulse and the chunk 09 fans (D20 names packets, vapour, rain and lightning only).
- UI-5 Floor sign orientation after rotation (it can read sideways or upside down).
- UI-6 Empty hall-slot look (bare ground or reserved pads).
- UI-7 The hall-label gap at low elevation with zoom above `SEMANTIC_ZOOM`, and the 200 ms fade below 12 px.

What would make it feel inevitable: the campus opening on exactly the mockup frame, with your two halls lit, and growing outward slot by slot without anything moving. 30-minute touches already accepted: perimeter (C27), lamps (W-RW3), seeded lit racks in the hero (W-RW7).

Recommendation: run `/plan-design-review` on Phase 3 before chunk 06 starts, to settle UI-4 to UI-7. After implementation, `/design-review` on the running campus.

Decision gate: UI-4 to UI-7 are design choices left pending with their owner; nothing in the chunk text prescribes them.

### Answered decision C29 (WQ8)

Answer: A, "Add to TODOS.md (recommended)", 2026-10-14.

Commitment comparison:

| Commitment | Source/approval or pending | Current | A | B |
|---|---|---|---|---|
| Shadow camera in Phase 3 | W-RW1 (required) | fitted to the campus extent | unchanged | unchanged |
| View-fitted shadows | none (Section 7 P-1) | none | TODOS.md P3: fit the shadow camera to the visible ground area each time the camera moves, snapped to texel steps to avoid shimmer; trigger: chunk 36 or visible blocky shadows at close zoom | none; recorded in NOT in scope |
| Chunk 36 scope | chunk 36 (approved) | quality tiers | unchanged | unchanged |

Question: D8 — C29: Should "shadows fitted to the visible area" go on the TODO list for later? Project: Synapse Horizon, branch phase-3-world-building, CEO review of Phase 3. ELI10: The campus uses one shadow picture stretched over the whole site. Zoomed out it looks fine; zoomed all the way in, each shadow pixel is about 7 screen pixels wide, so shadow edges look soft or blocky. Fitting the shadow picture to only what is on screen keeps them crisp, at some extra complexity (it must move without shimmering). Nothing approved needs it now. Stakes if we pick wrong: either a known look gap is forgotten, or the TODO list collects work nobody will do. Recommendation: A because it is a real, measurable look gap at close zoom with a natural owner (chunk 36 quality work), and writing it down costs nothing. Note: options differ in kind, not coverage — no completeness score. Net: A remembers it for chunk 36; B drops it.
Header: Shadow TODO
A) Add to TODOS.md (recommended)
P3 item: view-fitted, texel-snapped shadow camera; trigger chunk 36 or visible blockiness at close zoom. Effort S, zero work now. ✅ The close-zoom shadow gap is written down with a trigger and a place to start. ✅ Chunk 36 sees it beside the other quality knobs. ❌ One more P3 item on a list that already has three.
B) Skip
Record it in NOT in scope as not worth doing; no TODO. Effort S, zero work. ✅ Keeps the TODO list to items with a clear payoff. ✅ Fixed campus-fit shadows stay simple and never shimmer. ❌ The gap is easy to forget if close-zoom shadows ever bother you.

### Outside voice (Phase 3)

`codex_reviews` is disabled in gstack config, so no outside review ran and no native replacement was dispatched; recorded as disabled coverage (`gstack-review-log`, 2026-10-14T11:03:53Z). The three spec-review refuter runs in 0H are native, not outside coverage.

### TODOS.md (Phase 3)

One item proposed and added: P3 view-fitted shadow camera (C29, WQ8).

### Reality rows (Phase 3)

The seven `REALITY:` rows are in 0B above. `PLAN_REALITY: phase=ceo rows=7/7 missing=none unverified=3 verdict=complete` (checked on this record alone).

### NOT in scope (Phase 3)

- Deferred: view-fitted shadow camera (C29, WQ8 "Add to TODOS.md"): a close-zoom look gap with a chunk 36 owner.
- Rejected: none.
- Owned elsewhere, unchanged: the shared cut plane during chunk 20's rise and sink (chunk 20); the full-campus draw-call CI budget (chunk 36); a 12-hall churn leak test (chunk 20); real project names on signs (chunk 18); the startup quality probe (C18, `TODOS.md`).
- Pending design decisions, not scope: UI-4 to UI-7 (`/plan-design-review`).

### What already exists (Phase 3)

The 0B table above: the look-dev hall and rack layout, the shared material library and its dispose guard, the glow-above-threshold test, three's `mergeGeometries`, the ground, rig, camera bounds and home fit, `isEmptyGround`, the `dev=1` HUD menu and `__sceneDev`, the draw-call split, the parameter allowlist, the shots config and the look-dev baseline project. Every one is reused; nothing is rebuilt. No seeded RNG existed, so one is added for `fake.ts` and chunk 11 (W-RW37).

### Dream state delta (Phase 3)

After Phase 3 the campus exists, opens on the mockup's frame with two lit halls, grows outward without moving a hall, and exposes every moving part through one `SceneSignals` seam and a pure layout. Still between it and the 12-month ideal: live data in the scene (Phase 5), recognisable project identity on halls (chunk 18 with UI-5 and UI-7), crisp close-up shadows (C29) and the M1 Air-class performance check (chunk 36).

### Error and rescue registry (Phase 3)

The Section 2 tables are the registry: 14 codepaths, 9 rescue rows, 0 GAPS. Named classes: `HallBuildError`, `SignAtlasError`, `WaypointError`, `FibreRouteError`; non-throwing paths: font timeout, shader compile failure, 17th rack key, degenerate extent, dev setter input.

### Failure modes registry (Phase 3)

```text
  CODEPATH                       | FAILURE MODE                          | RESCUED? | TEST? | USER SEES?                | LOGGED?
  -------------------------------|---------------------------------------|----------|-------|---------------------------|--------
  mergeHallParts (06)            | mismatched attributes, null merge     | Y (C23)  | Y     | scene-error card          | Y
  buildHall params (06)          | bad slots or rows                     | Y (C23)  | Y     | scene-error card          | Y
  sign atlas context (06)        | null 2D context                       | Y (C23)  | Y     | scene-error card          | Y
  sign atlas font (06)           | Geist not loaded in 3 s               | Y        | Y     | signs in fallback font    | Y
  setSign text (06)              | long, empty, bad slot                 | Y        | Y     | truncated, letter, card   | Y (slot)
  clip setup (06)                | localClippingEnabled missing          | n/a      | Y     | roof never cuts (caught   | n/a
                                 |                                       |          |       | before merge by test)     |
  sign visibility (06)           | letter under 12 px at some pose       | Y        | Y     | sign hidden               | n/a
  slot allocator (07)            | 17th key                              | Y        | Y     | nothing in Phase 3        | counted
  rack instances (07)            | reallocation on count change          | prevented| Y     | n/a                       | n/a
  shared materials (all)         | a library material disposed           | guard    | Y     | blank halls               | Y (dev)
  rig.setCampus (08)             | zero or NaN extent                    | Y        | Y     | camera unchanged          | Y
  home after placing a hall (08) | stale extent                          | Y        | Y     | wider home on next press  | Y (W-RW36)
  waypoints (08)                 | no path                               | Y (C23)  | Y     | scene-error card          | Y
  double-click on a road (08)    | not ground, home does nothing         | Y        | Y     | glides home               | n/a
  campus baseline (08)           | fallback font or random motion        | prevented| Y     | n/a (test fails loudly)   | Y
  vapour (09)                    | too bright, blooms                    | prevented| Y     | n/a                       | n/a
  vapour (09)                    | sorting seams                         | prevented| Y+eye | n/a                       | n/a
  custom shaders (09, 10)        | compile failure                       | Y        | Y     | that effect missing       | Y
  fibre route (10)               | no route                              | Y (C23)  | Y     | scene-error card          | Y
  fibre rebuild (10)             | line not disposed                     | n/a      | Y     | leak (caught by e2e)      | n/a
  dev setters (07-10)            | NaN or out of range                   | Y        | Y     | clamped value             | Y
  cut plane in chunk 20          | sinking hall shows its roof           | chunk 20 | -     | -                         | -
```

22 rows, 0 CRITICAL GAPS (no row is unrescued, untested and silent).

### Scope expansion decisions (Phase 3)

From the CEO plan (`~/.gstack/projects/bjorkgard-ai-center/ceo-plans/2026-10-14-phase-3-world-building.md`):
- Accepted: C25 first glance and home frame the placed campus; C26 chunk 18 after 08; C27 site perimeter; C28 campus baseline. (C24, the hall bar, was a limit change, not an addition.)
- Deferred: none from the 0G menu (C29 is a Section 7 TODO).
- Skipped: none.

### Diagrams produced (Phase 3)

9: dream state (0C), temporal sequence (0I), architecture (Section 1), state machines (Section 1), error map (Section 2), data flow with shadow paths (Section 4), async ordering (Section 4), test diagram (Section 6), user flow (Section 11).

### Stale diagram audit (Phase 3)

- Section 6 dependency summary: stale after C26; fixed (`08 + 13 → 18`, `18 + 19 + 10 → 20`, `21 + 09 → 22`).
- Section 3 architecture picture: still accurate (Phase 3 adds no data path).
- Section 4b screen layout: unaffected.

## Implementation Tasks (CEO review, Phase 3)

Synthesized from this review's findings. Each task derives from a specific finding above. Run with Claude Code or Codex; checkbox as you ship. Estimates assume features ~30x and tests ~50x human-to-CC ratios [estimated].

- [x] **T1 (P1, human: ~1d / CC: ~30min)** — design — Run `/plan-design-review` on Phase 3 to settle UI-4 to UI-7
  - Surfaced by: Section 11 — UI-4 to UI-7 pending; chunk 07 and 09 acceptance check reduced motion against UI-4
  - Files: `docs/PLAN.md`
  - Verify: the design record answers UI-4 to UI-7 and chunks 07 and 09 name the reduced-motion behaviour
- [x] **T2 (P1, human: ~1d / CC: ~40min)** — chunk 06 — Build the merged vertex-coloured hall body with the clipped roof
  - Surfaced by: C24; W-RW6, W-RW13, W-RW14, W-RW19, W-RW21, W-RW25
  - Files: `src/scene/hall/buildHall.ts`, `src/scene/hall/buildHall.test.ts`, `src/scene/materials.ts`, `src/scene/materials.test.ts`, `src/scene/render.ts`, `src/scene/render.test.ts`, `src/scene/LookDev.tsx`, `src/scene/lookdevLayout.ts`
  - Verify: `vp test`; `?view=hall&dev=1` HUD shows at most 4 scene draw calls per hall; `vp run e2e:local` look-dev baseline updated in the PR
- [x] **T3 (P1, human: ~1d / CC: ~30min)** — chunk 06 — Sign atlas, letter measure, pose visibility and font wait
  - Surfaced by: W-RW5, W-RW17, W-RW24, W-RW26, W-RW29, W-RW33; Section 1 A-3; Section 4 async ordering
  - Files: `src/scene/hall/signAtlas.ts`, `src/scene/hall/signAtlas.test.ts`, `src/scene/camera.ts`, `src/scene/camera.test.ts`, `src/app/App.tsx`
  - Verify: unit sweep over elevation and 45 degree azimuths in both projections; fake `document.fonts` order test; e2e at `view=hall`
- [ ] **T4 (P2, human: ~2h / CC: ~10min)** — chunks 06-10 — New `view` values and shots entries
  - Surfaced by: W-F8; W-RW7
  - Files: `src/app/params.ts`, `src/app/params.test.ts`, `scripts/shots.config.ts`, `src/scene/SceneCanvas.tsx`
  - Verify: params unit tests; `vp run shots` writes `06-hall.png`, `07-racks.png`, `08-campus.png`, `09-cooling.png`, `10-power-network.png` under 200 KB
- [x] **T5 (P1, human: ~1d / CC: ~30min)** — chunk 07 — Rack instances, slot allocator, `SceneSignals`, `fake.ts` and the shared RNG
  - Surfaced by: W-RW8, W-RW9, W-RW20, W-RW28, W-RW34, W-RW37
  - Files: `src/scene/hall/slots.ts`, `src/scene/hall/slots.test.ts`, `src/scene/hall/RackInstances.tsx`, `src/scene/signals.ts`, `src/scene/fake.ts`, `src/scene/fake.test.ts`, `src/sim/rng.ts`, `src/sim/rng.test.ts`
  - Verify: `vp test`; e2e geometries constant across 0, 16, 0 racks; two frozen `view=racks` captures match
- [ ] **T6 (P2, human: ~3h / CC: ~15min)** — chunks 07-10 — Dev sections and clamped `__sceneDev` setters
  - Surfaced by: W-RW12, W-RW20, W-RW31
  - Files: `src/scene/PerfHud.tsx`, `src/scene/devHooks.ts`, `src/app/globals.d.ts`
  - Verify: unit tests for NaN, negative, non-integer and too-large input; e2e drives each setter in the production build
- [x] **T7 (P1, human: ~1d / CC: ~40min)** — chunk 08 — Campus layout, `rig.setCampus`, derived bounds, ground and shadow, C25 home
  - Surfaced by: W-F1, W-F3; C25; W-RW1, W-RW27, W-RW32, W-RW38
  - Files: `src/scene/campus/layout.ts`, `src/scene/campus/layout.test.ts`, `src/scene/camera.ts`, `src/scene/camera.test.ts`, `src/scene/controls.test.ts`, `src/scene/Ground.tsx`, `src/scene/LightRig.tsx`, `e2e/camera.spec.ts`
  - Verify: layout and rig unit tests; updated `e2e/camera.spec.ts:121`, `:185-187`, `:240` pass at 1280x720 and 1920x1080
- [x] **T8 (P1, human: ~1.5d / CC: ~45min)** — chunk 08 — Roads, parking, gate, dock, lamps, perimeter, ground flags and waypoints
  - Surfaced by: W-F4; C27; W-RW3, W-RW9, W-RW35
  - Files: `src/scene/campus/` (new components), `src/scene/campus/waypoints.ts`, `src/scene/campus/waypoints.test.ts`, `src/scene/materials.ts`, `src/scene/LookDev.tsx`
  - Verify: waypoint unit tests; HUD under 40 scene draw calls; double-click on a road glides home (e2e)
- [x] **T9 (P1, human: ~3h / CC: ~15min)** — chunk 08 — Campus baseline, Playwright wiring, mockup compare and README controls
  - Surfaced by: W-F5; C28; W-RW4, W-RW15, W-RW39, W-RW40
  - Files: `e2e/campus.spec.ts`, `playwright.config.ts`, `e2e/__screenshots__/`, `README.md`, `docs/img/08-campus.png`
  - Verify: `playwright test --list` shows `campus.spec.ts` only in the `lookdev` project; `vp run e2e:local` passes; the PR shows the image pair
- [ ] **T10 (P1, human: ~1.5d / CC: ~45min)** — chunk 09 — Cooling plant, sorted normal-blended vapour, seeded fans, shader-error hook
  - Surfaced by: W-F9, W-F11; W-RW8, W-RW10, W-RW16, W-RW18, W-RW30
  - Files: `src/scene/plant/` (new components), `src/scene/plant/vapour.ts`, `src/scene/plant/vapour.test.ts`, `src/scene/SceneCanvas.tsx`
  - Verify: sort and luminance unit tests; two frozen `view=cooling` captures match; reduced-motion e2e; four-azimuth shots and a Safari note in the PR
- [ ] **T11 (P1, human: ~1.5d / CC: ~45min)** — chunk 10 — Power yard, road-grid fibre routing and seeded packets
  - Surfaced by: W-F12; W-RW11, D20
  - Files: `src/scene/power/` (new components), `src/scene/fibre/route.ts`, `src/scene/fibre/route.test.ts`, `src/scene/fibre/Packets.tsx`
  - Verify: route unit test; e2e removing a hall returns geometry and texture counts; reduced-motion e2e at 25% speed
- [x] **T12 (P2, human: ~1h / CC: ~5min)** — chunks 06-10 — `[scene]` transition lines for roof and placed halls
  - Surfaced by: Section 8 O-1; W-RW36
  - Files: `src/scene/sceneLog.ts`, `src/scene/sceneLog.test.ts`
  - Verify: unit test asserts one line per transition

### Completion summary (Phase 3)

```text
  +====================================================================+
  |            MEGA PLAN REVIEW — COMPLETION SUMMARY                   |
  +====================================================================+
  | Mode selected        | SELECTIVE EXPANSION                         |
  | System Audit         | no Phase 3 code; bounds, ground and shadow  |
  |                      | sized for the test cube; shadow draws count |
  |                      | in the HUD; Geist is font-display swap; no  |
  |                      | seeded RNG; camera e2e encodes old home     |
  | Step 0               | WQ1 mode; C24 hall bar 4; C25-C28 accepted  |
  |                      | (4 of 4); spec review 3 runs, 6/8/9         |
  | Section 1  (Arch)    | 3 issues found (A-1 to A-3, fixed)          |
  | Section 2  (Errors)  | 14 error paths mapped, 0 GAPS               |
  | Section 3  (Security)| 1 issue found, 0 High severity              |
  | Section 4  (Data/UX) | 11 edge cases mapped, 0 unhandled           |
  |                      | (1 owned by chunk 20)                       |
  | Section 5  (Quality) | 3 issues found (1 fixed, 2 guidance)        |
  | Section 6  (Tests)   | Diagram produced, 1 gap (W-RW38, fixed)     |
  | Section 7  (Perf)    | 4 issues found (1 TODO, 2 guidance, 1 note) |
  | Section 8  (Observ)  | 1 gap found (O-1, W-RW36)                   |
  | Section 9  (Deploy)  | 2 risks flagged (R-1, R-2, fixed)           |
  | Section 10 (Future)  | Reversibility: 3-5/5, debt items: 5         |
  | Section 11 (Design)  | 4 issues, to /plan-design-review (UI-4..7)  |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (1 deferred, 5 owned elsewhere)     |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 14 rows, 0 CRITICAL GAPS                    |
  | Failure modes        | 22 total, 0 CRITICAL GAPS                   |
  | TODOS.md updates     | 1 item proposed (C29, added)                |
  | Scope proposals      | 4 proposed, 4 accepted (SELECTIVE)          |
  | CEO plan             | written                                     |
  | Outside voice        | codex disabled (config)                     |
  | Lake Score           | N/A (no question was scored for coverage)   |
  | Diagrams produced    | 9 (dream, temporal, arch, state, error,     |
  |                      | data flow, async, tests, user flow)         |
  | Stale diagrams found | 1 (section 6, fixed)                        |
  | Unresolved decisions | 4 (UI-4 to UI-7, to /plan-design-review)    |
  | Reality rows         | 7/7 rows (PLAN_REALITY complete), 3 unverif.|
  +====================================================================+
```

Spec review: 3 refuter runs (scores 6, 8, 9); 20 issues found, 18 confirmed fixed by a later reviewer, the last 2 fixed by Claude and checked against the text (issues verified: 2 of 2), spec not re-verified by a reviewer after the third run. Required work: W-RW1 to W-RW40.

### Unresolved decisions (Phase 3)

All four were settled by the Phase 3 design review on 2026-10-14 (see "Design review record: Phase 3"); listed here as they stood when this CEO review ended.

- UI-4 reduced-motion behaviour for the LED pulse and fans (owner `/plan-design-review`).
- UI-5 floor sign orientation (owner `/plan-design-review`).
- UI-6 empty hall-slot look (owner `/plan-design-review`).
- UI-7 hall-label gap at low elevation and the fade below 12 px (owner `/plan-design-review`).

Open verifications (not decisions): campus extent and home fit [estimated]; Safari vapour sorting (manual); chunk 08 draw-call total [estimated]; three's texture re-upload of the sign atlas after a context restore [inference].

## Design review record: Phase 3 (/plan-design-review, 2026-10-14)

Target: `docs/PLAN.md` Phase 3 (chunks 06-10), branch `phase-3-world-building`, after the Phase 3 CEO review. Reviewer: Claude (in-host), plus one independent Claude subagent (Codex disabled). Question numbers D1, D2... are this review's own sequence; findings are numbered WD1, WD2... (world design).

System audit: no DESIGN.md (tokens live in section 4b and `src/styles/tokens.css`; a full DESIGN.md was deferred by the 2026-10-12 design review). Phase 3 UI scope: the static campus (hall body, windows, sign, racks and LEDs, roads, parking, gate, dock, lamps, perimeter, monument, cooling plant, vapour, power yard, fibre, packets), the C25 first glance, and four new dev-menu sections. Prior design reviews: main 4/10 to 7/10, Phase 2 5/10 to 7/10; both held Pass 4 at 7 for the accepted dark neon-glass look.

Step 0: initial rating 5/10 (parts named and a mockup reference, but sign, composition, effect values, reduced motion for pulse and fans, empty slots and label coverage unspecified). Focus: all 7 passes with mockups (D2).

Correction to a statement made in this review's D4 confirmation: section 4b D17 says "Cyan never means a status"; it does not reserve cyan for fibre. Fibre and packets (D10) and the overflow conduit (D8) are cyan. Keeping the sign panel's glow out of cyan still holds, so that cyan stays the colour of network lines.

### Approved Mockups

| Screen/Section | Mockup Path | Direction | Notes |
|----------------|-------------|-----------|-------|
| Hall identity (UI-5) | /Users/nathanael/.gstack/projects/bjorkgard-ai-center/designs/hall-identity-20261014/variant-B.png | backlit sign panel on top of each hall's front wall, above the door: hall letter larger than the project name | not adopted: the panel's cyan-white edge glow, rack rows other than 2 x 8 (D8); panel values are WD5 |
| Empty hall slot (UI-6) | /Users/nathanael/.gstack/projects/bjorkgard-ai-center/designs/empty-slot-20261014/variant-B.png | flat concrete pad a step lighter than the ground, thin light outline, painted slot letter at the front edge | not adopted: fibre into the empty slot (W-RW11 placed halls only), painted letters on hall walls, and the painted "C" (pads show slot numbers, WD11b); pad values are WD11 |

Mockup generation: 6 images requested, 6 saved; the vision check passed 1 (rack counts and 1536x864 or 3:2 framing off-brief), which the user was told before choosing (D3). Board submissions: hall identity B (ratings A 3, B 4, C 4), empty slot B (A 2, B 5, C 4); confirmed in D4.

### Outside voice (design, Phase 3)

CLAUDE SUBAGENT (design completeness) [single-model], 12 findings (2 critical, 6 high, 4 medium), folded into the passes below; report at `.claude/scratch/phase-3-world-building/reports/design-voice-04.md`. Codex disabled (`codex_reviews`), recorded `outside_status: disabled`. Its triangle-budget finding is engineering scope and goes to `/plan-eng-review`.

### Pending findings (each needs its own decision)

- WD1 [critical] Campus composition: where zones sit and how big halls, slots and towers are (chunk 08 `layout.ts` has invariants only). Pass 1.
- WD2 [critical] Brightness ladder: emissive order of beacon, packets, fibre, windows, lamps, sign and LEDs; D6 says the waiting beacon is the strongest scene signal. Pass 1.
- WD3 [high] UI-7 label coverage: a front-wall panel cannot be read from behind or at grazing angles, and chunk 18's billboards show only below `SEMANTIC_ZOOM`. Pass 2.
- WD4 [high] The look with bloom off (medium and low tiers): fibre, packets and windows lose their glow. Pass 2.
- WD5 [high] Sign panel anatomy (UI-5 values) and chunk 06's floor-sign text. Pass 5.
- WD6 [high] LEDs per rack, pulse shape and the fake status mix (capacity is fixed once, W-RW8). Pass 5.
- WD7 [high] UI-4 reduced motion for the LED pulse and the fans. Pass 5.
- WD8 [high] Fibre and packet values. Pass 5.
- WD9 [high] Vapour and fan values. Pass 5.
- WD10 [high] Site furniture colours against the status palette. Pass 5.
- WD11 [medium] Empty-slot pad values (UI-6 values). Pass 5.
- WD12 [medium] Gate monument copy: variant-B-2 says "SYNAPSE AI DATA CENTRE", the app is "Synapse Horizon". Pass 5.
- WD13 [medium] Rack LEDs carry status by colour only. Pass 6.
- WD14 [medium] Dev-menu sections: order, collapse state, and the roof toggle's missing control and hook. Pass 7.

### Pass 1: Information architecture (Phase 3) — 5/10 → 9/10

```text
  WHAT THE EYE FINDS FIRST AT THE STARTUP VIEW (C25 frame, WD2 ladder)
  1  chunk 18: a waiting beacon (4.0), the strongest signal (D6)
  2  moving packets on fibre (3.2), then the fibre network itself (2.6)
  3  the halls: warm windows (2.0) framing racks and LEDs (1.0); sign panels (0.5) when close enough
  4  the plant: towers with vapour top-left, power yard left (WD1 composition)
  5  site: roads and lamps (1.6), parking, gate and monument, perimeter trees and fence
```

- WD1 resolved: D6 "1A Follow the mockup (recommended)", applied to chunk 08's Campus layout item (composition, sizes, plan sketch).
- WD2 resolved: D7 "2A Ladder, mockup hues (recommended)", applied to the Phase 3 heading and chunk 18's beacon.
- Re-rated 9: the frame, the arrangement and the attention order are now written; the remaining gap is what labels the halls at every camera pose (Pass 2, WD3).

### Pass 2: Interaction state coverage (Phase 3) — 6/10 → 9/10

```text
  FEATURE          | LOADING                     | EMPTY                          | ERROR                         | SUCCESS                    | PARTIAL
  Campus           | loader until frame + atlas  | A and B with seeded fake racks | C23 card for build errors     | placed campus, WD2 ladder  | bloom off: glow x1.5 (WD4)
  Hall label       | none until atlas ready      | letter only (empty name)       | fallback font after 3 s       | panel when readable;       | Phase 3: no label while the
                   |                             |                                |                               | billboard otherwise (WD3)  | panel is hidden (until 18)
  Empty hall slot  | -                           | marked pad, slot letter (UI-6) | -                             | -                          | -
  Vapour / packets | none                        | duty 0 / rate 0: none          | shader failure: effect gone   | animated                   | reduced motion (D20, WD7)
```

- WD3 resolved: D8 "3A Panel, else billboard (recommended)", applied to chunk 06 (Tasks, Acceptance, Sign item), chunk 18 and section 4b D7 and D9 (annotations). UI-5's approved direction (sign panel) applied to the same places.
- WD4 resolved: D9 "4A Brighter glow (recommended)", applied to the Phase 3 heading.
- Re-rated 9: every Phase 3 visual has its states; the remaining gap is the Phase 3-only window before chunk 18 where a hidden panel leaves a hall unlabelled, accepted as part of WD3.

### Pass 3: User journey and emotional arc (Phase 3) — 7/10 → 9/10

```text
  STEP | USER DOES                                   | USER FEELS              | PLAN SPECIFIES
  -----|---------------------------------------------|-------------------------|-------------------------------------------------
  1    | Opens the app                               | curious                 | loader until frame and atlas (W-RW29); C25 frame
  2    | Sees the campus arrive                      | recognition: the mockup | WD1 composition; WD2 ladder; seeded lit racks (W-RW7)
  3    | Zooms toward a hall                         | oriented                | sign panel "A · alpha" appears at 12 px (WD5)
  4    | Orbits behind the hall                      | never lost              | chunk 18 billboard takes over (WD3)
  5    | Pans to cooling and power                   | "it's a real place"     | soft plumes, idling fans (WD9); fibre and packets (WD8)
  6    | Leaves the tab open for days                | calm, ambient trust     | 30 fps calm mode (C16); packets capped at 12 per line (WD8)
  7    | Has reduced motion on                       | comfortable             | steady LEDs, fans 25%, vapour 30%, packets 25% (WD7, D20)
  8    | Notices an empty pad marked "03"            | "room to grow"          | marked pads (WD11) with true slot numbers (WD11b)
```
Time horizons: 5 s visceral (steps 1-2), 5 min behavioural (steps 3-5), long-term reflective (steps 6-8).

- No separate issue: the gaps this storyboard exposed (reduced motion, ambient caps, labels from behind) were asked as WD3, WD7, WD8 and WD9. Re-rated 9: the remaining gap is live data on day one, which is Phase 5.

### Pass 4: AI slop risk (Phase 3) — 7/10 → 7/10

Classifier: EXPERIENCE for the 3D campus (the work fills the viewport; Phase 3 adds no panel UI). Hard rejections: none (no cards, no hero copy, no carousel). Litmus, from the approved mockups and plan text: brand in first screen YES (top-bar wordmark and the "SYNAPSE HORIZON" monument, WD12); one visual anchor YES (the campus); scannable YES (hall sign panels and, from chunk 18, billboards); one job per element YES (colour only where it means something, WD10); cards necessary n/a (none); motion helps YES (ambient, capped, ladder-ranked, WD2, WD8, WD9); premium without decorative shadows YES (real directional shadows give depth; the mockup panel's cyan edge glow was not adopted). Calibration: this is look (2), near-black with one neon accent and glowing edges, which the brief asked for and the user approved (design D14); not a fallback. Score stays 7 for that accepted tradeoff, as in the earlier design reviews. No new issue.

### Pass 5: Design system alignment (Phase 3) — 4/10 → 8/10

- WD5 resolved: D10 "5A Token-based panel (recommended)", applied to chunk 06's sign item.
- WD6 resolved: D11 "6A Strip + 12 blades (recommended)", applied to chunks 07 (Tasks, Instances, Fake load) and 18.
- WD7 resolved (UI-4): D12 "7A Steady LEDs, fans 25% (recommended)", applied to chunks 07 and 09 and section 4b D20.
- WD8 resolved: D13 "8A Thin lines, capped spheres (recommended)", applied to chunk 10.
- WD9 resolved: D14 "9A Soft plumes, idling fans (recommended)", applied to chunk 09.
- WD10 resolved: D15 "10A Neutral site (recommended)", applied to the Phase 3 heading.
- WD11 resolved (UI-6): D16 "11A Pad + letter, 12 px rule (recommended)", then D17 "11bA Slot number (recommended)" on new evidence (chunk 19 assigns letters by project order, overflow halls take the lowest free slot); applied to chunk 08's Empty slots item.
- WD12 resolved: D18 "12A SYNAPSE HORIZON (recommended)", applied to chunk 08's Site perimeter item.
- DESIGN.md: still absent (deferred by the 2026-10-12 design review; tokens in section 4b). Re-rated 8: every Phase 3 visual now has values from tokens or the material library [most sizes estimated, tuned against the look-dev baseline]; the remaining gap is the missing DESIGN.md itself.

### Pass 6: Responsive and accessibility (Phase 3) — 7/10 → 9/10

- Responsive: desktop only from 1280x720 (D1); the sign and slot-number 12 px rule measures CSS px at the current pose, so it holds at 1280x720 and 1920x1080 alike. No new issue.
- Reduced motion: every Phase 3 animation now has a rule (D20 plus WD7).
- WD13 resolved: D19 "13A Document cues (recommended)", applied to chunk 07 (Instances) and chunk 37 (colour-blindness simulation). Prior learning applied: speaker-origin-icon-accessibility, "never color-only meaning" (confidence 10/10, from 2026-09-19).
- Keyboard and screen readers: Phase 3 adds no focusable control; the canvas keeps chunk 05's label and keys (DR15). No new issue.
Re-rated 9: the remaining gap is the Phase 3-only window before chunks 18 and 22, where an error LED is colour-only in the scene (accepted in WD13).

### Pass 7: Unresolved design decisions (Phase 3)

```text
  DECISION NEEDED                                   | RESOLUTION
  --------------------------------------------------|------------------------------------------------------------
  UI-4 reduced motion for LED pulse and fans (CEO)  | D12 (WD7): steady LEDs at 0.8, fans at 25%
  UI-5 hall sign orientation (CEO)                  | D3/D4 board: wall panel (upright, never upside down); D10 (WD5) values
  UI-6 empty hall-slot look (CEO)                   | D3/D4 board: marked pad; D16 (WD11) values; D17 (WD11b) slot numbers
  UI-7 hall-label gap and fade (CEO)                | D8 (WD3): panel when readable, else billboard; fade accepted as D7's
  WD14 dev-menu sections and roof toggle            | D20 "14A Section per chunk (recommended)"
  Triangle budgets per part (outside voice 12)      | engineering scope: handed to /plan-eng-review, not decided here
```

WD14 resolved and applied to the Phase 3 heading and chunk 06. 5 resolved, 0 deferred.

### Approval reconciliation (design, Phase 3)

Every applied fix has its own answer: UI-5 and UI-6 directions (D3 board submissions, D4 confirmation), WD1 (D6), WD2 (D7), WD3 and UI-7 (D8, amending D7 on new evidence: free rotation leaves a wall panel unreadable from behind), WD4 (D9), WD5 (D10), WD6 (D11), WD7 and UI-4 (D12), WD8 (D13), WD9 (D14), WD10 (D15), WD11 (D16), WD11b (D17, reopening D16's letter on new evidence: chunk 19 assigns letters by project order), WD12 (D18), WD13 (D19), WD14 (D20). Pass 3 and Pass 4 made no change. Setup and navigation answers (D1, D2, D5, D21) approved no fix. The correction about cyan in the record header is factual, not a design change.

### NOT in scope (design, Phase 3)

- A full DESIGN.md: deferred by the 2026-10-12 design review (tokens live in section 4b); `/design-consultation` can create one later.
- Regenerated mockups after the passes: declined (D21); the plan text governs.
- Triangle budgets per part: engineering scope, handed to `/plan-eng-review`.
- Chunk 22's heat wash runs amber to red on hot aisles, near the error red; chunk 22's own review owns that hue.
- D8's cyan overflow conduit: unchanged (D17 forbids cyan only as a status).
- Revisiting the dark neon-glass look: an accepted tradeoff (design D14, D18).

### What already exists (design, Phase 3)

Section 4b (D6, D7, D9, D14, D16, D17, D20, D22), `src/styles/tokens.css` (`--color-text-2`, `--color-text-3`, Geist), the material library (`src/scene/materials.ts`: slate, concrete, roof, window glow, fibre glow, status LEDs, vendor trim), the look-dev view and baseline, the approved variant-B-2 and the two Phase 3 mockups. Every Phase 3 value reuses these; the new values are the emissive ladder, the site palette greys, and the vapour, packet and pad colours.

### TODOS.md (design, Phase 3)

No TODO proposals: no decision was deferred.

## Implementation Tasks (design review, Phase 3)

Synthesized from this review's findings; they extend the CEO tasks T1-T12 (CEO T1, run this review, is done). Effort ratios assumed: features ~30x, tests ~50x.

- [x] **T1 (P1, human: ~3h / CC: ~15min)** — chunk 06 sign — Wall sign panel with token values, pose visibility rule and dormant text
  - Surfaced by: Pass 2 — WD3 (UI-7); Pass 5 — WD5 (UI-5)
  - Files: `src/scene/hall/signAtlas.ts`, `src/scene/hall/SignPanel.tsx`, `src/scene/hall/signAtlas.test.ts`, `src/scene/camera.ts`
  - Verify: unit sweep shows the panel only when it faces the camera and the name measures 12 CSS px or more; atlas test draws "A · alpha" and "A · No sessions" in the token colours
- [x] **T2 (P1, human: ~2h / CC: ~10min)** — materials — Emissive ladder, bloom-off factor and `setQuality` hook
  - Surfaced by: Pass 1 — WD2; Pass 2 — WD4
  - Files: `src/scene/materials.ts`, `src/scene/materials.test.ts`, `src/scene/render.ts`, `src/scene/devHooks.ts`
  - Verify: unit test asserts sign < LEDs < lamps < windows < fibre < packets (< beacon in chunk 18) and the 1.5 factor keeps the order; chunk 08 PR shows a frozen `home` with bloom forced off
- [x] **T3 (P1, human: ~3h / CC: ~15min)** — chunk 08 layout — Variant-B-2 composition and sizes in `layout.ts`
  - Surfaced by: Pass 1 — WD1
  - Files: `src/scene/campus/layout.ts`, `src/scene/campus/layout.test.ts`
  - Verify: unit test checks zone order at the startup azimuth (cooling top-left, power left, halls centre, gate bottom-centre, parking bottom-right, dock right) and a 16-rack hall of about 8 x 6 units
- [x] **T4 (P1, human: ~3h / CC: ~15min)** — chunk 07 LEDs — Status strip plus 12 blades, pulse range, seeded hero mix, steady under reduced motion
  - Surfaced by: Pass 5 — WD6, WD7 (UI-4)
  - Files: `src/scene/hall/RackInstances.tsx`, `src/scene/fake.ts`, `src/scene/fake.test.ts`
  - Verify: unit tests: 208 LED instances per hall; pulse stays in 0.6-1.0; hero mix 60/25/10/5 for seed 1; reduced motion holds 0.8
- [ ] **T5 (P2, human: ~3h / CC: ~15min)** — chunk 10 network — Fibre look, junction boxes, capped packet spheres
  - Surfaced by: Pass 5 — WD8
  - Files: `src/scene/fibre/route.ts`, `src/scene/fibre/Fibre.tsx`, `src/scene/fibre/Packets.tsx`, `src/scene/fibre/route.test.ts`
  - Verify: unit test caps 12 packets per line and spacing of 1.2 units or more; frozen `view=power` shot in the PR
- [ ] **T6 (P2, human: ~3h / CC: ~15min)** — chunk 09 plant — Vapour and fan values, idle fans at duty 0
  - Surfaced by: Pass 5 — WD9, WD7
  - Files: `src/scene/plant/vapour.ts`, `src/scene/plant/vapour.test.ts`, `src/scene/plant/Towers.tsx`
  - Verify: unit tests: no particles at duty 0, 60 per tower at duty 1, fans at 10% at duty 0 and 25% under reduced motion
- [x] **T7 (P2, human: ~2h / CC: ~10min)** — chunk 08 palette — Neutral site colours and the hue test
  - Surfaced by: Pass 5 — WD10
  - Files: `src/scene/materials.ts`, `src/scene/materials.test.ts`
  - Verify: unit test keeps every furniture colour's hue and saturation away from the D17 status and vendor colours
- [x] **T8 (P2, human: ~2h / CC: ~10min)** — chunk 08 slots — Empty-slot pads with slot numbers under the 12 px rule
  - Surfaced by: Pass 5 — WD11, WD11b (UI-6)
  - Files: `src/scene/campus/SlotPads.tsx`, `src/scene/hall/signAtlas.ts`
  - Verify: e2e at `view=home`: pads show `03`-`12` only when zoomed in; no pad shows a hall letter
- [x] **T9 (P3, human: ~30min / CC: ~5min)** — chunk 08 monument — "SYNAPSE HORIZON" wordmark from the atlas
  - Surfaced by: Pass 5 — WD12
  - Files: `src/scene/campus/Monument.tsx`
  - Verify: campus baseline (C28) shows the wordmark; no "AI DATA CENTRE" string in `src/`
- [ ] **T10 (P2, human: ~1h / CC: ~5min)** — dev menu — Sections in build order and `setRoofCut`
  - Surfaced by: Pass 7 — WD14
  - Files: `src/scene/PerfHud.tsx`, `src/scene/devHooks.ts`
  - Verify: e2e with `dev=1`: sections Camera (open), Hall, Racks, Campus, Cooling, Network (collapsed); `setRoofCut(false)` restores the roof
- [ ] **T11 (P2, human: ~1h / CC: ~5min)** — chunk 18 labels — Billboard also shows while a hall's panel is hidden
  - Surfaced by: Pass 2 — WD3
  - Files: to be determined in chunk 18
  - Verify: unit test: at every sampled pose each hall has exactly one visible label
- [ ] **T12 (P3, human: ~1h / CC: ~10min)** — chunk 37 audit — Colour-blindness simulation of the error cart and waiting beacon
  - Surfaced by: Pass 6 — WD13
  - Files: to be determined in chunk 37
  - Verify: protanopia and deuteranopia simulated screenshots show the cart and beacon

_No new tasks from Pass 3 (journey) or Pass 4 (AI slop)._

### Completion summary (design, Phase 3)

```text
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | no DESIGN.md (deferred earlier); Phase 3 UI: |
  |                      | static campus, signs, slots, effects, first |
  |                      | glance, dev-menu sections                   |
  | Step 0               | 5/10; all 7 passes with mockups (D2)        |
  | Pass 1  (Info Arch)  | 5/10 → 9/10 after fixes                     |
  | Pass 2  (States)     | 6/10 → 9/10 after fixes                     |
  | Pass 3  (Journey)    | 7/10 → 9/10 after fixes                     |
  | Pass 4  (AI Slop)    | 7/10 → 7/10 after fixes                     |
  | Pass 5  (Design Sys) | 4/10 → 8/10 after fixes                     |
  | Pass 6  (Responsive) | 7/10 → 9/10 after fixes                     |
  | Pass 7  (Decisions)  | 5 resolved, 0 deferred                      |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (6 items)                           |
  | What already exists  | written                                     |
  | TODOS.md updates     | 0 items proposed                            |
  | Approved Mockups     | 6 generated (6 requested), 2 approved       |
  | Decisions made       | 17 added to plan                            |
  | Decisions deferred   | 0                                           |
  | Overall design score | 4/10 → 7/10                                 |
  +====================================================================+
```

Overall score basis: the lowest rated pass, before (Pass 5 at 4) and after (Pass 4 at 7). Pass 4 stays at 7 because of the accepted dark neon-glass look (design D14, D18), not an open finding; every other pass is 8 or more. Decisions made: UI-5 and UI-6 directions (board), WD1 to WD14 and WD11b.

### Unresolved decisions (design, Phase 3)

None.

## Eng review record: Phase 3 (/plan-eng-review, 2026-10-14)

Target: `docs/PLAN.md` Phase 3 (chunks 06-10) as amended by the Phase 3 CEO review (C24-C29, W-RW1-W-RW40) and design review (WD1-WD14, WD11b), branch `phase-3-world-building`, base `main` at `5cc28e9`. Report file: this plan. Reviewer: Claude (in-host). Questions in this record are numbered D1, D2... (this review's own sequence); ledger rows continue the eng series at E26. Design doc: `docs/designs/phase-3-world-building.md` (the Phase 3 CEO summary).

### Scope record (eng, Phase 3)

feature answers: none proposed (no cut or deferral was offered; the CEO and design reviews settled scope); structure: B "Smaller arrangement (recommended)", D1, 2026-10-14; accepted scope: pure modules as planned (`hall/buildHall.ts`, `hall/signAtlas.ts`, `hall/slots.ts`, `scene/signals.ts`, `scene/fake.ts`, `sim/rng.ts`, `campus/layout.ts`, `campus/waypoints.ts`, `plant/vapour.ts`, `fibre/route.ts`), and one view file per chunk (`hall/Hall.tsx`, `campus/Campus.tsx`, `plant/Plant.tsx`, `network/Network.tsx`), each split by part only past about 300 lines; about 18 source files [estimated]; pending remedies: E26, E27, E28.

### Scope Challenge findings (eng, Phase 3)

- SC-1 [P2] (confidence: 9/10) docs/PLAN.md:501-575 — about 30 new source files and 20+ new modules across chunks 06-10 [estimated]. Resolved by D1 (smaller arrangement).
- No other Scope Challenge findings: reuse is mapped in the CEO record's 0B; no work is deferrable without breaking a later chunk (CEO 0G); `TODOS.md` holds nothing that blocks Phase 3 (C29 shadow fit is P3 for chunk 36).
- Search check: per-instance opacity on an InstancedMesh needs an attribute and a shader patch, with a CPU distance sort at modest counts [Layer 1]; canvas text must await `document.fonts.load` before `fillText` [Layer 1]. Both match the plan (W-RW18, W-RW29).
- Result: scope accepted as-is (the smaller arrangement keeps every feature and contract).

### 1. Architecture review (eng, Phase 3)

```text
  scene time t (driver.ts, 0 under freeze) + seed
        │
        ▼
  SceneSignals ── fake.ts (closed form, E26) ── later: store-backed (chunks 18, 22)
        │ rackCount(hall) ledLoad(hall, rack) duty() vapourPhase(i) fanAngle(i) packetPhase(line, j)
        ▼
  view files ── Hall.tsx: body (merged, vertex colours, clip plane) │ windows │ sign panels │ rack + LED instances
             ── Campus.tsx: roads, parking, gate, dock, lamps, perimeter, monument, slot pads
             ── Plant.tsx: towers, chillers, fans, vapour instances (sorted on camera change)
             ── Network.tsx: power yard, vault, fibre tubes, junction boxes, packet instances
        │ instance matrices / colours / opacity written in place, no allocation per frame
        ▼
  renderer (shadow pass + main pass) ── HUD counts (S-RW4)

  layout.ts ──► rig.setCampus(bounds, home) ──► camera clamp, home fit, startup pose (C25)
           ──► Ground / LightRig extent;  waypoints.ts;  route.ts (fibre on the road grid)
  signAtlas ──(document.fonts.load, 3 s)──► ready = first frame AND atlas (W-RW29); WebGL-unavailable path unchanged (S-RW19)
```

Findings, most severe first:
- E-A1 [P1] (confidence: 9/10) `src/scene/loop/driver.ts:101-104` — `if (hasRendered && !freeze) { sceneSeconds += ... }`: scene time stays 0 in every frozen shot, so emission-based vapour and packets would be empty or clumped in the C28 baseline. Resolved by E26 (D2).
- E-A2 [P3] (confidence: 7/10) `src/app/App.tsx:38` — `window.__sceneReady = value;`: W-RW29 makes ready wait for the atlas as well as the first frame; the WebGL-unavailable path still ends the loader on `unavailable` (S-RW19), so the card never waits on fonts. Recorded; no change needed.
- Production failure per new path: atlas font load fails (fallback, W-RW29); `mergeGeometries` null (W-RW13); shader patch or custom shader fails (W-RW30); route or waypoint missing (static, C23). All handled in the CEO Section 2 map.
- Distribution: no new artifact; the SEA build embeds `dist/` as before (02b).

Dispositions: E-A1 accepted (D2, E26); E-A2 no change.

### 2. Code quality review (eng, Phase 3)

Findings, most severe first:
- E-Q1 [P2] (confidence: 8/10) docs/PLAN.md:490 — "shared instances only (no per-mesh materials)", against docs/PLAN.md:514 (sign panel "fades over 200 ms when it crosses"), docs/PLAN.md:553 (slot number "shows only while it measures ...") and E26's closed-form vapour, whose particles are reborn in place and would pop without a fade. Three callers need a per-instance fade that a shared material cannot give. Shared-code rubric: the callers are proposed (chunks 06, 08, 09), not existing source; the reuse ladder finds no existing helper (`src/scene/materials.ts` has none); three's built-in materials have no per-instance opacity [Layer 1, search above]. Resolved by E27 (D3).
- E-Q2 [P3] (confidence: 7/10) docs/PLAN.md:512 — `setHallTint` and `setAisleTint` write colour ranges inside one merged body; `mergeGeometries` concatenates parts in input order, so `buildHall` records each part's vertex range as it merges. Covered by W-RW21's tests; guidance only.
- E-Q3 [P3] (confidence: 6/10) Medium confidence, verify this is actually an issue: `campus/Campus.tsx` holds eight parts under D1; the 300-line split rule covers it.
- Diagrams in touched sections are current (section 6 updated by C26; chunk 08's plan sketch by WD1).

Dispositions: E-Q1 accepted (D3, E27); E-Q2 and E-Q3 no change.

### 3. Test review (eng, Phase 3)

Framework: Vitest through `vp test` (configured in `vite.config.ts`) and Playwright (`playwright.config.ts`); 44 test files today [measured: `git ls-files`]. CLAUDE.md has no Testing section.

```text
CODE PATHS (proposed)                                          USER FLOWS
[+] hall/buildHall.ts                                          [+] Open app, campus arrives (C25)
  ├── mergeHallParts: ok / mismatched -> HallBuildError          ├── [PLANNED ★★★] loader until frame + atlas; startup frame — camera.spec (W-RW38)
  │     [PLANNED ★★★ unit] (W-RW13, W-RW21)                       └── [PLANNED ★★ e2e] campus baseline (C28) [→E2E]
  ├── per-hall colour ranges, setHallTint/setAisleTint         [+] Zoom toward a hall
  │     [PLANNED ★★★ unit] shared materials (W-RW6)              ├── [PLANNED ★★★] panel appears at 12 px, fades within ~200 ms (W-RW24, E27) [→E2E]
  ├── clip plane cut/uncut [PLANNED ★★★ unit + e2e] (W-RW14)     └── [PLANNED ★★★ unit] pose sweep 12-85 deg, 45 deg azimuths, both projections
  └── draw budget <= 4 [PLANNED ★★ unit + e2e] (C24)          [+] Rotate behind a hall
[+] hall/signAtlas.ts                                            └── [PLANNED ★★ unit] panel hidden when facing away (W-RW24; billboard in chunk 18)
  ├── font wait: before / after first frame / timeout          [+] Double-click a road
  │     [PLANNED ★★★ unit, fake document.fonts] (W-RW29)         └── [PLANNED ★★ e2e] glides home (W-RW35)
  ├── setSign: long / empty / bad slot [PLANNED ★★★] (W-RW33)  [+] Dev menu (dev=1)
  └── null 2D context -> SignAtlasError [PLANNED ★★ unit]        ├── [PLANNED ★★★] each setter clamps bad input (W-RW31)
[+] materials.ts helpers                                         └── [PLANNED ★★ e2e] sections and setRoofCut (WD14)
  ├── instance fade patch [PLANNED ★★ unit + e2e] (E27)        [+] Reduced motion on
  ├── emissive ladder + bloom-off x1.5 [PLANNED ★★★] (WD2, WD4)  └── [PLANNED ★★★] LEDs steady 0.8, fans 25%, vapour 30%, packets 25% [→E2E]
  └── site palette hue test [PLANNED ★★] (WD10)                [+] Error states
[+] hall/slots.ts [PLANNED ★★★ unit] (W-RW9)                     ├── [PLANNED ★★ unit] build errors reach the C23 card
[+] scene/fake.ts + signals.ts + sim/rng.ts                      ├── [PLANNED ★★ unit] shader failure logged and counted (W-RW30)
  ├── same seed same values [PLANNED ★★★]                        └── [PLANNED ★★ unit] font timeout warns once
  ├── closed form full at t = 0 [PLANNED ★★★] (E26)
  └── pulse 0.6-1.0, hero mix, reduced motion [PLANNED ★★★] (WD6, WD7)
[+] campus/layout.ts + waypoints.ts [PLANNED ★★★ unit] (W-RW1, W-RW9, WD1)
[+] camera rig setCampus + C25 home [PLANNED ★★★ unit] (W-RW27, W-RW32)
[+] plant/vapour.ts: sort, luminance, life fade [PLANNED ★★★ unit] (W-RW18, E27)
[+] fibre/route.ts: door side, no footprint, dispose [PLANNED ★★★ unit + e2e] (W-RW11)

EXISTING TESTS THAT CHANGE (regression contract, approved by W-RW38 and C17)
  src/scene/camera.test.ts, src/scene/controls.test.ts  — bounds from a fixture instead of the constant
  e2e/camera.spec.ts:121, :185-187, :240              — home and startup move to the C25 contract
  e2e/lookdev.spec.ts baseline                          — updated in each chunk PR (C17)
  src/scene/materials.test.ts                           — glow-above-threshold stays; ladder and palette added
  src/app/params.test.ts                                — new view values

COVERAGE (planned): 27/27 proposed paths have a planned test; 0 gaps after the three proofs added below.
QUALITY (planned): ★★★: 18  ★★: 9  ★: 0  |  E2E-marked: 4  |  EVAL: none (no LLM scope)
```

Findings:
- T-1 [P2] (confidence: 8/10) docs/PLAN.md:509 — "Static hall costs 4 or fewer scene draw calls" had no method. Required proof of approved C24, added without a question: unit count of meshes and shadow casters, plus a `view=hall` HUD e2e.
- T-2 [P2] (confidence: 8/10) E26 (D2) — the closed form must be full at scene time 0. Required proof, added: unit tests on vapour counts at duty 0 and 1 and on packet spacing at t = 0.
- T-3 [P3] (confidence: 7/10) docs/PLAN.md chunk 08 Acceptance — "Total scene draw calls under 40" had no reader. Added: an e2e reads `__sceneDev.stats()` at frozen `home`.
- Regression rule: camera bounds, home and startup behaviour are at risk; W-RW38 already approved the contract (update the three assertions to C25, never delete). Carried, no new question.
- Value cards are in the test plan artifact; tests made obsolete: none (the three camera e2e assertions are rewritten, not retired).

Dispositions: T-1, T-2, T-3 accepted as required proof of approved behaviour (C24, E26, W-RW2); no new choice.

Test plan artifact: written to `~/.gstack/projects/bjorkgard-ai-center/` (path in the completion summary).

### 4. Performance review (eng, Phase 3)

Findings, most severe first:
- E-P1 [P2] (confidence: 8/10) docs/PLAN.md:509 — "Low poly, merged geometry for static parts" with no number, and :789 chunk 36's budget test without values. Resolved by E28 (D4).
- E-P2 [P3] (confidence: 7/10) `node_modules/three/src/renderers/webgl/WebGLShadowMap.js:86` — `this.autoUpdate = true;`: the shadow map re-renders every frame, also in 30 fps calm mode, although most casters never move in Phase 3 (fans and later vehicles do). Offered as a TODO below; chunk 36 owns quality and cost knobs.
- E-P3 [P3] (confidence: 6/10) Medium confidence, verify this is actually an issue: CI's headless Chromium and Firefox render on software WebGL (CEO S-RW30); the campus in `view=home` makes every CI spec that opens `home` heavier. The chunk 08 PR records the CI job durations before and after; no change now.
- Memory: fixed instance capacities (16 racks, 208 LEDs per hall, 60 vapour per tower, 12 packets per line) and one atlas (at most 2048 x 1024, CEO P-2) bound every buffer; no per-frame allocation (E26 closed form). Slow paths stay event-driven (startup merge, fibre rebuild, vapour sort on camera change).

Dispositions: E-P1 accepted (D4, E28); E-P2 to the TODO choice; E-P3 no change (verification note).

### Decision ledger (eng, Phase 3)

#### E26: Particle and packet state model
Finding: E-A1, [P1], confidence 9/10, `src/scene/loop/driver.ts:101-104` (`if (hasRendered && !freeze) { sceneSeconds += ... }`, so scene time stays 0 under `freeze=1`) with docs/PLAN.md:565 (vapour "grow from 1.2 to 2.4 units over a 6 s life") and C28; reviewer Claude.
Plan baseline: W-RW7 and W-RW16 (approved): every moving value comes from `fake.ts` as a function of scene time and `seed`, frozen under `freeze=1`; WD9 (design D14) vapour values; WD8 (design D13) packet values. The state model is unspecified.
Runtime evidence: scene time is 0 for every frozen shot and baseline (driver code above). A particle system that starts emitting at scene time 0 has no vapour at 0, and packets launched at 0 sit bunched at line starts, so the C28 hero baseline and the `view=cooling` and `view=power` shots would show neither. No Phase 3 code exists yet.
Comparison grid:

| Choice | Current | A | B | C |
|---|---|---|---|---|
| E26 particle and packet state | unspecified; emission from scene time 0 leaves frozen shots empty | closed form of time and seed: vapour particle i has age (t + offset_i) mod 6 s and shows when i < 60 x duty; packet j has phase (2.5 t + 1.2 j) mod line length for j below the rate cap | simulated per frame, pre-rolled one 6 s lifetime at start and before every frozen render | unchanged |
| Duty or rate ramp | unspecified | an index switches on or off at its next birth, so a ramp lags up to one 6 s life | new particles follow the new rate at once | unspecified |
| Determinism (W-RW7, W-RW16, approved) | required | met by construction | met with a fixed pre-roll step | not met for hero content at scene time 0 |
| WD8, WD9 values (approved) | approved | unchanged | unchanged | unchanged |
| E27 opacity mechanism | pending | pending | pending | pending |
| E28 triangle budgets | pending | pending | pending | pending |

Question D2:
D2 — E26: How should vapour particles and packets keep their state, so frozen shots show them? Project: Synapse Horizon, branch phase-3-world-building, eng review of Phase 3. ELI10: Every screenshot and the campus baseline are taken with scene time frozen at 0 (driver.ts:101-104). A normal particle system starts empty and emits over time, so at time 0 the towers have no vapour and packets are bunched at the start of each line. The approved plan wants the hero to look like the mockup, with plumes and flowing packets, and every value to be a pure function of time and seed. Stakes if we pick wrong: the README hero and baselines show dead towers and clumped packets, or the simulation is harder to make repeatable. Recommendation: A because a closed-form state is full at any time, repeatable by construction and allocates nothing per frame, which matches the engineering preference for explicit over clever. Completeness: A=9/10, B=8/10, C=3/10. Net: A is simplest and always full; B allows richer motion at the cost of a pre-roll; C leaves the hero empty.
Header: Particle state
Options:
A) Closed form in time (recommended)
Vapour particle i has age (t + offset_i) mod 6 s and shows when i < 60 x duty; packet j has phase (2.5 t + 1.2 j) mod line length; seeded offsets. Effort S (human ~2h / CC ~10 min), risk low, nothing to maintain per frame. ✅ Full plumes and spread packets at scene time 0, so frozen shots and the baseline match the mockup. ✅ Repeatable by construction and no per-frame allocation. ❌ A duty or rate change takes effect as particles are reborn, lagging up to one 6 s life.
B) Simulate with pre-roll
A per-frame particle and packet simulation, pre-rolled one 6 s lifetime at start and before each frozen render with a fixed step. Effort M (human ~4h / CC ~20 min), risk medium, maintenance medium. ✅ Ramps react at once, and richer motion such as gusts is possible later. ✅ Familiar particle-system model. ❌ Pre-roll steps at start and on every frozen render, and repeatability depends on the fixed step.
C) Leave unspecified
Implementer picks a model; frozen shots may show empty towers. Effort S, zero now, risk high. ✅ No design work in this review. ✅ Leaves room for any library later. ❌ The C28 hero baseline and README shots would show no vapour and clumped packets.

State: approved
Actual answer: A "Closed form in time (recommended)", D2, 2026-10-14
Accepted scope: vapour particles and packets are closed-form functions of scene time and seed (vapour particle i: age (t + offset_i) mod 6 s, shown when i < 60 x duty; packet j: phase (2.5 t + 1.2 j) mod line length, below the rate cap); a duty or rate change takes effect as indices are reborn (lag up to one 6 s life); applied to chunks 09 and 10; E27 and E28 stay pending
History: none

#### E27: Per-instance fade mechanism (sign panels, slot numbers, vapour)
Finding: E-Q1, [P2], confidence 8/10, docs/PLAN.md:490 ("shared instances only (no per-mesh materials)"), :514 (panel 200 ms fade), :553 (slot number visibility), E26 (vapour rebirth); reviewer Claude.
Plan baseline: 04c shared-material rule (approved, CEO C22 split); D7 200 ms fade (approved) applied to panels by W-RW24 and design D8; WD9 vapour opacity 0.35 (design D14); E26 closed-form vapour (D2). C24 counts one sign draw per hall. No fade mechanism is specified.
Runtime evidence: `src/scene/materials.ts` builds shared `MeshStandardMaterial` instances only and has no per-instance opacity; three's built-in materials cannot fade one instance of an InstancedMesh [Layer 1, search above]. No Phase 3 code exists yet.
Comparison grid:

| Choice | Current | A | B | C |
|---|---|---|---|---|
| E27 fade mechanism | none | one shared helper in `materials.ts` adds a per-instance `instanceOpacity` attribute (and, for atlas text, a per-instance UV rectangle) to library materials through `onBeforeCompile`, with a fixed `customProgramCacheKey` | a material clone per sign panel and pad number, plus a custom `ShaderMaterial` for vapour | no fades |
| Sign panels and pad numbers | one mesh per hall (C24) | one InstancedMesh for all panels and one for all pad numbers, atlas region per instance | one mesh and one material per panel or number | one mesh per hall, switched instantly |
| 04c shared-material rule (approved) | required | kept | broken for signs and numbers | kept |
| D7 200 ms fade (approved) | required | kept | kept | broken |
| Vapour life fade | unspecified | in over 0.5 s, out over the last 1.5 s of each 6 s life [estimated] | in the custom shader | size only; particles pop at rebirth |
| C24 per-hall bar (approved) | at most 4 | met (panels share one instanced draw) | met | met |
| E26 (approved) | closed form | unchanged | unchanged | unchanged |
| E28 triangle budgets | pending | pending | pending | pending |

Question D3:
D3 — E27: How do sign panels, slot numbers and vapour particles fade one at a time while sharing materials? Project: Synapse Horizon, branch phase-3-world-building, eng review of Phase 3. ELI10: Approved rules say signs fade over 200 ms when they become too small or turn away (D7), every mesh uses shared library materials (04c), and vapour particles restart in place (D2), so they need to fade in and out or they pop. A shared material has one opacity for everything that uses it, and three's built-in materials can't fade a single instance. Three callers need the same small trick. Stakes if we pick wrong: signs and particles pop, or the shared-material rule breaks and the dispose guard stops covering sign materials. Recommendation: A because one tested helper serves all three callers, keeps the shared-material rule, and even merges every sign panel into a single draw, which fits the engineering preference for shared code with real callers. Completeness: A=9/10, B=7/10, C=4/10. Net: A adds one shader patch; B adds many materials and a custom shader; C drops the fades.
Header: Fade method
Options:
A) Shared instance-opacity patch (recommended)
One helper in materials.ts adds per-instance opacity (and an atlas UV rect for text) to library materials via onBeforeCompile; panels and pad numbers become one InstancedMesh each; vapour fades in 0.5 s, out 1.5 s. Effort M (human ~4h / CC ~20 min), risk medium (tied to three's shader chunk names), maintenance low. ✅ Keeps the 04c shared-material rule and D7's 200 ms fade for every caller. ✅ All sign panels draw in one call, under C24's per-hall budget. ❌ The patch depends on three's shader chunk names, so a three upgrade must rerun the e2e fade checks.
B) Clones plus vapour shader
A material clone per sign panel and pad number; a custom ShaderMaterial for vapour. Effort M (human ~4h / CC ~20 min), risk low, maintenance medium. ✅ Plain material.opacity fades with no shader patching for signs. ✅ Full control of the vapour look in its own shader. ❌ Breaks the 04c shared-material rule for signs, and the dispose guard must track every clone.
C) No fades
Signs and numbers switch instantly; vapour fades by size only. Effort S, zero extra, risk medium. ✅ Nothing to build beyond visibility toggles. ✅ No shader code anywhere. ❌ Breaks D7's 200 ms fade, and vapour particles visibly pop as they restart.

State: approved
Actual answer: A "Shared instance-opacity patch (recommended)", D3, 2026-10-14
Accepted scope: one helper in `src/scene/materials.ts` adds a per-instance `instanceOpacity` attribute and, for atlas text, a per-instance UV rectangle to library materials through `onBeforeCompile` with a fixed `customProgramCacheKey`; sign panels (all halls) and slot-pad numbers each become one InstancedMesh using it; vapour fades in over 0.5 s and out over the last 1.5 s of each 6 s life [estimated]; tests: a unit test feeds the helper a stand-in shader and asserts the injected attribute and opacity multiply, and e2e checks a panel's opacity goes from 1 to 0 within about 200 ms after zooming out; applied to the Phase 3 heading and chunks 06, 08 and 09; E28 stays pending
History: none

#### E28: Triangle budgets
Finding: E-P1, [P2], confidence 8/10, docs/PLAN.md:509 ("Low poly, merged geometry for static parts", no number) and :789 (chunk 36 "Draw-call and triangle budgets enforced by a test", no values); handed over by the Phase 3 design review's outside voice (finding 12); reviewer Claude.
Plan baseline: Phase 3 sets draw-call bars (C24, chunk 08 under 40) but no triangle numbers; chunk 36 (approved) enforces "draw-call and triangle budgets" in CI without values.
Runtime evidence: the perf HUD already shows triangles (`src/scene/hud.ts:21`); no Phase 3 geometry exists. Estimated full 12-hall campus at the WD values: about 110k triangles (halls 24k, LEDs 30k, fibre tubes 23k, trees 9k, packets 7k, cars 5k, rest under 12k) [estimated].
Comparison grid:

| Choice | Current | A | B | C |
|---|---|---|---|---|
| E28 per-part caps | none | unit tests count each builder's triangles: hall body <= 2,000; rack <= 12; LED <= 12; tower <= 600; chiller <= 200; fan <= 64; tree <= 60; car <= 120; lamp <= 60; fence bay <= 24; gate <= 400; dock <= 600; monument <= 100; vapour quad 2; packet <= 48; fibre tube <= 12 per 0.25 units [estimated] | none | none |
| E28 campus total | none | e2e reads HUD triangles at 12 placed halls, frozen: <= 150k [estimated] | same e2e total, <= 150k | none until chunk 36 |
| Chunk 36 CI budget (approved) | values unset | starts from these numbers | starts from the total | sets its own |
| E26, E27 (approved) | approved | unchanged | unchanged | unchanged |

Question D4:
D4 — E28: Should Phase 3 set triangle budgets now? Project: Synapse Horizon, branch phase-3-world-building, eng review of Phase 3. ELI10: Every mesh is made of triangles, and the GPU pays for each one. The plan says "low poly" but gives no numbers; chunk 36 will add a CI test with triangle budgets later, also without numbers. The campus is built now, so now is when a 2,000-triangle tree copied 150 times would slip in. Estimated, the full 12-hall campus needs about 110k triangles. Stakes if we pick wrong: a heavy part lands unnoticed and chunk 36 finds it on the M1 Air, or we add tests that pin numbers too early. Recommendation: A because per-part caps catch the one heavy part at the chunk that adds it, cost one count per builder test, and hand chunk 36 its numbers. Completeness: A=9/10, B=7/10, C=4/10. Net: A guards each part now; B guards only the total; C waits for chunk 36.
Header: Triangle budget
Options:
A) Per-part caps and a total (recommended)
Unit tests count each builder's triangles against caps (hall body 2,000, tower 600, tree 60, car 120 and so on), plus an e2e total of 150k or less at 12 placed halls [estimated]. Effort S (human ~2h / CC ~10 min), risk low, maintenance low. ✅ A heavy part fails the test in the chunk PR that adds it. ✅ Chunk 36 starts from written, measured numbers. ❌ Caps are estimates now and may need one raise when a part's look is tuned.
B) Campus total only
One e2e reads HUD triangles at 12 placed halls, 150k or less [estimated]. Effort S (human ~1h / CC ~5 min), risk medium, maintenance low. ✅ One number to maintain, no per-part tuning. ✅ Still catches a large regression across the whole campus. ❌ A heavy part hides inside the total until it is large, and the failure does not say which part.
C) Leave to chunk 36
No triangle checks in Phase 3; chunk 36 sets budgets later. Effort S, zero now, risk medium. ✅ No numbers to guess before the look is final. ✅ Nothing to update while parts are tuned. ❌ Heavy parts can land in chunks 06-10 and surface only on the M1 Air in chunk 36.

State: approved
Actual answer: A "Per-part caps and a total (recommended)", D4, 2026-10-14
Accepted scope: unit tests count each builder's triangles against per-part caps (hall body 2,000; rack 12; LED 12; tower 600; chiller 200; fan 64; tree 60; car 120; lamp 60; fence bay 24; gate 400; dock 600; monument 100; vapour quad 2; packet 48; fibre tube 12 per 0.25 units) [estimated], each part's test landing in the chunk that adds it; an e2e reads HUD triangles at 12 placed halls, frozen, 150k or less [estimated]; chunk 36's CI budget starts from these numbers; applied to the Phase 3 heading and chunk 36
History: none

#### E29: TODO, static shadow caching
Finding: E-P2, [P3], confidence 7/10, `node_modules/three/src/renderers/webgl/WebGLShadowMap.js:86` (`this.autoUpdate = true;`); reviewer Claude.
Plan baseline: no Phase 3 or chunk 36 item covers shadow-map update frequency; C16 calm mode (approved) caps an idle tab at 30 fps; C29 (deferred) fits the shadow camera to the view.
Runtime evidence: three re-renders the shadow map on every rendered frame by default; in Phase 3 most casters never move (halls, racks, plant bodies, trees), while fans rotate and later chunks add vehicles. GPU cost on the M1 Air is unmeasured [unknown until chunk 36].
Comparison grid:

| Choice | Current | A | B | C |
|---|---|---|---|---|
| E29 shadow update frequency | every frame | unchanged now; P3 TODO: render the shadow map only when a caster moves or the light changes (`autoUpdate = false`, `needsUpdate` on change), with moving parts excluded from casting or flagging updates; trigger chunk 36 or a GPU-bound calm mode | unchanged; recorded in NOT in scope | built in Phase 3 (chunk 08) |
| C16 calm mode, C29 (approved, deferred) | as approved | unchanged | unchanged | unchanged |
| E26, E27, E28 (approved) | approved | unchanged | unchanged | unchanged |

Question D5:
D5 — E29: Should "render shadows only when something moves" go on the TODO list? Project: Synapse Horizon, branch phase-3-world-building, eng review of Phase 3. ELI10: The sun-shadow picture is redrawn every frame, even in the calm 30 fps mode, although almost nothing that casts a shadow moves on the campus. Drawing it only when a hall, fan or vehicle moves would save GPU work on a tab left open all day. It needs care: anything that moves must say so, or its shadow freezes in place. Nobody has measured whether it matters on the target laptop yet. Stakes if we pick wrong: wasted GPU on all-day tabs, or stale shadows from a missed update. Recommendation: A because the saving is real but unmeasured, and chunk 36's M1 Air runs are where it can be proven; writing it down costs nothing now. Note: options differ in kind, not coverage — no completeness score. Net: A remembers it for chunk 36; B drops it; C builds it before anyone measures.
Header: Shadow TODO
Options:
A) Add to TODOS.md (recommended)
P3 item: render the shadow map only when a caster moves or the light changes; moving parts excluded or flagging updates; trigger chunk 36 or a GPU-bound calm mode. Effort S now (human ~3h / CC ~15 min later), risk low now. ✅ The saving is written down next to the measurements that can prove it. ✅ No stale-shadow risk enters Phase 3. ❌ An idle tab keeps redrawing shadows until chunk 36 or later.
B) Skip
Record it in NOT in scope; no TODO. Effort S, zero. ✅ Keeps the TODO list to items with a measured need. ✅ Shadows always stay correct by construction. ❌ The idea is easy to lose if calm-mode GPU use turns out high.
C) Build it now in Phase 3
Add shadow caching in chunk 08 with update flags on moving parts. Effort M (human ~3h / CC ~15 min), risk medium. ✅ Saves GPU from the first campus build. ✅ Forces every moving part to declare itself early. ❌ Unmeasured gain, and a missed flag freezes a shadow in a scene still being built.

State: approved
Actual answer: A "Add to TODOS.md (recommended)", D5, 2026-10-14
Accepted scope: P3 TODO added to `TODOS.md` (static shadow caching; trigger chunk 36 or a GPU-bound calm mode); no Phase 3 chunk text changed
History: none

Approval readiness: PASS. Checked rows and answers: E26 (D2, A), E27 (D3, A), E28 (D4, A), E29 (D5, A, TODO only); structure D1 (B) is the scope record, not a remedy. Required proofs added in Section 3 (T-1 to T-3) follow approved C24, E26 and W-RW2 without new choices. No pending rows.

### Reality rows (eng, Phase 3)

- REALITY: premise-table finding unverified=2 (M1 Air GPU cost of the per-frame shadow pass; triangle caps and the 110k campus estimate) docs/PLAN.md:509
- REALITY: already-done pass `git log origin/main -- src/scene/hall src/scene/campus src/scene/plant src/scene/network src/scene/fibre src/scene/fake.ts src/scene/signals.ts src/sim` shows only `f72dee8` (scaffold `.gitkeep`) docs/PLAN.md:501
- REALITY: surface-check pass `renderer.debug.onShaderError` exists (`node_modules/three/src/renderers/WebGLRenderer.js:169-195`); `mergeGeometries` exists (`BufferGeometryUtils.js:133`); scene time handling verified (`src/scene/loop/driver.ts:101-104`); `vp test` and Playwright projects exist (`package.json:16-18`, `playwright.config.ts:19-49`) docs/PLAN.md:472
- REALITY: binding-decisions pass C16, C24-C29, W-RW1-W-RW40, design D3-D20 (WD1-WD14, WD11b), E19, E20 honoured; `gstack-decision-search --scope branch --recent 50` lists the Phase 3 CEO and design decisions only docs/PLAN.md:503
- REALITY: numbers finding triangle caps and the 150k total are [estimated]; 44 test files [measured: `git ls-files`]; file counts [estimated] docs/PLAN.md:509
- REALITY: deferred-asks pass two TODOs recorded (C29 view-fitted shadows, E29 static shadow caching); no linked issue TODOS.md:1
- REALITY: pr-count pass no `.gstack/ship-policy.json`; five chunk PRs (06-10) plus one review docs PR (D18) docs/PLAN.md:31

`PLAN_REALITY: phase=eng rows=7/7 missing=none unverified=2 verdict=complete` (checked on this record alone).

### NOT in scope (eng, Phase 3)

- Static shadow caching: deferred to `TODOS.md` (E29, D5); unmeasured until chunk 36.
- View-fitted shadow camera: deferred by the CEO review (C29).
- A 12-hall churn leak test: chunk 20 owns it; Phase 3 checks one slot (chunk 10).
- The shared cut plane during chunk 20's rise and sink: chunk 20.
- CI time limits for software WebGL: recorded per PR (E-P3), no new budget.

### What already exists (eng, Phase 3)

The CEO record's 0B table holds the reuse map (look-dev hall and racks, material library and dispose guard, `mergeGeometries`, ground, rig, camera bounds and home fit, `isEmptyGround`, dev HUD and `__sceneDev`, draw-call split, parameter allowlist, shots config, look-dev baseline project). This review adds one shared helper (E27 instance fade, three proposed callers: sign panels, pad numbers, vapour); nothing existing is rebuilt.

### Failure modes (eng, Phase 3)

| New path | Realistic failure | Test or handling | User sees |
|---|---|---|---|
| Closed-form vapour and packets (E26) | state empty or clumped at scene time 0 | unit tests at t = 0 (T-2); baseline | full plumes and spread packets |
| Instance fade patch (E27) | a three upgrade renames shader chunks, patch stops applying | e2e fade check; W-RW30 logs compile failures | signs pop instead of fading, logged |
| Triangle caps (E28) | a part ships far heavier than planned | unit cap per builder, 150k e2e | nothing; the PR fails |
| Ready signal with atlas (W-RW29) | font never loads | 3 s timeout, warning, unit test | signs in a fallback font |
| HUD draw-call e2e (T-1, T-3) | an extra mesh or unplanned caster | e2e counts | nothing; the PR fails |

0 critical gaps (no path is untested, unhandled and silent).

### Worktree parallelization strategy (eng, Phase 3)

| Step | Modules touched | Depends on |
|---|---|---|
| 06 hall | `src/scene/hall`, `src/scene/materials.ts`, `src/scene/render.ts`, `src/scene/LookDev.tsx`, `src/app` | — |
| 07 racks | `src/scene/hall`, `src/scene/signals.ts`, `src/scene/fake.ts`, `src/sim`, `src/scene/PerfHud.tsx` | 06 |
| 08 campus | `src/scene/campus`, `src/scene/camera.ts`, `src/scene/Ground.tsx`, `src/scene/LightRig.tsx`, `e2e`, `playwright.config.ts` | 07 |
| 09 plant | `src/scene/plant`, `src/scene/materials.ts`, `src/scene/fake.ts`, `src/scene/PerfHud.tsx` | 08 |
| 10 network | `src/scene/network`, `src/scene/fibre`, `src/scene/materials.ts`, `src/scene/fake.ts`, `src/scene/PerfHud.tsx` | 08 |

Parallel lanes: Lane A: 06 → 07 → 08 (shared `hall/` and `fake.ts`, sequential). Then Lane B: 09 and Lane C: 10 in parallel worktrees (chunk 18 may join after 08 + 13, C26).
Execution order: run A to merge; launch B and C; merge whichever finishes first; the second rebases (W-RW39).
Conflict flags: `materials.ts`, `PerfHud.tsx`, `fake.ts`, `scripts/shots.config.ts`, `src/scene/LookDev.tsx` and the campus and look-dev baseline PNGs are shared by B and C; the later PR regenerates baselines and shots, never hand-merging images.

## Implementation Tasks (eng review, Phase 3)

Synthesized from this review's findings; they extend the CEO tasks T1-T12 and the design tasks T1-T12. Effort ratios assumed: features ~30x, tests ~50x.

- [ ] **T1 (P1, human: ~2h / CC: ~10min)** — fake signals — Closed-form vapour and packet state, full at scene time 0
  - Surfaced by: Architecture — E-A1, E26 (D2)
  - Files: `src/scene/fake.ts`, `src/scene/fake.test.ts`, `src/scene/plant/vapour.ts`, `src/scene/fibre/route.ts`
  - Verify: unit tests: 60 visible particles per tower at duty 1 and t = 0, none at duty 0; packets spread at the cap at t = 0; same seed same values
- [ ] **T2 (P1, human: ~4h / CC: ~20min)** — materials — Shared instance-fade helper; instanced sign panels and pad numbers; vapour life fade
  - Surfaced by: Code quality — E-Q1, E27 (D3)
  - Files: `src/scene/materials.ts`, `src/scene/materials.test.ts`, `src/scene/hall/Hall.tsx`, `src/scene/campus/Campus.tsx`, `src/scene/plant/Plant.tsx`
  - Verify: unit test on a stand-in shader (attribute injected, opacity multiplied, fixed program cache key); e2e: a panel fades from 1 to 0 within about 200 ms after zooming out
- [ ] **T3 (P2, human: ~2h / CC: ~10min)** — budgets — Per-part triangle caps and a 150k campus total
  - Surfaced by: Performance — E-P1, E28 (D4)
  - Files: builder test files per chunk, one e2e spec at 12 placed halls
  - Verify: `vp test` fails if a builder exceeds its cap; e2e reads 150k triangles or less at 12 placed halls, frozen
- [x] **T4 (P2, human: ~2h / CC: ~10min)** — tests — Draw-call proofs for C24 and chunk 08
  - Surfaced by: Test review — T-1, T-3
  - Files: `src/scene/hall/buildHall.test.ts`, an e2e spec reading `__sceneDev.stats()`
  - Verify: unit count of meshes and casters per hall at most 4; e2e under 40 at frozen `home`
- [ ] **T5 (P3, human: ~15min / CC: ~5min)** — CI — Record CI job durations before and after chunk 08
  - Surfaced by: Performance — E-P3
  - Files: chunk 08 PR description
  - Verify: the PR lists both durations for the Chromium and Firefox jobs

### Unresolved decisions (eng, Phase 3)

None.

### Completion summary (eng, Phase 3)

- Step 0: Scope Challenge — scope accepted as-is (D1: smaller arrangement, same features)
- Reality rows: 7/7 applicable rows emitted (`PLAN_REALITY: phase=eng rows=7/7`), 2 unverified premises
- Architecture Review: 2 issues found (E-A1 resolved by E26; E-A2 no change)
- Code Quality Review: 3 issues found (E-Q1 resolved by E27; E-Q2, E-Q3 guidance)
- Test Review: diagram produced, 3 gaps identified (T-1 to T-3, closed as required proof)
- Performance Review: 3 issues found (E-P1 resolved by E28; E-P2 TODO; E-P3 note)
- NOT in scope: written
- What already exists: written
- TODOS.md updates: 1 item proposed to user (E29, added)
- Failure modes: 0 critical gaps flagged
- Unresolved decisions: 0 in this review
- Outside voice: codex, disabled (`codex_reviews` config); no native replacement
- Parallelization: 3 lanes, 2 parallel / 1 sequential
- Lake Score: 0/3 (D2, D3 and D4 were scored for completeness; none offered a 10/10 option)
- Test plan artifact: `~/.gstack/projects/bjorkgard-ai-center/nathanael-phase-3-world-building-eng-review-test-plan-20261014-135602.md`

### Suppressed findings (appendix, eng, Phase 3)

- (confidence: 4/10) Per-frame `SceneSignals` getter calls for about 2,500 LEDs could cost CPU; at this count a plain function call per instance is negligible [unverified], so not reported.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | ISSUES OPEN | 4 proposals, 4 accepted, 0 deferred (Phase 3, logged 2026-10-14T11:06:55Z; its UI-4 to UI-7 were settled by the design review) |
| Outside Review | codex via `/plan-ceo-review` and `/plan-eng-review`; Claude subagent via `/plan-design-review` | Independent 2nd opinion | 3 | disabled | `codex_reviews` disabled for the CEO and eng reviews; design phase: native Claude subagent completed (12 findings; native, not outside coverage) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | ISSUES OPEN | 11 issues, 0 critical gaps (this run: Phase 3, logged after this report) |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | ISSUES OPEN | score: 4/10 → 7/10, 17 decisions (Phase 3, logged 2026-10-14T11:48:17Z) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE COVERAGE:** codex, plan-review phase: disabled for the Phase 3 CEO review (2026-10-14T11:03:53Z) and eng review (this run); design phase: codex disabled, native Claude subagent completed with 12 findings (2026-10-14T11:19:21Z, `source: in-host`), not outside coverage.
- **VERDICT:** No review is CLEAR. Eng Review ISSUES OPEN means 11 mapped findings with 0 unresolved decisions and 0 critical gaps (all resolved by D1-D5 or recorded as guidance); Design Review ISSUES OPEN reflects its 7/10 AI-slop pass held by the accepted neon-glass look.

**UNRESOLVED DECISIONS:**
- + 4 unresolved from prior reviews (the CEO log row's UI-4 to UI-7, settled by the design review after that row was written)
