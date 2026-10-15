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
  // The frozen mock catch-up in the open Data section: the perf rows and the other sections are hidden so the section fits.
  {
    name: "home",
    file: "docs/img/11-store-debug.png",
    ready: readyExpression,
    query: "dev=1",
    setup:
      'document.querySelector("[data-testid=perf-hud] dl").style.display = "none"; document.querySelectorAll("[data-testid=perf-hud] section").forEach((s) => { if (s.dataset.testid !== "dev-data") s.style.display = "none"; }); document.querySelector("[data-testid=dev-data] button").click();',
    settled:
      'document.querySelector("[data-testid=data-health]")?.textContent.includes("live") && document.querySelectorAll("[data-testid=data-session-row]").length > 0',
  },
  // The metrics list in the open Data section, with the tokens badge focused so its tooltip (the
  // provenance and the basis) shows.
  {
    name: "home",
    file: "docs/img/13-provenance.png",
    ready: readyExpression,
    query: "dev=1",
    setup:
      '(async () => { document.querySelector("[data-testid=perf-hud] dl").style.display = "none"; document.querySelectorAll("[data-testid=perf-hud] section").forEach((s) => { if (s.dataset.testid !== "dev-data") s.style.display = "none"; }); document.querySelector("[data-testid=dev-data] button").click(); while (!document.querySelector("[data-metric=tokens] [data-provenance]")) await new Promise((r) => setTimeout(r, 50)); document.querySelector("[data-metric=tokens] [data-provenance]").focus(); })()',
    settled:
      'document.querySelector("[data-testid=data-health]")?.textContent.includes("live") && document.activeElement?.getAttribute("data-provenance") === "real"',
  },
];

export const viewport = { width: 1280, height: 720 };
export const maxBytes = 200 * 1024;

export function viewUrl(base: string, name: string, query?: string): string {
  const url = `${base}/?source=mock&scenario=steady&seed=1&freeze=1&view=${name}`;
  return query ? `${url}&${query}` : url;
}
