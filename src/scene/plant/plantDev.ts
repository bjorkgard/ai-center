import { logScene } from "../sceneLog.ts";

// The Cooling dev control (chunk 09): the duty slider. Like the campus and racks controls it is
// module state with subscribers, so the HUD, the frozen-frame redraw and `__sceneDev` see one
// value (CEO W-RW12). Null means the seeded fake duty drives the plant.
let override: number | null = null;
const listeners = new Set<() => void>();
// Where the Cooling slider starts before the plant has drawn: the fake duty at scene time 0
// (fake.ts FAKE_DUTY.mean).
const DEFAULT_DUTY = 0.75;
// What the plant last drew, reported each frame without notifying: the duty it read and the turn
// rate of a fan measured from its drawn matrices.
let live: number | null = null;
let fanRate: number | null = null;

const notify = () => {
  for (const listener of listeners) listener();
};

export function subscribePlant(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dutyOverride(): number | null {
  return override;
}

// Pulls the duty into 0-1: NaN or an out of range value is fixed with one warning that names the
// argument (CEO W-RW31).
export function setDuty(value: number): void {
  if (typeof value !== "number") {
    console.warn(`[dev] setDuty: "value" must be a number 0-1, got ${String(value)}; ignoring it`);
    return;
  }
  const fixed = Number.isNaN(value) ? 0 : Math.min(Math.max(value, 0), 1);
  if (fixed !== value) {
    console.warn(`[dev] "value" must be a number 0-1, got ${String(value)}; using ${fixed}`);
  }
  if (fixed === override) return;
  logScene(`duty ${override ?? "auto"} -> ${fixed}`);
  override = fixed;
  notify();
}

// The plant reports each frame; a rate of null (no time passed yet) keeps the last one.
export function reportPlant(duty: number, turnsPerSecond: number | null): void {
  live = duty;
  if (turnsPerSecond !== null) fanRate = turnsPerSecond;
}

export function liveDuty(): number | null {
  return live;
}

// Turns a second of a plant fan as drawn, or null before it has turned (read-only).
export function fanTurnRate(): number | null {
  return fanRate;
}

// The duty the HUD slider shows: the override when set, else the duty the fake is driving now.
export function displayedDuty(forced: number | null, current: number | null): number {
  return forced ?? current ?? DEFAULT_DUTY;
}

export function resetPlantDev(): void {
  override = null;
  live = null;
  fanRate = null;
  listeners.clear();
}
