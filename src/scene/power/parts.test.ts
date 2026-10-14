import { expect, test } from "vite-plus/test";
import { triangleCount } from "../campus/parts.ts";
import {
  generatorGeometry,
  tankGeometry,
  transformerGeometry,
  vaultGeometry,
  yardFenceGeometry,
} from "./parts.ts";

// Per-part triangle caps, in the chunk that adds each part (eng-review Phase 3 E28) [estimated]:
// transformer 200, generator 300, tank 150, vault 100, fence bay 24.
test("each power part stays inside its triangle cap", () => {
  const caps: [string, () => ReturnType<typeof tankGeometry>, number][] = [
    ["transformer", transformerGeometry, 200],
    ["generator", generatorGeometry, 300],
    ["tank", tankGeometry, 150],
    ["vault", vaultGeometry, 100],
  ];
  for (const [name, build, cap] of caps) {
    const tris = triangleCount(build());
    expect(tris, name).toBeGreaterThan(0);
    expect(tris, name).toBeLessThanOrEqual(cap);
  }
});

test("the substation fence is 24 triangles a bay", () => {
  const { geometry, bays } = yardFenceGeometry();
  expect(bays).toBeGreaterThan(10);
  expect(triangleCount(geometry) / bays).toBeLessThanOrEqual(24);
});

test("every power part carries a colour attribute and no UVs, so it shares the site material", () => {
  for (const geometry of [
    transformerGeometry(),
    generatorGeometry(),
    tankGeometry(),
    vaultGeometry(),
    yardFenceGeometry().geometry,
  ]) {
    expect(geometry.getAttribute("color")).toBeDefined();
    expect(geometry.getAttribute("uv")).toBeUndefined();
    expect(geometry.getAttribute("normal")).toBeDefined();
  }
});

test("a generator has an exhaust stack above its housing", () => {
  const geometry = generatorGeometry();
  geometry.computeBoundingBox();
  expect(geometry.boundingBox!.max.y).toBeGreaterThan(2);
});
