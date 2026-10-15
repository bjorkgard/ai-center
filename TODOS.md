# TODOS

## Deferred

- **`vp run doctor` setup check** (deferred by /plan-ceo-review Q5 (X3), 2026-10-12, Phase 0 review)
  - What: `scripts/doctor.ts` run by `vp run doctor`. Checks Node matches the pin, Playwright Chromium/Firefox/WebKit are installed, and `gh auth status`; prints one fix line per miss and exits non-zero on any miss. `e2e:local` calls it first; CONTRIBUTING links it.
  - Why deferred: single contributor today, and Playwright already prints an install hint for missing browsers.
  - Trigger to pick up: a second contributor joins, or the first setup on a fresh machine.
  - Effort: S (human ~1h / CC ~5 min).

- **P2: Reconcile the plan with merged PRs #8 and #9** (added by /plan-eng-review E18, 2026-10-13, Phase 1 review)
  - What: decide whether #8 (Dependabot npm prefix `fix(deps)` to `build(deps)`, `b17f26e`) and #9 (`vp dev` host `127.0.0.1` to `localhost`, `dc8612a`) supersede CEO C8 and C2, then update chunk 01, the C8 ledger row and chunk 14's Host-gate text in `docs/PLAN.md` to match (or revert the code).
  - Why: under D19, `build(deps)` cuts no release, so runtime library fixes (`ws`, chokidar) would no longer reach the downloadable builds, which C8 was approved to prevent. Chunk 14's Vite plugin reuses the C6 Host gate, which serves only `Host: 127.0.0.1:<port>` and redirects `localhost`, while `vp dev` now serves `localhost:5173`.
  - Context: plan lines are chunk 01 Tasks and Acceptance (`docs/PLAN.md`, "fix(deps)" and "host to `127.0.0.1`"), the C8 row in the Phase 0 CEO ledger, and chunk 14 Tasks (Origin and Host checks). Start by asking whether runtime dependency bumps should release, then how the chunk 14 plugin should treat `localhost` under `vp dev`.
  - Trigger to pick up: before chunk 14 starts.
  - Effort: S (human ~1h / CC ~10 min).
  - Depends on: none.

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
