import { expect, test } from "vite-plus/test";
import { HALL } from "../hall/hallLayout.ts";
import {
  CAMPUS_EXTENT,
  GRID,
  PAD,
  ROADS,
  SLOT_COUNT,
  ZONES,
  campusBounds,
  campusHome,
  fenceBays,
  groundArea,
  hallDoor,
  hallFootprint,
  lampSpots,
  parkedCars,
  padRect,
  shadowRadius,
  slotPosition,
  treeSpots,
  type Rect,
} from "./layout.ts";

const overlaps = (a: Rect, b: Rect) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
const inside = (inner: Rect, outer: Rect) =>
  inner.minX >= outer.minX &&
  inner.maxX <= outer.maxX &&
  inner.minZ >= outer.minZ &&
  inner.maxZ <= outer.maxZ;
const slots = Array.from({ length: SLOT_COUNT }, (_, i) => i);
const zones = Object.entries(ZONES) as [string, Rect][];

test("twelve slots on a 4 x 3 grid at pitch 11 x 9, A and B first in the front row nearest the gate", () => {
  expect(SLOT_COUNT).toBe(12);
  expect(GRID).toMatchObject({ cols: 4, rows: 3, pitchX: 11, pitchZ: 9 });
  const a = slotPosition(0);
  const b = slotPosition(1);
  expect(b.x - a.x).toBe(11);
  expect(b.z).toBe(a.z);
  // The gate sits at the largest z: every other row is further back (smaller z).
  for (const i of slots.slice(2)) expect(slotPosition(i).z).toBeLessThanOrEqual(a.z);
  expect(slotPosition(4).z).toBe(a.z - 9);
  expect(slotPosition(11).z).toBe(a.z - 18);
  const unique = new Set(slots.map((i) => `${slotPosition(i).x},${slotPosition(i).z}`));
  expect(unique.size).toBe(12);
  expect(slotPosition(0)).toEqual(slotPosition(0));
});

test("a slot outside 0-11 is refused", () => {
  for (const bad of [-1, 12, 1.5, Number.NaN]) {
    expect(() => slotPosition(bad), String(bad)).toThrow(RangeError);
  }
});

test("every hall door faces the road in front of its hall, on the +z side", () => {
  for (const i of slots) {
    const { x, z } = slotPosition(i);
    const door = hallDoor(i);
    expect(door.x).toBe(x);
    expect(door.z).toBeCloseTo(z + HALL.depth / 2, 9);
  }
});

test("every slot and every zone lies inside the campus bounds and the extent", () => {
  const { halfX, halfZ } = campusBounds();
  const box: Rect = { minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ };
  for (const i of slots) {
    expect(inside(hallFootprint(i), box), `slot ${i}`).toBe(true);
    expect(inside(hallFootprint(i), CAMPUS_EXTENT), `slot ${i}`).toBe(true);
  }
  for (const [name, zone] of zones) {
    expect(inside(zone, box), name).toBe(true);
    expect(inside(zone, CAMPUS_EXTENT), name).toBe(true);
  }
  expect(campusBounds().halfX).toBeGreaterThan(0);
  expect(campusBounds().halfZ).toBeGreaterThan(0);
});

test("slots do not overlap each other or any zone", () => {
  for (const i of slots) {
    for (const j of slots.slice(i + 1)) {
      expect(overlaps(hallFootprint(i), hallFootprint(j)), `${i} vs ${j}`).toBe(false);
    }
    for (const [name, zone] of zones) {
      expect(overlaps(hallFootprint(i), zone), `slot ${i} vs ${name}`).toBe(false);
    }
  }
  for (let i = 0; i < zones.length; i++) {
    for (const [name, zone] of zones.slice(i + 1)) {
      expect(overlaps(zones[i][1], zone), `${zones[i][0]} vs ${name}`).toBe(false);
    }
  }
});

test("pads fit the cell and leave the 3-unit road between neighbours", () => {
  for (const i of slots) {
    const pad = padRect(i);
    expect(inside(hallFootprint(i), pad)).toBe(true);
    expect(pad.maxX - pad.minX).toBeCloseTo(PAD.width, 9);
    for (const j of slots.slice(i + 1)) expect(overlaps(pad, padRect(j))).toBe(false);
  }
});

test("roads run between the halls and never cross a hall footprint", () => {
  expect(ROADS.length).toBeGreaterThan(8);
  for (const road of ROADS) {
    for (const i of slots) expect(overlaps(road, hallFootprint(i))).toBe(false);
    expect(inside(road, CAMPUS_EXTENT)).toBe(true);
  }
});

test("the home frame is the placed halls plus the plant, power and gate zones, and widens with each hall", () => {
  const two = campusHome(2);
  for (const i of [0, 1]) expect(inside(hallFootprint(i), two)).toBe(true);
  for (const zone of [ZONES.plant, ZONES.power, ZONES.gate]) expect(inside(zone, two)).toBe(true);
  // Not the dock and parking: they stay outside the startup frame.
  expect(inside(ZONES.dock, two)).toBe(false);
  expect(inside(ZONES.parking, two)).toBe(false);
  const three = campusHome(3);
  expect(three.maxX).toBeGreaterThan(two.maxX);
  expect(inside(two, three)).toBe(true);
  const all = campusHome(12);
  for (const i of slots) expect(inside(hallFootprint(i), all)).toBe(true);
  expect(two.maxY).toBeGreaterThan(0);
});

test("the home frame refuses a placed count outside 2-12", () => {
  for (const bad of [1, 13, 2.5, Number.NaN]) expect(() => campusHome(bad)).toThrow(RangeError);
});

test("ground and shadow sizes come from the extent", () => {
  const ground = groundArea();
  expect(ground.width).toBeGreaterThan(CAMPUS_EXTENT.maxX - CAMPUS_EXTENT.minX);
  expect(ground.depth).toBeGreaterThan(CAMPUS_EXTENT.maxZ - CAMPUS_EXTENT.minZ);
  const corner = Math.hypot(campusBounds().halfX, campusBounds().halfZ);
  expect(shadowRadius()).toBeGreaterThanOrEqual(corner);
});

test("the fence follows the perimeter and is open at the gate", () => {
  const bays = fenceBays();
  expect(bays.length).toBeGreaterThan(60);
  const gap = ZONES.gate;
  const spine = ROADS.find((r) => r.minX < 0 && r.maxX > 0 && r.maxZ >= CAMPUS_EXTENT.maxZ)!;
  expect(spine).toBeDefined();
  for (const bay of bays) {
    const onEdge =
      Math.abs(bay.x - CAMPUS_EXTENT.minX) < 1e-9 ||
      Math.abs(bay.x - CAMPUS_EXTENT.maxX) < 1e-9 ||
      Math.abs(bay.z - CAMPUS_EXTENT.minZ) < 1e-9 ||
      Math.abs(bay.z - CAMPUS_EXTENT.maxZ) < 1e-9;
    expect(onEdge).toBe(true);
    // No bay stands across the gate road.
    expect(bay.z >= CAMPUS_EXTENT.maxZ - 1e-9 && bay.x > spine.minX && bay.x < spine.maxX).toBe(
      false,
    );
  }
  expect(gap.maxZ).toBeLessThanOrEqual(CAMPUS_EXTENT.maxZ);
});

test("trees are seeded, stay off roads, halls, zones and the gate gap", () => {
  const trees = treeSpots(1);
  expect(trees.length).toBeGreaterThanOrEqual(30);
  expect(treeSpots(1)).toEqual(trees);
  expect(treeSpots(2)).not.toEqual(trees);
  for (const t of trees) {
    const dot: Rect = { minX: t.x - 0.5, maxX: t.x + 0.5, minZ: t.z - 0.5, maxZ: t.z + 0.5 };
    expect(inside(dot, CAMPUS_EXTENT)).toBe(true);
    for (const road of ROADS) expect(overlaps(dot, road), `road at ${t.x},${t.z}`).toBe(false);
    for (const i of slots) expect(overlaps(dot, padRect(i)), `pad ${i}`).toBe(false);
    for (const [name, zone] of zones) expect(overlaps(dot, zone), name).toBe(false);
    expect(t.scale).toBeGreaterThanOrEqual(0.8);
    expect(t.scale).toBeLessThanOrEqual(1.3);
  }
});

test("parked cars are seeded, sit inside the parking zone and do not overlap", () => {
  const cars = parkedCars(1);
  expect(cars.length).toBeGreaterThanOrEqual(10);
  expect(parkedCars(1)).toEqual(cars);
  const keys = new Set(cars.map((c) => `${c.x},${c.z}`));
  expect(keys.size).toBe(cars.length);
  for (const c of cars) {
    expect(c.x).toBeGreaterThan(ZONES.parking.minX);
    expect(c.x).toBeLessThan(ZONES.parking.maxX);
    expect(c.z).toBeGreaterThan(ZONES.parking.minZ);
    expect(c.z).toBeLessThan(ZONES.parking.maxZ);
    expect([0, 1, 2]).toContain(c.shade);
  }
});

test("lamps stand along the road grid, none on a hall", () => {
  const lamps = lampSpots();
  expect(lamps.length).toBeGreaterThanOrEqual(20);
  for (const l of lamps) {
    for (const i of slots) {
      const f = hallFootprint(i);
      expect(l.x > f.minX && l.x < f.maxX && l.z > f.minZ && l.z < f.maxZ).toBe(false);
    }
  }
});
