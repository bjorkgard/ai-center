import { Box3, type BufferGeometry } from "three";
import { expect, test } from "vite-plus/test";
import { ROADS, ZONES, type Rect } from "./layout.ts";
import {
  MONUMENT,
  carGeometry,
  dockParts,
  fenceBayGeometry,
  furnitureGeometry,
  gateParts,
  lampHeadGeometry,
  lampPostGeometry,
  monumentParts,
  padGeometry,
  roadGeometry,
  treeGeometry,
  triangleCount,
} from "./parts.ts";

const triangles = (parts: BufferGeometry[]) => parts.reduce((sum, p) => sum + triangleCount(p), 0);

// The per-part triangle caps of eng-review Phase 3 E28 [estimated].
test("each part stays inside its triangle cap", () => {
  expect(triangleCount(carGeometry())).toBeGreaterThan(0);
  expect(triangleCount(carGeometry())).toBeLessThanOrEqual(120);
  expect(triangleCount(lampPostGeometry()) + triangleCount(lampHeadGeometry())).toBeLessThanOrEqual(
    60,
  );
  expect(triangleCount(treeGeometry())).toBeLessThanOrEqual(60);
  expect(triangleCount(fenceBayGeometry())).toBeLessThanOrEqual(24);
  expect(triangles(gateParts())).toBeLessThanOrEqual(400);
  expect(triangles(dockParts())).toBeLessThanOrEqual(600);
  expect(triangles(monumentParts())).toBeLessThanOrEqual(100);
  for (const part of [gateParts(), dockParts(), monumentParts()]) {
    expect(triangles(part)).toBeGreaterThan(0);
  }
});

test("the tree is one geometry with a colour attribute: trunk and canopy in two colours", () => {
  const tree = treeGeometry();
  const colour = tree.getAttribute("color");
  expect(colour).toBeDefined();
  const seen = new Set<string>();
  for (let i = 0; i < colour.count; i++) {
    seen.add([colour.getX(i), colour.getY(i), colour.getZ(i)].map((v) => v.toFixed(4)).join(","));
  }
  expect(seen.size).toBe(2);
  tree.computeBoundingBox();
  expect(tree.boundingBox!.min.y).toBeCloseTo(0, 6);
});

test("the car has a colour attribute so each instance can take one of three greys", () => {
  const car = carGeometry();
  expect(car.getAttribute("color")).toBeDefined();
  car.computeBoundingBox();
  const box = car.boundingBox!;
  expect(box.min.y).toBeCloseTo(0, 6);
  // About 4.5 m long and 1.8 m wide at 1.8 m to the unit.
  expect(box.max.z - box.min.z).toBeGreaterThan(2);
  expect(box.max.x - box.min.x).toBeLessThan(1.4);
});

const bounds = (parts: BufferGeometry[]): Rect & { maxY: number } => {
  const box = new Box3();
  for (const p of parts) {
    p.computeBoundingBox();
    box.union(p.boundingBox!);
  }
  return { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, maxY: box.max.y };
};

const within = (inner: Rect, outer: Rect) =>
  inner.minX >= outer.minX - 1e-6 &&
  inner.maxX <= outer.maxX + 1e-6 &&
  inner.minZ >= outer.minZ - 1e-6 &&
  inner.maxZ <= outer.maxZ + 1e-6;

test("the gate, the dock and the monument stand inside their zones", () => {
  expect(within(bounds(gateParts()), ZONES.gate)).toBe(true);
  expect(within(bounds(dockParts()), ZONES.dock)).toBe(true);
  expect(within(bounds(monumentParts()), ZONES.gate)).toBe(true);
});

test("the monument's panel sits in front of its slab and stays inside it", () => {
  const slab = bounds(monumentParts());
  expect(MONUMENT.panelWidth).toBeLessThanOrEqual(slab.maxX - slab.minX);
  expect(MONUMENT.centre.z).toBeGreaterThan(slab.minZ);
  expect(MONUMENT.centre.y + MONUMENT.panelHeight / 2).toBeLessThan(slab.maxY);
  // The gate road stays clear of the monument.
  const road = ROADS.find((r) => r.minX < 0 && r.maxX > 0 && r.maxZ >= ZONES.gate.maxZ)!;
  expect(slab.minX).toBeGreaterThan(road.maxX);
});

test("the road mesh, the pad and the furniture merge into one geometry each, with colours", () => {
  for (const g of [roadGeometry(), furnitureGeometry(), padGeometry()]) {
    expect(g.getAttribute("color")).toBeDefined();
    expect(g.getAttribute("position").count).toBeGreaterThan(0);
  }
  // Furniture and roads each draw once: the gate, dock and monument are not separate meshes.
  expect(triangleCount(furnitureGeometry())).toBe(
    triangles(gateParts()) + triangles(dockParts()) + triangles(monumentParts()),
  );
});

test("the fence bay is a post and a panel centred on its own origin", () => {
  const bay = fenceBayGeometry();
  bay.computeBoundingBox();
  const box = bay.boundingBox!;
  expect(box.min.x).toBeLessThan(0);
  expect(box.max.x).toBeGreaterThan(0);
  expect(box.min.y).toBeCloseTo(0, 6);
  expect(box.max.x - box.min.x).toBeLessThanOrEqual(2.001);
});

test("the gate's stop line is painted once, in the road mesh, not again in the furniture", () => {
  const flat = gateParts().filter((p) => {
    p.computeBoundingBox();
    const box = p.boundingBox!;
    return box.max.y < 0.06 && box.min.z > 22 && box.max.z < 22.8;
  });
  expect(flat).toHaveLength(0);
});
