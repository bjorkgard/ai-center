# TODOS

## Deferred

- **`vp run doctor` setup check** (deferred by /plan-ceo-review Q5 (X3), 2026-10-12, Phase 0 review)
  - What: `scripts/doctor.ts` run by `vp run doctor`. Checks Node matches the pin, Playwright Chromium/Firefox/WebKit are installed, and `gh auth status`; prints one fix line per miss and exits non-zero on any miss. `e2e:local` calls it first; CONTRIBUTING links it.
  - Why deferred: single contributor today, and Playwright already prints an install hint for missing browsers.
  - Trigger to pick up: a second contributor joins, or the first setup on a fresh machine.
  - Effort: S (human ~1h / CC ~5 min).

- **P3: Startup quality probe** (deferred by /plan-ceo-review C18, 2026-10-13, Phase 2 review)
  - What: before the loader fades, render about 1 s of frames at the high tier, discard the shader-compile frames, pick high, medium or low, and remember the pick per browser in localStorage (try/catch); the 04a frame monitor (CEO S-RW5) keeps adjusting at runtime. Fake-clock unit tests: interval-to-tier mapping, compile frames ignored, blocked storage.
  - Why deferred: the stutter it prevents lasts about 2 s (the frame monitor's drop window) and has not been measured on target hardware; the probe also lengthens D10's loader, which is approved to end at the first frame.
  - Context: chunk 04a quality tier object and frame monitor, chunk 36 auto tiering, `docs/PLAN.md` "CEO review record: Phase 2", C18.
  - Trigger to pick up: chunk 36's M1 Air-class runs show a visible stutter in the first seconds after launch.
  - Effort: S (human ~2h / CC ~10 min).
  - Depends on: chunk 04a frame monitor.

- **P3: View-fitted shadow camera** (deferred by /plan-ceo-review C29, 2026-10-14, Phase 3 review)
  - What: fit the directional light's shadow camera to the visible ground area each time the camera moves, snapped to whole shadow-map texels so shadows do not shimmer, instead of one 2048 map stretched over the whole campus.
  - Why: with the campus-fitted map (chunk 08, CEO W-RW1), one shadow texel is about 0.03 world units over a campus of about 60 x 45 units [estimated], about 7 CSS px at the maximum zoom of 240 px per unit, so shadow edges look soft or blocky when zoomed close.
  - Pros: crisp shadows at every zoom for the same 2048 map. Cons: shadow camera updates on every camera move; texel snapping needed to avoid shimmer; casters outside the view must still be included so off-screen objects do not lose their shadows.
  - Context: `src/scene/LightRig.tsx` (shadow camera extent), `src/scene/camera.ts` (zoom range), chunk 36 auto quality tiering, `docs/PLAN.md` "CEO review record: Phase 3", Section 7 P-1 and C29.
  - Effort: human S / CC S (human ~3h / CC ~15 min).
  - Priority: P3.
  - Trigger to pick up: chunk 36, or shadows look blocky at close zoom on the campus.
  - Depends on: chunk 08 campus layout and shadow fit.

- **P3: Static shadow caching** (deferred by /plan-eng-review E29, 2026-10-14, Phase 3 review)
  - What: render the directional light's shadow map only when a caster moves or the light changes (`renderer.shadowMap.autoUpdate = false`, set `needsUpdate` on change), with moving parts (fans, later vehicles) either excluded from casting or flagging an update.
  - Why: three re-renders the shadow map every rendered frame (`WebGLShadowMap.js:86`), also in C16's 30 fps calm mode, although most campus casters never move; an all-day tab spends GPU on identical shadows.
  - Pros: less GPU per frame, most in calm mode. Cons: a moving part that forgets to flag freezes its shadow; fan shadows stop turning unless fans stop casting; interacts with the view-fitted shadow TODO (C29), which needs an update on every camera move.
  - Context: `src/scene/LightRig.tsx`, `src/scene/render.ts` (quality tiers), chunk 36 auto tiering, `docs/PLAN.md` "Eng review record: Phase 3", E29.
  - Effort: human S / CC S (human ~3h / CC ~15 min).
  - Priority: P3.
  - Trigger to pick up: chunk 36's M1 Air runs show calm mode GPU-bound or the shadow pass dominating frame time.
  - Depends on: chunk 08 campus and chunk 36 measurements.

- **P3: Store-backed rack count before chunk 18** (deferred by /plan-ceo-review C31, 2026-10-15, chunk 11 review)
  - What: with `source=mock`, a store-backed `rackCount(hall)` in `SceneSignals` for halls A and B, counted from the mock's live main sessions; LEDs, duty and packets stay on `src/scene/fake.ts`.
  - Why deferred: chunk 18 owns the store-backed `SceneSignals`, its render-count test (eng G11) and leak checks, and mapping projects to halls needs the chunk 19 reconciler, so an early version would be rewritten.
  - Context: `src/scene/sceneSignals.ts` (the one place that picks the signal implementation), `src/scene/signals.ts`, chunk 11 data slice, `docs/PLAN.md` "CEO review record: Chunk 11", C31.
  - Trigger to pick up: chunk 18 starts, or a demo needs the campus to react to mock data before then.
  - Effort: M (human ~3h / CC ~20 min).
  - Depends on: chunk 11 data slice.

- **P2: Bound the growth of `done` sessions in the store** (deferred by /autoplan chunk 12 review, 2026-10-15)
  - Scheduled: accepted into chunk 13 (/autoplan 2026-10-15, CEO X1 / pass-2 1.1).
  - What: evict or compact sessions and subagents whose status is `done` from the `sessions`/`subagents` maps after they leave the ring buffer, keeping project and global token totals unchanged.
  - Why: churn and burst add a new session id per cycle (up to 18,000 per real hour at 60x [estimated]), and `applyBatch` copies both maps on every batch (`src/data/reduce.ts`), so a long-running 60x tab slows down.
  - Context: chunk 12 scenarios, chunk 13 session-end inference (30 min idle), `docs/PLAN.md` chunk 12 review record, CEO row 21.
  - Trigger to pick up: chunk 13 lands session-end inference, or an all-day mock tab shows slow batches.
  - Effort: S (human ~2h / CC ~10 min).
  - Depends on: chunk 13.

- **P2: Re-check `waiting` and `churn` after chunk 13 inference** (deferred by /autoplan chunk 12 eng review, 2026-10-15)
  - Scheduled: accepted into chunk 13 (/autoplan 2026-10-15, CEO X1 / pass-2 1.1).
  - What: re-run the chunk 12 `waiting` and `churn` shape tests with session-end inference on; give waiting lanes a non-status heartbeat if 30-minute idle-end marks them `done` (about 2,390 sim s).
  - Why: chunk 13 inference can silently end the states these scenarios exist to show.
  - Context: `src/data/mock.ts` lane plans, chunk 13 Tasks, chunk 12 eng review finding 10.
  - Trigger to pick up: chunk 13 implementation.
  - Effort: S (human ~1h / CC ~5 min).
  - Depends on: chunk 12, chunk 13.

- **P3: Remove or keep-as-debug the interim dev clock controls** (deferred by /autoplan chunk 12 review, 2026-10-15)
  - What: when chunk 27 builds the D8 mode chip and replay bar, remove the dev Data section's scenario select, play/pause and speed buttons, or keep them as dev-only debug that calls the same store actions.
  - Why: two control surfaces driving one clock confuse state and tests.
  - Context: `src/scene/DataSection.tsx`, chunk 12 TASTE decision 6, chunk 27 Tasks.
  - Trigger to pick up: chunk 27 starts.
  - Effort: S (human ~30 min / CC ~5 min).
  - Depends on: chunk 27.

- **P3: Seekable replay clock** (deferred by /autoplan chunk 12 CEO review X1, 2026-10-15)
  - What: `seek(simMs)` for mock and replay, implemented as reconnect at a new `startMs` with the store cleared, so no consumer ever sees time go back.
  - Why: the D8 replay bar has a sim-time scrubber; today it only shows time.
  - Context: `src/data/clock.ts` (chunk 12), chunk 17 file replay, chunk 27 replay bar.
  - Trigger to pick up: chunk 27 replay bar or chunk 17 wants scrubbing.
  - Effort: M (human ~3h / CC ~15 min).
  - Depends on: chunk 12 clock.

- **P3: `tour` demo scenario** (deferred by /autoplan chunk 12 CEO review X4, 2026-10-15)
  - What: one mock scenario that chains burst, overflow, errors and waiting on a timeline, for demos and the README.
  - Why: a single URL that shows every behaviour.
  - Context: chunk 12 scenario registry in `src/data/scenarios.ts` and `src/data/mock.ts`.
  - Trigger to pick up: a demo or README video needs one URL that shows everything.
  - Effort: S (human ~2h / CC ~10 min).
  - Depends on: chunk 12.

- **P3: npx package and install script for the app** (deferred by /autoplan chunks 13-14b CEO review X6, F8, 2026-10-15)
  - What: publish the CLI bundle to npm so `npx synapse-horizon` runs the app with the user's own Node, and add a one-line install script (or Homebrew tap) for the 14b binaries.
  - Why: most users already run Claude Code or Codex, so they have Node; npx avoids Gatekeeper and SmartScreen first-run friction of unsigned binaries.
  - Pros: lowest-friction install. Cons: an npm publish step (the npm plugin is refused under pnpm `devEngines`, so a separate publish job), and a second distribution channel to keep working.
  - Context: D19, chunk 14b, `scripts/bundle-cli.ts`, `docs/PLAN.md` chunks 13-14b CEO review record.
  - Effort: human M / CC S (human ~4h / CC ~20 min).
  - Trigger to pick up: after chunk 14b's first release, or the first user report of Gatekeeper/SmartScreen trouble.
  - Depends on: chunk 14b.

- **P3: OpenTelemetry ingest as a second live source** (deferred by /autoplan chunks 13-14b CEO review F2, 2026-10-15)
  - What: a small OTLP/HTTP receiver on the log server that turns Claude Code's OpenTelemetry metrics and events into `AgentEvent`s behind the same `Source` interface, next to JSONL tailing.
  - Why: JSONL formats are undocumented and can change without notice; a documented telemetry path means a format change degrades one source, not the product. Claude Code's OTel export is from vendor docs, not verified in this repo; Codex equivalent unknown.
  - Context: D3, chunks 14-16, `src/data/wire.ts`, `src/data/schema.ts`.
  - Effort: human L / CC M.
  - Trigger to pick up: the first JSONL format break in chunk 15 or 16, or a user who cannot share log folders.
  - Depends on: chunk 15.

- **P2: Consider a vertical slice after chunk 15** (deferred by /autoplan chunks 13-14b CEO review F9, 2026-10-15)
  - What: decide whether to build chunk 18 (store-to-scene binding) right after chunk 15, before 16 and 17, so real sessions light real racks early.
  - Why: the data-centre scene is the differentiator; token and cost dashboards are easy for other tools to match.
  - Context: `docs/PLAN.md` section 5 chunk order and dependencies (18 depends on 15 only through the store).
  - Effort: human S / CC S (planning only).
  - Trigger to pick up: chunk 15 merged.
  - Depends on: chunk 15.

- **P3: Retire the `logLines` slice when parsers land** (added by /autoplan chunks 13-14b CEO review Section 10, 2026-10-15)
  - Decided by /autoplan chunks 15-16 review (X1, 2026-10-15): keep the slice and repurpose it as per-file parser health (lines, events, ignored, unknown, malformed, oversize, newest version); this entry closes when chunk 15 merges.
  - What: remove the per-file line-count slice and its HUD row once chunk 15 streams `AgentEvent`s, or keep it as a dev-only diagnostic.
  - Why: two data paths from one server confuse tests and the HUD.
  - Context: chunk 14a pass-3 1.1 requirement, `src/data/wire.ts`.
  - Effort: human S / CC S.
  - Trigger to pick up: chunk 15.
  - Depends on: chunk 15.

- **P3: Backfill window flag and price overrides** (deferred by /autoplan chunks 13-14b DX review M9, 2026-10-15)
  - What: `--since <hours>` (env and config equivalents) to widen the 24 h backfill, and config-file price overrides keyed by model and token class, with `basis` naming "user override".
  - Why: a user whose last session was 25 h ago sees an empty campus; binary users keep the release's prices until the next release.
  - Context: chunk 13 price table (`asOf`), chunk 14a roots/config resolver, D4 (24 h backfill).
  - Effort: human S / CC S.
  - Trigger to pick up: first user report of an empty first run or stale prices.
  - Depends on: chunks 13, 14a.

- **P3: Session title for rack labels** (deferred by /autoplan chunks 15-16 CEO review X3, 2026-10-15)
  - What: a redacted `title?` field from Claude `custom-title`, `ai-title` and `agent-name` lines, so racks and panels can show a human name instead of a session id.
  - Why: a rack labelled "fix auth redirect" is recognisable at a glance; a uuid is not.
  - Context: chunk 15 ignores these line types (known-ignored list in `docs/log-formats/claude.md`); chunk 24 owns labels. Titles are user text, so they go through `redact` and the 120-character cut.
  - Effort: human S / CC S.
  - Trigger to pick up: chunk 24 starts.
  - Depends on: chunks 15, 24.

- **P3: Vendor cost cross-check from Claude `cost-state`** (deferred by /autoplan chunks 15-16 CEO spec review X6, 2026-10-15)
  - What: read `cost-state` lines (`totalCostUSD`, `modelUsage`) and compare them with the chunk 13 estimated cost; consider showing them as a `real` metric where present.
  - Why: a vendor-computed cost calibrates the price table and could replace an estimate with a fact.
  - Context: 189 `cost-state` lines in 204 Claude sessions on the author's Mac (2026-10-15); chunk 15 ignores the type.
  - Effort: human S / CC S.
  - Trigger to pick up: chunk 28 KPI cards.
  - Depends on: chunks 13, 15.

- **P2: Run `logs:probe` on other machines before 14b** (deferred by /autoplan chunks 15-16 CEO voice F5, X7, 2026-10-15)
  - What: collect `vp run logs:probe -- --json` output (keys and counts only) from 2-3 other machines and merge their type lists into the parsers' ignored lists and `TESTED_VERSIONS`.
  - Why: the format rules come from one machine (n=1); the public binary meets other setups.
  - Context: `docs/log-formats/*.md`, chunk 15 X2/DX10.
  - Effort: human S / CC S (needs other people).
  - Trigger to pick up: chunk 14b starts.
  - Depends on: chunk 15.

- **P3: Persist parser state per file** (deferred by /autoplan chunks 15-16 CEO voice F7, X8, 2026-10-15)
  - What: save parser state keyed by `fileId` and offset so a restart does not re-read 24 h of logs.
  - Why: startup time grows with log volume.
  - Context: C96 budget (15 s on the author's Mac, 186 MB measured on 2026-10-15); becomes P1 if the measured backfill exceeds it.
  - Effort: human M / CC S.
  - Trigger to pick up: measured backfill over 15 s.
  - Depends on: chunk 15.

- **P3: Option to hide prompt text** (deferred by /autoplan chunks 15-16 CEO voice F9, X9, TASTE T6, 2026-10-15)
  - What: `--no-task-text` (and env/config equivalents) so `currentTask` only shows plan items, never prompt text.
  - Why: prompts can hold names or internal URLs that pattern redaction misses.
  - Context: D16 (120-character redacted task text) stays the default.
  - Effort: human S / CC S.
  - Trigger to pick up: a user asks, or the binary ships to people other than the author.
  - Depends on: chunk 15.

- **P3: User-extendable toolClass patterns** (deferred by /autoplan chunks 15-16 DX review X10, TASTE T7, 2026-10-15)
  - What: a `toolClasses` config key that adds test and lint runner patterns to the built-in lists.
  - Why: custom runners (`make ci`, project scripts) show as `other`, so Evaluating never lights.
  - Context: `sidecar/parsers/toolClass.ts`, chunk 14a config file.
  - Effort: human S / CC S.
  - Trigger to pick up: first report of a missed runner.
  - Depends on: chunk 15.

- **P3: Monorepo sub-path to hall mapping** (deferred by /autoplan chunks 15-16 DX review X11, 2026-10-15)
  - What: config that maps a repository sub-path to its own hall (or merges two keys).
  - Why: a monorepo is one hall today (C81 uses the git root).
  - Context: `sidecar/sessionKeys.ts`, D5.
  - Effort: human S / CC S.
  - Trigger to pick up: a user asks.
  - Depends on: chunk 15.
