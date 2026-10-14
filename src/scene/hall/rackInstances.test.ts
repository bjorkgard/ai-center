import type { BufferGeometry } from "three";
import { expect, test } from "vite-plus/test";
import { MATERIALS, statusLed } from "../materials.ts";
import type { RackLoad } from "../signals.ts";
import { ledLevel } from "./ledPulse.ts";
import { LEDS_PER_RACK, RACK_SLOTS } from "./rackLayout.ts";
import { RackInstances, ledGeometry, rackGeometry } from "./rackInstances.ts";

const triangles = (g: BufferGeometry) => (g.index?.count ?? g.getAttribute("position").count) / 3;

const LOAD: RackLoad = {
  status: "tool",
  blades: ["tool", "thinking", "idle"],
  load: 0.5,
  phase: 0,
};
const signals = { ledLoad: () => LOAD };

test("triangle caps: a rack is 12 triangles or fewer, an LED is 12 or fewer", () => {
  expect(triangles(rackGeometry())).toBeLessThanOrEqual(12);
  expect(triangles(ledGeometry())).toBeLessThanOrEqual(12);
});

test("each hall owns a rack mesh of 16 and an LED mesh of 208, on library materials", () => {
  const racks = new RackInstances();
  expect(RACK_SLOTS).toBe(16);
  expect(LEDS_PER_RACK).toBe(13);
  expect(racks.racks.instanceMatrix.count).toBe(16);
  expect(racks.leds.instanceMatrix.count).toBe(208);
  expect(racks.racks.material).toBe(MATERIALS.rack);
  expect(racks.leds.material).toBe(MATERIALS.led);
  expect(racks.racks.castShadow).toBe(true);
  expect(racks.leds.castShadow).toBe(false);
  expect(racks.racks.count).toBe(0);
  expect(racks.leds.count).toBe(0);
  racks.dispose();
});

test("a count change writes only mesh.count and instance attributes: same geometry, same attributes", () => {
  const racks = new RackInstances();
  const before = {
    rackGeometry: racks.racks.geometry,
    ledGeometry: racks.leds.geometry,
    rackPosition: racks.racks.geometry.getAttribute("position"),
    ledPosition: racks.leds.geometry.getAttribute("position"),
    rackMatrix: racks.racks.instanceMatrix,
    ledMatrix: racks.leds.instanceMatrix,
    ledColour: racks.leds.instanceColor,
    rackIndex: racks.racks.geometry.index,
    rackMaterial: racks.racks.material,
  };
  expect(before.ledColour).not.toBeNull();
  for (const n of [16, 0, 7, 16, 3, 0]) {
    racks.setRackCount(n);
    racks.update(signals, 0, 1.3, false);
    expect(racks.racks.count).toBe(n);
    expect(racks.leds.count).toBe(n * 13);
    expect(racks.racks.geometry).toBe(before.rackGeometry);
    expect(racks.leds.geometry).toBe(before.ledGeometry);
    expect(racks.racks.geometry.getAttribute("position")).toBe(before.rackPosition);
    expect(racks.leds.geometry.getAttribute("position")).toBe(before.ledPosition);
    expect(racks.racks.instanceMatrix).toBe(before.rackMatrix);
    expect(racks.leds.instanceMatrix).toBe(before.ledMatrix);
    expect(racks.leds.instanceColor).toBe(before.ledColour);
    expect(racks.racks.geometry.index).toBe(before.rackIndex);
    expect(racks.racks.material).toBe(before.rackMaterial);
    expect(racks.racks.instanceMatrix.count).toBe(16);
  }
  racks.dispose();
});

test("a rack count above 16 is held at 16 and the extra keys are counted", () => {
  const racks = new RackInstances();
  racks.setKeys(Array.from({ length: 19 }, (_, i) => `s${i}`));
  expect(racks.racks.count).toBe(16);
  expect(racks.allocator.overflow).toBe(3);
  racks.dispose();
});

test("a key keeps its rack when another leaves; the gap shows no rack", () => {
  const racks = new RackInstances();
  racks.setKeys(["a", "b", "c"]);
  const c = racks.allocator.slotOf("c");
  racks.setKeys(["a", "c"]);
  expect(racks.allocator.slotOf("c")).toBe(c);
  expect(racks.racks.count).toBe(3);
  const matrix = racks.racks.instanceMatrix.array;
  // Slot 1 is free: its matrix is the zero scale, so nothing draws there.
  expect(Array.from(matrix.slice(16, 16 + 3))).toEqual([0, 0, 0]);
  racks.dispose();
});

test("lit LEDs carry the status colour times the pulse level; unlit blades are dark", () => {
  const racks = new RackInstances();
  racks.setRackCount(1);
  racks.update(signals, 0, 0.7, false);
  const colour = racks.leds.instanceColor!;
  const level = ledLevel(LOAD.load, LOAD.phase, 0.7, false);
  // LED 0 is the strip in the main session's status (tool): its colour times the level.
  const tool = statusLed("tool").emissive;
  expect(colour.getX(0)).toBeCloseTo(tool.r * level, 5);
  expect(colour.getY(0)).toBeCloseTo(tool.g * level, 5);
  expect(colour.getZ(0)).toBeCloseTo(tool.b * level, 5);
  // Blade 1 (LED index 1) is lit, blade 4 (index 4) is not.
  const brightness = (i: number) => colour.getX(i) + colour.getY(i) + colour.getZ(i);
  expect(brightness(1)).toBeGreaterThan(0.1);
  expect(brightness(4)).toBeLessThan(0.05);
  racks.dispose();
});

test("LEDs pulse with time, and hold a steady 0.8 under reduced motion", () => {
  const racks = new RackInstances();
  racks.setRackCount(1);
  const strip = () => racks.leds.instanceColor!.getY(0);
  racks.update(signals, 0, 0, false);
  const a = strip();
  racks.update(signals, 0, 0.4, false);
  const b = strip();
  expect(a).not.toBeCloseTo(b, 3);
  racks.update(signals, 0, 0, true);
  const steadyA = strip();
  racks.update(signals, 0, 0.4, true);
  const steadyB = strip();
  expect(steadyA).toBe(steadyB);
  // Full level is the pulse maximum (1.0): the steady value is 0.8 of it.
  racks.update(signals, 0, 0, false);
  const peak = Math.max(
    ...Array.from({ length: 60 }, (_, i) => {
      racks.update(signals, 0, i * 0.05, false);
      return strip();
    }),
  );
  expect(steadyA / peak).toBeCloseTo(0.8, 1);
  racks.dispose();
});

test("update marks the colour attribute for upload only when a value changed", () => {
  const racks = new RackInstances();
  racks.setRackCount(2);
  racks.update(signals, 0, 1, true);
  const version = racks.leds.instanceColor!.version;
  racks.update(signals, 0, 2, true);
  expect(racks.leds.instanceColor!.version).toBe(version);
  racks.update(signals, 0, 2, false);
  expect(racks.leds.instanceColor!.version).toBeGreaterThan(version);
  racks.dispose();
});

test("ledColor reports the strip of a drawn rack and null for an empty slot", () => {
  const racks = new RackInstances();
  racks.setRackCount(2);
  racks.update(signals, 0, 0.7, false);
  const colour = racks.ledColor(1)!;
  expect(colour[1]).toBeGreaterThan(colour[0]);
  expect(racks.ledColor(2)).toBeNull();
  racks.dispose();
});

// update() runs every frame for every hall, so it must not build a function each call (the colour
// writer used to be a closure made inside it).
test("update creates no closure per frame", () => {
  const source = RackInstances.prototype.update.toString();
  expect(source).not.toMatch(/=>/);
  expect(source).not.toMatch(/\bfunction\b/);
});
