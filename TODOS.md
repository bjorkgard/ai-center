# TODOS

## Deferred

- **`vp run doctor` setup check** (deferred by /plan-ceo-review Q5 (X3), 2026-10-12, Phase 0 review)
  - What: `scripts/doctor.ts` run by `vp run doctor`. Checks Node matches the pin, Playwright Chromium/Firefox/WebKit are installed, and `gh auth status`; prints one fix line per miss and exits non-zero on any miss. `e2e:local` calls it first; CONTRIBUTING links it.
  - Why deferred: single contributor today, and Playwright already prints an install hint for missing browsers.
  - Trigger to pick up: a second contributor joins, or the first setup on a fresh machine.
  - Effort: S (human ~1h / CC ~5 min).
