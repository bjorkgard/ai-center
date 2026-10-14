import { MATERIALS } from "../materials.ts";
import { logScene } from "../sceneLog.ts";
import { ROOF_CUT_CONSTANT, ROOF_UNCUT_CONSTANT } from "./hallLayout.ts";

// The roof cutaway is one state for every hall: the shared hall material's single clipping
// plane. Cut puts it 0.01 above the wall top, uncut above the roof top. Only the constant
// moves, so no shader recompiles. The roof starts cut in every view (CEO W-RW25).
let cut = true;
const listeners = new Set<() => void>();

export function isRoofCut(): boolean {
  return cut;
}

export function subscribeRoof(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setRoofCut(on: boolean): void {
  if (typeof on !== "boolean") {
    console.warn(`[hall] setRoofCut: "on" must be true or false, got ${String(on)}; ignoring it`);
    return;
  }
  if (on === cut) return;
  logScene(`roof ${cut ? "cut" : "uncut"} -> ${on ? "cut" : "uncut"}`);
  cut = on;
  MATERIALS.hall.clippingPlanes![0].constant = on ? ROOF_CUT_CONSTANT : ROOF_UNCUT_CONSTANT;
  for (const listener of listeners) listener();
}
