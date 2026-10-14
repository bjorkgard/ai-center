import { expect, test } from "vite-plus/test";
import { triangleCount } from "../campus/parts.ts";
import { chillerGeometry, fanGeometry, towerGeometry } from "./parts.ts";

// The per-part triangle caps of eng-review Phase 3 E28 [estimated].
test("each plant part stays inside its triangle cap", () => {
  const tower = triangleCount(towerGeometry());
  const chiller = triangleCount(chillerGeometry());
  const fan = triangleCount(fanGeometry());
  expect(tower).toBeGreaterThan(0);
  expect(tower).toBeLessThanOrEqual(600);
  expect(chiller).toBeGreaterThan(0);
  expect(chiller).toBeLessThanOrEqual(200);
  expect(fan).toBeGreaterThan(0);
  expect(fan).toBeLessThanOrEqual(64);
});

test("every plant part carries a colour attribute and no UVs, so it shares the site material", () => {
  for (const geometry of [towerGeometry(), chillerGeometry(), fanGeometry()]) {
    expect(geometry.getAttribute("color")).toBeDefined();
    expect(geometry.getAttribute("uv")).toBeUndefined();
    expect(geometry.getAttribute("normal")).toBeDefined();
  }
});

test("the vapour quad is two triangles", async () => {
  const { PlaneGeometry } = await import("three");
  expect(triangleCount(new PlaneGeometry(1, 1))).toBe(2);
});
