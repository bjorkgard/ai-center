import { createContext, useContext } from "react";
import type { Status } from "./materials.ts";

// What one rack shows: the main session's status on the strip, one status per active subagent on
// the blades (a lit blade each, at most 12), and a load 0-1 that sets how fast its LEDs pulse
// (0 means no activity: steady). `phase` (0-1) offsets one rack's pulse from the next.
export interface RackLoad {
  status: Status;
  blades: readonly Status[];
  load: number;
  phase: number;
}

export interface HallSign {
  letter: string;
  project: string;
}

// The one seam between the scene and its data (CEO W-RW28): components read these values only
// through it, at scene time. fake.ts is the first implementation; chunks 18 and 22 add a
// store-backed one, and chunk 10 adds `packetPhase`.
// Reads allocate nothing, since the frame loop calls them.
export interface SceneSignals {
  rackCount(hall: number): number;
  ledLoad(hall: number, rack: number): RackLoad;
  // Letter and project name for a hall's sign (chunk 06's placeholder moved here).
  hallSign(hall: number): HallSign;
  // The cooling load 0-1 now (chunk 09): vapour density and fan speed follow it.
  duty(): number;
  // Age in seconds, 0-6, of vapour particle i (0-59 the first tower, 60-119 the second, ...):
  // (scene time + its seeded offset) mod 6 s.
  vapourPhase(i: number): number;
  // Angle in radians of cooling fan i now. It turns at the duty's speed, a quarter of it under
  // reduced motion, and carries on from where it was when the duty changes.
  fanAngle(i: number, reducedMotion?: boolean): number;
}

export const SignalsContext = createContext<SceneSignals | null>(null);

export function useSignals(): SceneSignals {
  const signals = useContext(SignalsContext);
  if (signals === null) throw new Error("useSignals needs a SignalsContext provider above it");
  return signals;
}
