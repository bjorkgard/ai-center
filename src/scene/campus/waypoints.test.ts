import { expect, test } from "vite-plus/test";
import { SLOT_COUNT, hallDoor, hallFootprint, type Rect } from "./layout.ts";
import { buildWaypoints, findPath, segmentCrossesRect } from "./waypoints.ts";

const graph = buildWaypoints();
const slots = Array.from({ length: SLOT_COUNT }, (_, i) => i);

test("the graph names the gate, the dock and every hall door", () => {
  const ids = new Set(graph.nodes.map((n) => n.id));
  expect(ids.has("gate")).toBe(true);
  expect(ids.has("dock")).toBe(true);
  for (const i of slots) {
    expect(ids.has(`door-${i}`)).toBe(true);
    const node = graph.nodes.find((n) => n.id === `door-${i}`)!;
    expect(node.x).toBeCloseTo(hallDoor(i).x, 9);
    expect(node.z).toBeGreaterThanOrEqual(hallDoor(i).z);
  }
  expect(ids.size).toBe(graph.nodes.length);
});

test("the graph is connected", () => {
  const seen = new Set<string>([graph.nodes[0].id]);
  const queue = [graph.nodes[0].id];
  while (queue.length > 0) {
    const id = queue.pop()!;
    for (const [a, b] of graph.edges) {
      const next = a === id ? b : b === id ? a : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  expect(seen.size).toBe(graph.nodes.length);
});

test("every edge joins two known nodes", () => {
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const [a, b] of graph.edges) {
    expect(ids.has(a)).toBe(true);
    expect(ids.has(b)).toBe(true);
    expect(a).not.toBe(b);
  }
});

test("there is a path from the gate to the dock and from the gate to every hall door", () => {
  const dock = findPath(graph, "gate", "dock");
  expect(dock).not.toBeNull();
  expect(dock![0]).toBe("gate");
  expect(dock![dock!.length - 1]).toBe("dock");
  for (const i of slots) {
    const path = findPath(graph, "gate", `door-${i}`);
    expect(path, `door ${i}`).not.toBeNull();
    expect(path![path!.length - 1]).toBe(`door-${i}`);
  }
  expect(findPath(graph, "gate", "nowhere")).toBeNull();
});

test("no edge crosses a hall footprint", () => {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const [a, b] of graph.edges) {
    const p = byId.get(a)!;
    const q = byId.get(b)!;
    for (const i of slots) {
      expect(segmentCrossesRect(p, q, hallFootprint(i)), `${a}-${b} vs hall ${i}`).toBe(false);
    }
  }
});

test("the crossing test sees an edge through a rectangle and one beside it", () => {
  const box: Rect = { minX: 0, maxX: 2, minZ: 0, maxZ: 2 };
  expect(segmentCrossesRect({ x: -1, z: 1 }, { x: 3, z: 1 }, box)).toBe(true);
  expect(segmentCrossesRect({ x: -1, z: 3 }, { x: 3, z: 3 }, box)).toBe(false);
  expect(segmentCrossesRect({ x: 1, z: -1 }, { x: 1, z: 1 }, box)).toBe(true);
  expect(segmentCrossesRect({ x: 3, z: 3 }, { x: 4, z: 4 }, box)).toBe(false);
});
