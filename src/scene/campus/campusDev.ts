import { logScene } from "../sceneLog.ts";
import { MIN_PLACED, SLOT_COUNT } from "./layout.ts";

// The Campus dev controls (chunk 08): how many halls are placed (A and B always, up to 12) and
// whether the waypoint graph shows. Like the roof and racks toggles, module state with
// subscribers, so the HUD, the scene and `__sceneDev` see one value (CEO W-RW12).
let placed = MIN_PLACED;
let waypoints = false;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

export function subscribeCampus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function placedHalls(): number {
  return placed;
}

export function showWaypoints(): boolean {
  return waypoints;
}

// Pulls the count into 2-12: NaN, a fraction or an out of range value is fixed with one warning
// that names the argument (CEO W-RW31).
export function setPlacedHalls(n: number): void {
  const fixed = Number.isNaN(n)
    ? MIN_PLACED
    : Math.min(Math.max(Math.round(n), MIN_PLACED), SLOT_COUNT);
  if (fixed !== n) {
    console.warn(
      `[dev] "n" must be a whole number ${MIN_PLACED}-${SLOT_COUNT}, got ${String(n)}; using ${fixed}`,
    );
  }
  if (fixed === placed) return;
  logScene(`placed halls ${placed} -> ${fixed}`);
  placed = fixed;
  notify();
}

export function setWaypoints(on: boolean): void {
  if (typeof on !== "boolean") {
    console.warn(`[dev] setWaypoints: "on" must be true or false, got ${String(on)}; ignoring it`);
    return;
  }
  if (on === waypoints) return;
  waypoints = on;
  notify();
}

export function resetCampusDev(): void {
  placed = MIN_PLACED;
  waypoints = false;
  listeners.clear();
}
