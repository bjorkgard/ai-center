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
