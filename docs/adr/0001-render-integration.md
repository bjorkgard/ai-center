# ADR 0001: Render integration, React Three Fiber or direct three.js

Status: decided. React Three Fiber, by the decision rule below applied to 48 measured passes (see Results and Decision). Chunk 03 of [docs/PLAN.md](../PLAN.md).

This file was first committed with the method and decision rule below and with empty results, before any measured run (CEO RW11). That commit has the subject `docs: add ADR 0001 render spike method and decision rule`. Find it with `git log --format='%H %cI %s' --grep='add ADR 0001 render spike method'`; the results commit records its SHA here, because a commit cannot contain its own SHA. Every result file's `startedAt` must be later than that commit's committer date.

## Context

About 30 scene chunks (04a to 37) will be built on one integration of three.js into the React app: React Three Fiber (R3F), or a plain `WebGLRenderer` driven from React effects. A wrong pick shows late, at chunk 20 (hall churn) or chunk 36 (performance), when switching means rewriting every scene file. The provisional pick in PLAN section 1 is R3F. This spike replaces that opinion with numbers and a rule written before measuring.

Two throwaway views draw the same scene: `?view=spike-r3f` and `?view=spike-vanilla`. Each shows 12 hall boxes, 192 instanced racks (12 halls x 16) and 3,072 instanced LEDs (16 per rack) at 1x load, with per-frame colour updates driven by a fake store at 10 updates per second. At 4x load (`&load=4`) there are 768 racks and 12,288 LEDs at the same draw-call count. Each hall owns its rack and LED `InstancedMesh` and its geometry; all halls share one set of materials. The views are deleted in chunk 04a; this ADR stays.

## Settings

Both views read one constant, `src/spike/shared/render.ts`, and pass it explicitly. No value is left to a library default, because the two entry points default differently (CEO RW1, eng E8).

| Setting | Value |
|---|---|
| Pixel ratio | `min(devicePixelRatio, 2)` |
| Renderer | `antialias: true`, `alpha: false`, `powerPreference: "high-performance"` |
| Output colour space | sRGB |
| Tone mapping, bloom off | ACES Filmic on the renderer |
| Tone mapping, bloom on | `ToneMappingEffect` in ACES Filmic mode as the last effect; the renderer is set to no tone mapping while the composer is active (R3F's composer does this itself, the vanilla view does the same) |
| Shadows | one directional light, shadow map 2048, type `PCFShadowMap`, set explicitly in the shared constant for both views (three 0.186 removed `PCFSoftShadowMap`) |
| Materials | `MeshStandardMaterial`, flat-shaded, shared by all halls |
| Bloom library | pmndrs `postprocessing` 6.39.5 (the vanilla view directly, the R3F view through `@react-three/postprocessing` 3.2.0) |
| Composer | `multisampling: 4`, `frameBufferType: HalfFloatType`, `depthBuffer: true`, `stencilBuffer: false` |
| Passes | `RenderPass`, then one `EffectPass` with `BloomEffect` and `ToneMappingEffect` |
| Bloom effect | blend function SCREEN, intensity 1.2, luminance threshold 0.6, luminance smoothing 0.2, mipmap blur on, radius 0.85, levels 8 (values estimated; identical values in both views are the requirement) |
| Versions | three 0.186.1, `@react-three/fiber` 9.8.1, `@react-three/postprocessing` 3.2.0, `postprocessing` 6.39.5, React 19.3 |

Same work per frame (RW8): every frame, both views write all live LED colours from the latest store snapshot with the same function and flag one upload per mesh. Spike code allocates nothing per frame, including the bench's sample storage, which is typed arrays sized up front.

Shared-material pattern (RW6): the three materials are created once outside JSX and passed to R3F meshes by the `material` prop. Per-hall geometries are JSX children (`<boxGeometry />`), which R3F disposes on unmount; the vanilla view disposes its own explicitly. The shared materials must receive 0 `dispose` events during churn; each pass counts them through three's `dispose` event on every shared material (eng E9).

## Method

**Bench pass.** `&bench=1` runs one scripted pass from a single `requestAnimationFrame` loop that drives both views through the same seam (`frame`, `addHalls`, `removeHalls`, `snapshot`; R3F runs with `frameloop="never"` and `advance(t)` inside `frame`):

1. Warm-up, 5 s.
2. Steady, 20 s. Samples: CPU time per frame (`performance.now()` around `frame(t)`, update plus render) and the wall-clock interval between callbacks.
3. Churn: 50 cycles. Each cycle adds 6 halls, waits until the view reports they are in the scene (`addHalls` resolves on mount, which under React can take more than one frame), renders one frame, then removes them (eng E16).
4. Settle, 1 s after the last removal, frames keep rendering. Then the counts are read again.

Phase durations and the 50 x 6 churn are estimates. The status line in the view shows the current phase, then done or invalid with its reason.

**Statistics.** Median, p95 and p99 use the nearest-rank method on the ascending sample: the value at rank `ceil(p/100 * n)`, 1-based, no interpolation. Empty input gives null. The churn hitch is the longest wall-clock interval between `requestAnimationFrame` callbacks during churn, so React work that runs between frames counts (eng E15). Frames per second is reported for reference only and decides nothing: Chrome and Firefox run `requestAnimationFrame` at up to 120 Hz on a ProMotion display while Safari stays near 60 by default (CEO RW2). GPU time is recorded only where `EXT_disjoint_timer_query_webgl2` exists, else `null`; JS heap only where `performance.memory` exists (Chromium), else `null`. Neither is ever 0.

**Counts.** `renderer.info.memory.geometries`, `renderer.info.memory.textures`, `renderer.info.programs.length`, the fake store's listener count and the shared-material dispose-event count are read before churn and after settle, because R3F disposes unmounted objects on idle (CEO RW3, RW9). Draw calls per frame are read with `renderer.info.autoReset = false` and one `renderer.info.reset()` per frame, so every composer pass counts (eng E10). The local smoke asserts equal instance counts, geometry count and draw calls across the two views at 1x and 4x (eng E17).

**Isolation and timer.** Measuring runs use `vp build`, then `vp preview --host 127.0.0.1`, never `vp run serve`. `preview.headers` in `vite.config.ts` sends COOP `same-origin` and COEP `require-corp`, so the page is cross-origin isolated and `performance.now()` steps 5 to 20 microseconds instead of 0.1 to 1 ms. Each result records `crossOriginIsolated` and the measured step; a page that is not cross-origin isolated, or a step coarser than 0.1 ms, makes the pass `valid:false` with reason `coarse-timer` (eng E6).

**Result fields the rule reads.** Steady CPU p95: `stats.steady.cpu.p95`. Median frame interval: `stats.steady.interval.median`. Churn hitch: `stats.churn.longestIntervalMs`. Counts: `counts.before` and `counts.after`, with `baseline` giving the per-count verdict and `baseline.all` the overall one. Draw calls per frame: `counts.before.drawCalls`.

**Invalid passes.** A hidden tab or blurred window, a resize, a lost WebGL context, a hall component error during churn, or a failed WebGL2 or composer start stops the pass and writes `valid:false` with the reason and the time. The results table uses only `valid:true` passes. An invalid pass is rerun. A pass with no result file is UNKNOWN: rerun it, never count it. A browser that cannot start WebGL2 is recorded here as a failure for both views with its reason.

**Machine.** Apple M1 Max MacBook Pro (MacBookPro18,4), built-in ProMotion display, on mains power. The CPU-time pick is valid for the target machine class because the M1 Max and the M1 Air share the CPU core design. The 1x 60 fps check is labelled "M1 Max, overstates M1 Air GPU": the M1 Max GPU is several times faster than an M1 Air's, and the M1 Air-class check belongs to chunk 36 (CEO C11). Real Chrome, Safari and Firefox are used. No number in this ADR comes from a Playwright run (eng E12): headless Chromium renders on SwiftShader and Playwright's WebKit is not Safari.

**Passes.** 48 in all (CEO C14): 3 browsers x 2 views x 2 loads x 2 bloom states, with the 4x cases (bloom on and off) run three times and the 1x cases once. That is 12 + 4 = 16 passes per browser.

## Runbook for the operator

Preconditions: on mains power, Low Power Mode off, other apps and browser tabs closed, one window, DevTools closed, the window left at its size and in front for the whole pass. Do not touch the machine during a pass. Leave browser settings at their defaults.

1. `git log` shows the rule commit; note its committer date.
2. `vp build`, then `vp preview --host 127.0.0.1 --port 4173`. Keep it running for all passes.
3. In each browser, open one URL per case. `<view>` is `spike-r3f` or `spike-vanilla`:
   `http://127.0.0.1:4173/?view=<view>&load=<1|4>&bloom=<0|1>&pass=<k>&bench=1`
4. Per browser, in this order, alternating R3F and vanilla:
   - 4x, bloom on: R3F pass 1, vanilla pass 1, R3F pass 2, vanilla pass 2, R3F pass 3, vanilla pass 3.
   - 4x, bloom off: the same six passes.
   - 1x, bloom on: R3F pass 1, vanilla pass 1.
   - 1x, bloom off: R3F pass 1, vanilla pass 1.
5. Each pass takes about 35 s. The status line reads Done when it ends, or "Pass invalid: <reason> at <t> s". Wait 30 s between passes to let the machine cool [estimated]. A pass that reads invalid is rerun with the same `pass` number.
6. A finished pass downloads `<browser>-<view>-load<N>-bloom<0|1>-pass<k>.json` (for example `chrome-spike-r3f-load4-bloom1-pass2.json`). If the browser blocks the download, the same JSON is in the console and in `window.__benchResult`. Move the files into `docs/adr/0001-results/`.
7. Check that each file has `valid: true`, `timer.crossOriginIsolated: true` and a `startedAt` later than the rule commit.

## Decision rule

Written before the first measured run. Inputs are the `valid:true` passes only, with 3 valid passes per 4x case.

For each browser and each 4x case (bloom on, bloom off), take each view's steady-state CPU p95 of every pass. The view's value is the median of its three pass p95 values; its range is the largest minus the smallest of the three. The gap is R3F's value minus vanilla's value. A gap counts only when it is larger than both views' ranges (CEO C14).

**R3F is chosen unless any of these holds**, in which case vanilla is chosen (CEO C10; thresholds estimated):

1. In any browser at 4x load, in either bloom state, R3F's p95 CPU frame time exceeds vanilla's by more than 1 ms, or by more than 15%, and the gap counts under the noise guard above. Either condition is enough.
2. In any pass at either load, any R3F count misses its baseline after churn: geometries, textures, `programs.length` or store listeners differ from the before-churn value, or a shared material received a `dispose` event.
3. In any browser at 4x load, in either bloom state, R3F's median longest churn interval (median over the three passes) is more than 2x vanilla's.

Rules 2 and 3 take no noise guard; rule 3 takes the median of three. The 1x passes feed rule 2 and the 60 fps check only.

**60 fps check** (1x load, bloom off, all three browsers, labelled "M1 Max, overstates M1 Air GPU"): both views keep a median frame interval of at most 16.7 ms and a CPU p95 under 16.7 ms. If a view misses it, this ADR states which one and why. This check does not change the pick.

Geometry, texture and program counts must return to baseline after disposal settles for the chosen approach.

## Results

All numbers come from the 48 files in `docs/adr/0001-results/`, computed with a throwaway script that applies the nearest-rank median and the decision rule as written. Rule commit: `a41b923` (committer date 2026-10-13T10:13:37+02:00).

**Validity.** 48 files; 48 `valid:true`; 48 with `timer.crossOriginIsolated: true`; timer step 0.005 to 0.020 ms (limit 0.1 ms); `startedAt` from 2026-10-13T10:57:03Z to 11:32:18Z, all after the rule commit.

**Environment** (M1 Max MacBook Pro, real browsers; three 0.186.1, R3F 9.8.1, app 0.2.1 in every file).

| Browser | Version | Refresh interval (ms) | Canvas (px) | DPR | GPU renderer string |
|---|---|---|---|---|---|
| Chrome | 155.0.0.0 | 16.68 | 2864 x 1654 | 2 | ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Max, Unspecified Version) |
| Firefox | 157.0 | 8.18 to 8.38 across passes (about 120 Hz) | 2560 x 1536 | 2 | Apple M1, or similar |
| Safari | 27.0.1 | 16.68 | 2620 x 1388 | 2 | Apple GPU |

**Rule 1: steady CPU p95 at 4x (ms).** Three pass values per view in pass order 1, 2, 3; value is their median, range is max minus min. Gap is R3F minus vanilla; the percentage is of vanilla's value. "Counts" means the gap is larger than both ranges.

| Browser | Bloom | R3F p95 passes | R3F value / range | Vanilla p95 passes | Vanilla value / range | Gap ms | Gap % | Counts | Fires (>1 ms or >15%) |
|---|---|---|---|---|---|---|---|---|---|
| Chrome | off | 2.55, 2.30, 2.61 | 2.55 / 0.31 | 2.655, 2.53, 2.975 | 2.655 / 0.445 | -0.105 | -4.0 | no | no |
| Chrome | on | 2.46, 2.365, 2.55 | 2.46 / 0.185 | 2.745, 2.61, 2.49 | 2.61 / 0.255 | -0.15 | -5.7 | no | no |
| Firefox | off | 2.80, 2.98, 2.96 | 2.96 / 0.18 | 2.84, 2.88, 2.54 | 2.84 / 0.34 | 0.12 | 4.2 | no | no |
| Firefox | on | 1.98, 2.70, 1.64 | 1.98 / 1.06 | 2.52, 2.26, 1.92 | 2.26 / 0.60 | -0.28 | -12.4 | no | no |
| Safari | off | 2.22, 1.86, 1.34 | 1.86 / 0.88 | 1.90, 1.64, 1.54 | 1.64 / 0.36 | 0.22 | 13.4 | no | no |
| Safari | on | 2.66, 2.68, 2.64 | 2.66 / 0.04 | 2.44, 2.48, 2.40 | 2.44 / 0.08 | 0.22 | 9.0 | yes | no (0.22 ms, 9.0%) |

Rule 1 verdict: does not fire. The only gap that counts under the noise guard (Safari, bloom on) is 0.22 ms and 9.0%, under both thresholds.

**Rule 3: longest churn interval at 4x (ms), `stats.churn.longestIntervalMs`.**

| Browser | Bloom | R3F passes | R3F median | Vanilla passes | Vanilla median | R3F / vanilla | Fires (>2x) |
|---|---|---|---|---|---|---|---|
| Chrome | off | 17.27, 17.66, 17.61 | 17.61 | 17.68, 17.35, 17.17 | 17.35 | 1.02 | no |
| Chrome | on | 17.19, 17.47, 17.57 | 17.47 | 17.68, 17.59, 17.40 | 17.59 | 0.99 | no |
| Firefox | off | 17.58, 8.72, 9.24 | 9.24 | 9.10, 8.70, 9.32 | 9.10 | 1.02 | no |
| Firefox | on | 16.64, 8.54, 8.68 | 8.68 | 9.82, 9.34, 8.36 | 9.34 | 0.93 | no |
| Safari | off | 18.28, 19.96, 17.98 | 18.28 | 17.84, 21.38, 17.78 | 17.84 | 1.02 | no |
| Safari | on | 17.30, 17.24, 17.46 | 17.30 | 17.64, 17.46, 19.82 | 17.64 | 0.98 | no |

Rule 3 verdict: does not fire. Every 50-cycle churn pass completed (`stats.churn.cycles` is 50 in all files).

**Rule 2: counts before and after churn, all 48 passes.** In every pass, for both views and all three browsers, `geometries`, `textures`, `programs` and `storeListeners` are equal before and after churn, `sharedMaterialDisposeEvents` is 0, and `baseline.all` is true. The values are identical across browsers and views and depend only on the bloom state:

| Load | Bloom | Passes per view per browser | Geometries | Textures | Programs | Store listeners | Shared-material dispose events | Draw calls | Rack / LED instances | Halls |
|---|---|---|---|---|---|---|---|---|---|---|
| 1x | off | 1 | 36 | 3 | 4 | 12 | 0 | 48 | 192 / 3,072 | 12 |
| 1x | on | 1 | 37 | 20 | 8 | 12 | 0 | 65 | 192 / 3,072 | 12 |
| 4x | off | 3 | 36 | 3 | 4 | 12 | 0 | 48 | 768 / 12,288 | 12 |
| 4x | on | 3 | 37 | 20 | 8 | 12 | 0 | 65 | 768 / 12,288 | 12 |

Rule 2 verdict: does not fire. R3F and vanilla drew the same scene in every pair of passes: same draw calls, instance counts and geometry count.

**60 fps check** (1x, bloom off; M1 Max, overstates M1 Air GPU). Limit: median frame interval at most 16.7 ms and CPU p95 under 16.7 ms.

| Browser | View | Median interval (ms) | CPU p95 (ms) | Passes |
|---|---|---|---|---|
| Chrome | R3F | 16.68 | 1.97 | yes |
| Chrome | vanilla | 16.68 | 2.45 | yes |
| Firefox | R3F | 8.32 | 2.64 | yes |
| Firefox | vanilla | 8.36 | 2.14 | yes |
| Safari | R3F | 16.68 | 2.32 | yes |
| Safari | vanilla | 16.68 | 2.22 | yes |

**GPU time (informational; decides nothing).** Only Chrome exposed `EXT_disjoint_timer_query_webgl2`; `stats.steady.gpu` is null in all Firefox and Safari files. Chrome, 4x, median over the three passes of each pass's median and p95 (ms):

| View | Bloom | GPU median | GPU p95 |
|---|---|---|---|
| R3F | off | 1.55 | 1.82 |
| R3F | on | 8.13 | 12.49 |
| Vanilla | off | 1.69 | 1.82 |
| Vanilla | on | 7.95 | 12.34 |

## Decision

R3F is chosen.

- Rule 1 did not fire: no browser or bloom state has an R3F p95 CPU gap above 1 ms or 15% that counts under the noise guard (largest counting gap: 0.22 ms, 9.0%, Safari bloom on).
- Rule 2 did not fire: all 48 passes returned to baseline with 0 shared-material dispose events.
- Rule 3 did not fire: the largest R3F to vanilla ratio of median longest churn interval is 1.02.
- 60 fps check: both views pass in all three browsers at 1x with bloom off (M1 Max, overstates M1 Air GPU).

## Consequences

Known follow-ons, whichever integration is picked (CEO RW12):

- R3F 10 is in alpha and WebGPU-first, so an R3F pick implies a later 9-to-10 migration.
- R3F 9's React peer range is `<19.4` (eng S3); the repo holds React at `~19.3` and Dependabot ignores React 19.4 and later.
- `postprocessing` 6.39.5 needs `three <0.187.0`, so Dependabot ignores three and `@types/three` at 0.187 and later and `postprocessing` at 7 and later until the peer range widens (eng E7).
- WebGL2 only. WebGPU is not measured.
- The 4x stress level is not the chunk 36 scene.
- The M1 Air-class check belongs to chunk 36 (CEO C11); this ADR measures on an M1 Max.
- Delete the spike views in chunk 04a, with the `spike-*` entry in `scripts/shots.config.ts` and any dependency this ADR rejects. `docs/img/03-spike.png` stays as a static image.
- Bloom costs about 6.3 to 6.6 ms of median GPU time and about 10.5 to 10.7 ms of p95 GPU time per frame at 4x on the M1 Max in Chrome (R3F 1.55 to 8.13 ms median, vanilla 1.69 to 7.95 ms; informational, single browser). Relevant to the D10 bloom auto-disable and to the chunk 36 M1 Air check.
