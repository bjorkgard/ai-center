import { HALL, RACK_ROW } from "./hallLayout.ts";

// Where racks and their LEDs stand in a hall. Pure numbers (no three import) so the look-dev
// layout and the e2e specs can read them. Hall-local coordinates: the slab's centre on the
// ground; slots 0-7 are the back row (facing +z, towards the camera), 8-15 the front row.
export const RACK_SLOTS = 16;
export const RACK = { width: 0.55, height: 1.1, depth: 0.8 };

// One status strip on top (LED 0) and 12 blades below (LEDs 1-12), two to a row [sizes estimated].
export const BLADES = 12;
export const LEDS_PER_RACK = 1 + BLADES;
export const LED_DEPTH = 0.03;
const STRIP = { width: 0.46, height: 0.07, y: 1.0 };
const BLADE = { width: 0.2, height: 0.07, dx: 0.12, firstY: 0.84, pitch: 0.11 };

export interface SlotPose {
  x: number;
  z: number;
  // +1 faces +z, -1 faces -z: both rows face the cold aisle.
  facing: 1 | -1;
}

export function slotPose(slot: number): SlotPose {
  const row = slot < RACK_ROW.racks ? 0 : 1;
  const col = slot % RACK_ROW.racks;
  const z = RACK_ROW.coldAisle / 2 + RACK_ROW.depth / 2;
  return {
    x: (col - (RACK_ROW.racks - 1) / 2) * RACK_ROW.pitch,
    z: row === 0 ? -z : z,
    facing: row === 0 ? 1 : -1,
  };
}

export interface LedBox {
  // Offset from the rack's base centre, in the rack's own frame (+z out of its front).
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
}

// LED 0 is the status strip, LEDs 1-12 are the blades, filled row by row.
export function ledBox(k: number): LedBox {
  const z = RACK.depth / 2 + LED_DEPTH / 2 - 0.01;
  if (k === 0) return { x: 0, y: STRIP.y, z, width: STRIP.width, height: STRIP.height };
  const blade = k - 1;
  return {
    x: (blade % 2 === 0 ? -1 : 1) * BLADE.dx,
    y: BLADE.firstY - Math.floor(blade / 2) * BLADE.pitch,
    z,
    width: BLADE.width,
    height: BLADE.height,
  };
}

// Centre of LED `k` of the rack in `slot`, in hall-local coordinates.
export function ledCentre(slot: number, k: number): [number, number, number] {
  const pose = slotPose(slot);
  const box = ledBox(k);
  return [pose.x + pose.facing * box.x, HALL.slabHeight + box.y, pose.z + pose.facing * box.z];
}
