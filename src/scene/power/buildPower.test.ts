import { Mesh } from "three";
import { expect, test, vi } from "vite-plus/test";
import { triangleCount } from "../campus/parts.ts";
import { ZONES } from "../campus/layout.ts";
import { MATERIALS } from "../materials.ts";
import { buildPower } from "./buildPower.ts";

test("the power yard is one shadow-casting mesh on the site material, inside the power zone", () => {
  const power = buildPower();
  const meshes = power.group.children as Mesh[];
  expect(meshes).toHaveLength(1);
  expect(meshes[0].material).toBe(MATERIALS.site);
  // Transformers, generators and tanks cast shadows (CEO W-RW23).
  expect(meshes[0].castShadow).toBe(true);
  expect(meshes[0].receiveShadow).toBe(true);
  // Every part is in it: well over a thousand triangles, far under any budget.
  const tris = triangleCount(meshes[0].geometry);
  expect(tris).toBeGreaterThan(1000);
  expect(tris).toBeLessThan(6000);
  meshes[0].geometry.computeBoundingBox();
  const box = meshes[0].geometry.boundingBox!;
  expect(box.min.x).toBeGreaterThanOrEqual(ZONES.power.minX);
  expect(box.max.x).toBeLessThanOrEqual(ZONES.power.maxX);
  expect(box.min.z).toBeGreaterThanOrEqual(ZONES.power.minZ);
  expect(box.max.z).toBeLessThanOrEqual(ZONES.power.maxZ);
  power.dispose();
});

test("disposing frees the geometry", () => {
  const power = buildPower();
  const spy = vi.fn();
  (power.group.children[0] as Mesh).geometry.addEventListener("dispose", spy);
  power.dispose();
  expect(spy).toHaveBeenCalledTimes(1);
});
