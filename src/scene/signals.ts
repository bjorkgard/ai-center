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
// store-backed one, and later chunks add `duty`, `vapourPhase`, `fanAngle` and `packetPhase`.
// Reads allocate nothing, since the frame loop calls them.
export interface SceneSignals {
  rackCount(hall: number): number;
  ledLoad(hall: number, rack: number): RackLoad;
  // Letter and project name for a hall's sign (chunk 06's placeholder moved here).
  hallSign(hall: number): HallSign;
}

export const SignalsContext = createContext<SceneSignals | null>(null);

export function useSignals(): SceneSignals {
  const signals = useContext(SignalsContext);
  if (signals === null) throw new Error("useSignals needs a SignalsContext provider above it");
  return signals;
}
