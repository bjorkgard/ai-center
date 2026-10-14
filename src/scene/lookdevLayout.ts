import { STATUS_ORDER, type Status } from "./materials.ts";

export type Vec3 = [number, number, number];

export const SLAB = { width: 8, depth: 4, height: 0.2 };
export const RACKS = 8;
export const RACK = { width: 0.55, height: 1.1, depth: 0.8, pitch: 0.8, z: -0.6 };
export const LEDS_PER_RACK = 4;
export const LED = { size: [0.34, 0.09, 0.04] as Vec3, firstY: 0.3, pitch: 0.2 };

export const rackX = (i: number) => (i - (RACKS - 1) / 2) * RACK.pitch;

// Centre of every LED and the status it shows: rack i, LED j is status (i * 4 + j) mod 6, so
// all six D17 colours appear. The look-dev test reads the same table to find them on screen.
export function ledPlacements(): { status: Status; at: Vec3 }[] {
  const frontZ = RACK.z + RACK.depth / 2;
  return Array.from({ length: RACKS * LEDS_PER_RACK }, (_, n) => {
    const i = Math.floor(n / LEDS_PER_RACK);
    const j = n % LEDS_PER_RACK;
    return {
      status: STATUS_ORDER[n % STATUS_ORDER.length],
      at: [rackX(i), SLAB.height + LED.firstY + j * LED.pitch, frontZ + 0.02] as Vec3,
    };
  });
}
