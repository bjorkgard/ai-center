import { logScene } from "../sceneLog.ts";
import { PACKET } from "./packets.ts";

// The Network dev control (chunk 10): the packet rate. Like the cooling duty it is module state
// with subscribers, so the HUD, the frozen-frame redraw and `__sceneDev` see one value (CEO
// W-RW12). Null means the default rate drives the lines.
let override: number | null = null;
const listeners = new Set<() => void>();
// What the fibre last drew, reported each frame without notifying: how many lines, and the speed
// in units a second of the first line's first packet measured from its drawn matrices.
let lines: number | null = null;
let speed: number | null = null;

const notify = () => {
  for (const listener of listeners) listener();
};

export function subscribeNetwork(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function packetRateOverride(): number | null {
  return override;
}

// Pulls the rate into 0-10: NaN or an out of range value is fixed with one warning that names the
// argument; anything but a number warns and leaves the value alone (CEO W-RW31).
export function setPacketRate(perSecond: number): void {
  if (typeof perSecond !== "number") {
    console.warn(
      `[dev] setPacketRate: "perSecond" must be a number 0-${PACKET.maxRate}, got ${String(perSecond)}; ignoring it`,
    );
    return;
  }
  const fixed = Number.isNaN(perSecond) ? 0 : Math.min(Math.max(perSecond, 0), PACKET.maxRate);
  if (fixed !== perSecond) {
    console.warn(
      `[dev] "perSecond" must be a number 0-${PACKET.maxRate}, got ${String(perSecond)}; using ${fixed}`,
    );
  }
  if (fixed === override) return;
  logScene(`packet rate ${override ?? "auto"} -> ${fixed}`);
  override = fixed;
  notify();
}

// The fibre reports each frame; a speed of null (no time passed yet) keeps the last one.
export function reportNetwork(lineCount: number, unitsPerSecond: number | null): void {
  lines = lineCount;
  if (unitsPerSecond !== null) speed = unitsPerSecond;
}

// The lines drawn now, or null before the first frame (read-only).
export function fibreLines(): number | null {
  return lines;
}

// A packet's speed in units a second as drawn, or null before it has moved (read-only).
export function packetSpeed(): number | null {
  return speed;
}

// The rate the HUD slider shows: the override when set, else the default.
export function displayedRate(forced: number | null): number {
  return forced ?? PACKET.defaultRate;
}

export function resetNetworkDev(): void {
  override = null;
  lines = null;
  speed = null;
  listeners.clear();
}
