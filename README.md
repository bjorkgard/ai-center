# Synapse Horizon

![Synapse Horizon](docs/img/01-scaffold.png)

A live 3D AI data-centre dashboard that tracks Claude and Codex agents and subagents, styled like a strategy game.

## Quick start

```sh
vp install
vp dev
```

`vp dev` serves the app on `http://127.0.0.1:5173`.

## Testing and screenshots

```sh
vp exec playwright install chromium firefox webkit   # once per machine
vp run e2e         # smoke tests in Chromium and Firefox (what CI runs)
vp run e2e:local   # all three engines, then regenerates the screenshots
vp run shots       # builds, then writes docs/img/*.png (1280x720, under 200 KB)
```

The smoke spec checks the page title, the heading, the `app-version` meta tag and that
the console stays clean. A repeat-run spec captures the same view twice and asserts the two
images agree within a 0.5% pixel diff. `vp run shots` fails with `ShotFailed` (exit 1) if a
page logs a console error or an image is over 200 KB.

## Status

Chunk 02 done. See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/PLAN.md](docs/PLAN.md) for the build plan.
