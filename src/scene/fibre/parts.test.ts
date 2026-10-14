import { expect, test } from "vite-plus/test";
import { triangleCount } from "../campus/parts.ts";
import { buildNetwork } from "./route.ts";
import { junctionBoxGeometry, packetGeometry, tubeGeometry } from "./parts.ts";

// Per-part triangle caps (eng-review Phase 3 E28): packet 48, fibre tube 12 per 0.25 units of
// length [estimated].
test("a packet sphere is within its 48 triangle cap", () => {
  const tris = triangleCount(packetGeometry());
  expect(tris).toBeGreaterThan(0);
  expect(tris).toBeLessThanOrEqual(48);
});

test("every fibre tube of a full campus stays inside 12 triangles per 0.25 units of its length", () => {
  const net = buildNetwork(12);
  expect(net.chains.length).toBeGreaterThan(12);
  for (const chain of net.chains) {
    const tris = triangleCount(tubeGeometry([chain.rounded]));
    const length = chain.rounded.slice(1).reduce((sum, p, i) => {
      const q = chain.rounded[i];
      return sum + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }, 0);
    expect(tris).toBeGreaterThan(0);
    expect(tris).toBeLessThanOrEqual(12 * Math.ceil(length / 0.25));
  }
});

test("all the tubes of a network are one geometry, with normals and no UVs", () => {
  const net = buildNetwork(4);
  const geometry = tubeGeometry(net.chains.map((c) => c.rounded));
  expect(geometry.getAttribute("position").count).toBeGreaterThan(0);
  expect(geometry.getAttribute("normal")).toBeDefined();
  expect(geometry.getAttribute("uv")).toBeUndefined();
  expect(geometry.getIndex()).not.toBeNull();
  // Radius 0.05: no vertex is further than that from the road-level centre line.
  geometry.computeBoundingBox();
  expect(geometry.boundingBox!.min.y).toBeGreaterThan(0.03);
});

test("the junction box is a box with a colour attribute, so it shares the site material", () => {
  const box = junctionBoxGeometry();
  expect(triangleCount(box)).toBeLessThanOrEqual(12);
  expect(box.getAttribute("color")).toBeDefined();
  expect(box.getAttribute("uv")).toBeUndefined();
});
