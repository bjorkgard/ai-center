import { logScene } from "../sceneLog.ts";
import type { RackLoad, SceneSignals } from "../signals.ts";
import { RACK_SLOTS } from "./rackLayout.ts";
import { SIGN_SLOTS } from "./hallLayout.ts";

// The Racks dev controls (chunk 07): a rack count per hall and the fake load on or off. They
// override the signals, like the roof toggle: module state with subscribers, so the HUD, the
// frozen-frame redraw and `__sceneDev` all see one value (CEO W-RW12, W-RW20).
let fakeLoad = true;
const overrides: (number | null)[] = Array.from({ length: SIGN_SLOTS }, () => null);
const shown: number[] = Array.from({ length: SIGN_SLOTS }, () => 0);
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

export function subscribeRacks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Pulls a number into 0..max: NaN, a fraction or an out of range value is fixed with one warning
// that names the argument (CEO W-RW31).
function clampArg(name: string, value: number, max: number): number {
  const fixed = Number.isNaN(value) ? 0 : Math.min(Math.max(Math.round(value), 0), max);
  if (fixed !== value) {
    console.warn(
      `[dev] "${name}" must be a whole number 0-${max}, got ${String(value)}; using ${fixed}`,
    );
  }
  return fixed;
}

export function setRackCount(hall: number, n: number): void {
  const slot = clampArg("hall", hall, SIGN_SLOTS - 1);
  const count = clampArg("n", n, RACK_SLOTS);
  if (overrides[slot] === count) return;
  logScene(`hall ${slot} rack count ${overrides[slot] ?? "auto"} -> ${count}`);
  overrides[slot] = count;
  notify();
}

export function setFakeLoad(on: boolean): void {
  if (typeof on !== "boolean") {
    console.warn(`[dev] setFakeLoad: "on" must be true or false, got ${String(on)}; ignoring it`);
    return;
  }
  if (on === fakeLoad) return;
  logScene(`fake load ${fakeLoad ? "on" : "off"} -> ${on ? "on" : "off"}`);
  fakeLoad = on;
  notify();
}

export function isFakeLoad(): boolean {
  return fakeLoad;
}

export function rackOverride(hall: number): number | null {
  return overrides[hall] ?? null;
}

// What a hall draws now, reported by the hall, so the slider shows the real count.
export function reportShown(hall: number, count: number): void {
  if (shown[hall] === undefined || shown[hall] === count) return;
  shown[hall] = count;
  notify();
}

export function shownCount(hall: number): number {
  return shown[hall] ?? 0;
}

// What each mounted hall's LED buffer holds, so a test can read the strip colour the frame loop
// wrote (an e2e cannot read the GPU buffer, and a live capture is slow).
export interface LedSource {
  ledColor(rack: number): [number, number, number] | null;
}
const sources = new Map<number, LedSource>();

export function registerLeds(hall: number, source: LedSource): () => void {
  sources.set(hall, source);
  return () => {
    if (sources.get(hall) === source) sources.delete(hall);
  };
}

// The strip colour (linear rgb) of a hall's rack 0-15, or null when that rack is not drawn.
export function ledColor(hall: number, rack: number): [number, number, number] | null {
  const slot = clampArg("hall", hall, SIGN_SLOTS - 1);
  const index = clampArg("rack", rack, RACK_SLOTS - 1);
  return sources.get(slot)?.ledColor(index) ?? null;
}

export function resetRacksDev(): void {
  sources.clear();
  fakeLoad = true;
  overrides.fill(null);
  shown.fill(0);
  listeners.clear();
}

// With the fake load off every rack reads as idle with no lit blades and no pulse.
const NO_LOAD: RackLoad = { status: "idle", blades: [], load: 0, phase: 0 };

export function withDevOverrides(base: SceneSignals): SceneSignals {
  return {
    rackCount: (hall) => overrides[hall] ?? base.rackCount(hall),
    ledLoad: (hall, rack) => (fakeLoad ? base.ledLoad(hall, rack) : NO_LOAD),
    hallSign: (hall) => base.hallSign(hall),
    duty: () => base.duty(),
    vapourPhase: (i) => base.vapourPhase(i),
    fanAngle: (i, reducedMotion) => base.fanAngle(i, reducedMotion),
    packetRate: () => base.packetRate(),
    packetPhase: (line, i, length, count, reducedMotion) =>
      base.packetPhase(line, i, length, count, reducedMotion),
  };
}
