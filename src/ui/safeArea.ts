import type { SafeArea } from "../app/store/index.ts";

export type Rect = SafeArea;

const area = (r: Rect) => Math.max(0, r.width) * Math.max(0, r.height);

// The largest rect left once each panel is cut from the side that costs the least area.
// Panels are cut in the order given; one that misses the rect is ignored.
export function carveSafeArea(canvas: Rect, panels: Rect[]): Rect {
  let r = canvas;
  for (const p of panels) {
    const right = r.x + r.width;
    const bottom = r.y + r.height;
    if (p.x >= right || p.x + p.width <= r.x || p.y >= bottom || p.y + p.height <= r.y) continue;
    const top = Math.max(r.y, p.y + p.height);
    const left = Math.max(r.x, p.x + p.width);
    const options: Rect[] = [
      { x: r.x, y: top, width: r.width, height: bottom - top },
      { x: r.x, y: r.y, width: r.width, height: Math.min(bottom, p.y) - r.y },
      { x: left, y: r.y, width: right - left, height: r.height },
      { x: r.x, y: r.y, width: Math.min(right, p.x) - r.x, height: r.height },
    ];
    r = options.reduce((best, o) => (area(o) > area(best) ? o : best));
  }
  return r;
}

const same = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

export interface SafeAreaDeps {
  measure(): { canvas: Rect; panels: Rect[] };
  read(): SafeArea;
  write(area: SafeArea): void;
  raf(cb: () => void): number;
  caf(id: number): void;
  warn(message: string): void;
}

export interface SafeAreaWatcher {
  schedule(): void;
  stop(): void;
}

// Measures on an animation frame, never inside an observer callback, and writes only a
// changed rect, so the browser raises no ResizeObserver loop error (CEO S-RW36).
export function createSafeAreaWatcher(deps: SafeAreaDeps): SafeAreaWatcher {
  let pending: number | null = null;
  let stopped = false;
  let warned = false;

  const run = () => {
    pending = null;
    const { canvas, panels } = deps.measure();
    let next = carveSafeArea(canvas, panels);
    if (next.width <= 0 || next.height <= 0) {
      if (!warned) {
        warned = true;
        deps.warn(
          "[layout] the panels cover the whole 3D area; using the full canvas as safe area",
        );
      }
      next = canvas;
    } else {
      warned = false;
    }
    if (!same(deps.read(), next)) deps.write(next);
  };

  return {
    schedule() {
      if (stopped || pending !== null) return;
      pending = deps.raf(run);
    },
    stop() {
      stopped = true;
      if (pending !== null) deps.caf(pending);
      pending = null;
    },
  };
}
