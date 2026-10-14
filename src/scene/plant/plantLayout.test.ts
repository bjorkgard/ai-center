import { expect, test } from "vite-plus/test";
import { ZONES } from "../campus/layout.ts";
import {
  CHILLERS,
  COOLING_FRAMING,
  TOWERS,
  TOWER_COUNT,
  plantFootprints,
  vapourOrigin,
} from "./plantLayout.ts";

test("every tower and chiller stands inside the plant zone, none overlapping another", () => {
  const rects = plantFootprints();
  expect(rects).toHaveLength(TOWERS.length + CHILLERS.length);
  const zone = ZONES.plant;
  for (const r of rects) {
    expect(r.minX).toBeGreaterThanOrEqual(zone.minX);
    expect(r.maxX).toBeLessThanOrEqual(zone.maxX);
    expect(r.minZ).toBeGreaterThanOrEqual(zone.minZ);
    expect(r.maxZ).toBeLessThanOrEqual(zone.maxZ);
  }
  rects.forEach((a, i) =>
    rects.slice(i + 1).forEach((b) => {
      const overlap = a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
      expect(overlap).toBe(false);
    }),
  );
});

test("vapour rises from the top of each tower, and a tower that does not exist throws", () => {
  expect(TOWER_COUNT).toBe(3);
  for (let t = 0; t < TOWER_COUNT; t++) {
    expect(vapourOrigin(t)).toMatchObject({ x: TOWERS[t].x, z: TOWERS[t].z });
    expect(vapourOrigin(t).y).toBeGreaterThan(3);
  }
  expect(() => vapourOrigin(TOWER_COUNT)).toThrow(RangeError);
});

test("the cooling view is centred on the plant zone", () => {
  expect(COOLING_FRAMING.target[0]).toBe((ZONES.plant.minX + ZONES.plant.maxX) / 2);
  expect(COOLING_FRAMING.target[2]).toBe((ZONES.plant.minZ + ZONES.plant.maxZ) / 2);
});
