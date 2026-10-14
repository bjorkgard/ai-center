// ready: page expression to wait for before capture (CEO S-RW20); query: extra URL parameters.
export type ShotView = { name: string; file: string; ready: string; query?: string };

// Ready also means the loader is gone, so a fading loader never lands in an image.
export const readyExpression =
  'window.__sceneReady === true && !document.querySelector("[data-testid=loader]")';

// URL contract (PLAN section 4): /?source=mock&scenario=steady&seed=1&freeze=1&view=<name>
export const views: ShotView[] = [
  { name: "home", file: "docs/img/01-scaffold.png", ready: readyExpression },
  { name: "home", file: "docs/img/02-pipeline.png", ready: readyExpression },
  { name: "home", file: "docs/img/04a-core.png", ready: readyExpression, query: "dev=1" },
  { name: "home", file: "docs/img/04b-shell.png", ready: readyExpression },
];

export const viewport = { width: 1280, height: 720 };
export const maxBytes = 200 * 1024;

export function viewUrl(base: string, name: string, query?: string): string {
  const url = `${base}/?source=mock&scenario=steady&seed=1&freeze=1&view=${name}`;
  return query ? `${url}&${query}` : url;
}
