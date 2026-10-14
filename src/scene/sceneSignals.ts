import type { ViewName } from "../app/params.ts";
import { createFakeSignals } from "./fake.ts";
import { withDevOverrides } from "./hall/racksDev.ts";
import { packetRateOverride } from "./fibre/networkDev.ts";
import { dutyOverride } from "./plant/plantDev.ts";
import type { SceneSignals } from "./signals.ts";

// Racks the views fix instead of the time-varying fake count: view=hall is the empty chunk 06
// hall, view=racks the same hall full (CEO W-RW7).
const FIXED_RACKS: Partial<Record<ViewName, number>> = { hall: 0, racks: 16 };

// The signals a view reads. The one place that picks the implementation (fake.ts now, the store
// from chunk 18), under the dev overrides.
export function createSceneSignals(view: ViewName, seed: number, now: () => number): SceneSignals {
  return withDevOverrides(
    createFakeSignals({ seed, now, racks: FIXED_RACKS[view], dutyOverride, packetRateOverride }),
  );
}
