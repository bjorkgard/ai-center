import { HALL } from "./hall/hallLayout.ts";
import { LED_DEPTH, ledCentre } from "./hall/rackLayout.ts";
import { STATUS_ORDER, type Status } from "./materials.ts";
import type { RackLoad, SceneSignals } from "./signals.ts";

export type Vec3 = [number, number, number];

// The slab is the hall of buildHall; the look-dev rack row is the hall's own instances: slots
// 0-7 are its back row, facing the cold aisle.
export const SLAB = { width: HALL.width, depth: HALL.depth, height: HALL.slabHeight };
export const RACKS = 8;
export const LEDS_PER_RACK = 4;

// Rack i shows the strip status i mod 6, and its first four blades are lit with the statuses
// (i * 4 + j) mod 6, so all six D17 colours appear. The pulse is at its top (phase 0.25 at t=0),
// so the frozen view shows each colour at full level.
export function lookdevRack(i: number): RackLoad {
  return {
    status: STATUS_ORDER[i % STATUS_ORDER.length],
    blades: Array.from(
      { length: LEDS_PER_RACK },
      (_, j) => STATUS_ORDER[(i * LEDS_PER_RACK + j) % STATUS_ORDER.length],
    ),
    load: 0.5,
    phase: 0.25,
  };
}

// The look-dev view reads its racks from here instead of the fake load, keeping the hall's sign.
export function createLookDevSignals(base: SceneSignals): SceneSignals {
  const racks = Array.from({ length: RACKS }, (_, i) => lookdevRack(i));
  return {
    rackCount: () => RACKS,
    ledLoad: (_hall, rack) => racks[rack] ?? racks[0],
    hallSign: (hall) => base.hallSign(hall),
    duty: () => base.duty(),
    vapourPhase: (i) => base.vapourPhase(i),
    fanAngle: (i, reducedMotion) => base.fanAngle(i, reducedMotion),
  };
}

// Centre of the front face of every lit blade and the status it shows. The look-dev test reads
// the same table to find them on screen. The racks face +z.
export function ledPlacements(): { status: Status; at: Vec3 }[] {
  const out: { status: Status; at: Vec3 }[] = [];
  for (let i = 0; i < RACKS; i++) {
    const rack = lookdevRack(i);
    for (let j = 0; j < LEDS_PER_RACK; j++) {
      const [x, y, z] = ledCentre(i, 1 + j);
      out.push({ status: rack.blades[j], at: [x, y, z + LED_DEPTH / 2] });
    }
  }
  return out;
}
