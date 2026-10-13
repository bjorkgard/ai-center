// ready: optional page expression to wait for before capture (views that render asynchronously).
export type ShotView = { name: string; file: string; ready?: string };

// URL contract (PLAN section 4): /?source=mock&scenario=steady&seed=1&freeze=1&view=<name>
export const views: ShotView[] = [
  { name: "home", file: "docs/img/01-scaffold.png" },
  { name: "home", file: "docs/img/02-pipeline.png" },
  {
    name: "spike-r3f",
    file: "docs/img/03-spike.png",
    ready: "window.__spikeSnapshot !== undefined",
  },
];

export const viewport = { width: 1280, height: 720 };
export const maxBytes = 200 * 1024;

export function viewUrl(base: string, name: string): string {
  return `${base}/?source=mock&scenario=steady&seed=1&freeze=1&view=${name}`;
}
