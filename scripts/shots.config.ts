// ready: page expression to wait for before capture (CEO S-RW20); query: extra URL parameters;
// setup: a page expression run once the scene is ready, and settled: what to wait for after it.
export type ShotView = {
  name: string;
  file: string;
  ready: string;
  query?: string;
  setup?: string;
  settled?: string;
};

// Ready also means the loader is gone, so a fading loader never lands in an image.
export const readyExpression =
  'window.__sceneReady === true && !document.querySelector("[data-testid=loader]")';

// URL contract (PLAN section 4): /?source=mock&scenario=steady&seed=1&freeze=1&view=<name>
export const views: ShotView[] = [
  { name: "home", file: "docs/img/01-scaffold.png", ready: readyExpression },
  { name: "home", file: "docs/img/02-pipeline.png", ready: readyExpression },
  { name: "home", file: "docs/img/04a-core.png", ready: readyExpression, query: "dev=1" },
  { name: "home", file: "docs/img/04b-shell.png", ready: readyExpression },
  { name: "home", file: "docs/img/04c-scene.png", ready: readyExpression },
  { name: "lookdev", file: "docs/img/04c-lookdev.png", ready: readyExpression },
  { name: "hall", file: "docs/img/06-hall.png", ready: readyExpression },
  { name: "racks", file: "docs/img/07-racks.png", ready: readyExpression },
  { name: "home", file: "docs/img/08-campus.png", ready: readyExpression },
  // The same frozen home with bloom forced off through the dev hook (design-review Phase 3 WD4):
  // the HUD is hidden and the shot waits for the frame drawn after the tier change.
  {
    name: "home",
    file: "docs/img/08-campus-nobloom.png",
    ready: readyExpression,
    query: "dev=1",
    setup:
      'window.__shotFrames = window.__sceneDev.stats().frames; window.__sceneDev.setQuality("medium"); document.querySelector("[data-testid=perf-hud]").style.display = "none";',
    settled:
      "window.__sceneDev.stats().bloom === false && window.__sceneDev.stats().frames > window.__shotFrames",
  },
  { name: "cooling", file: "docs/img/09-cooling.png", ready: readyExpression },
  { name: "power", file: "docs/img/10-power-network.png", ready: readyExpression },
];

export const viewport = { width: 1280, height: 720 };
export const maxBytes = 200 * 1024;

export function viewUrl(base: string, name: string, query?: string): string {
  const url = `${base}/?source=mock&scenario=steady&seed=1&freeze=1&view=${name}`;
  return query ? `${url}&${query}` : url;
}
