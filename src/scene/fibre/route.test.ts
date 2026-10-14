import { expect, test } from "vite-plus/test";
import { SLOT_COUNT, hallDoor, hallFootprint, type Rect } from "../campus/layout.ts";
import { VAULT } from "../power/powerLayout.ts";
import { FIBRE, buildNetwork, pathLength, roundPath, type Vec3 } from "./route.ts";

// Samples a polyline every 5 cm and reports whether any sample lies inside a rect.
function crosses(points: readonly Vec3[], rect: Rect): boolean {
  for (let i = 1; i < points.length; i++) {
    const [ax, , az] = points[i - 1];
    const [bx, , bz] = points[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.05));
    for (let s = 0; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps;
      const z = az + ((bz - az) * s) / steps;
      if (
        x > rect.minX + 1e-6 &&
        x < rect.maxX - 1e-6 &&
        z > rect.minZ + 1e-6 &&
        z < rect.maxZ - 1e-6
      ) {
        return true;
      }
    }
  }
  return false;
}

test("only placed halls get a line, one per slot in order, and A and B always have one", () => {
  expect(buildNetwork(2).lines.map((l) => l.slot)).toEqual([0, 1]);
  expect(buildNetwork(5).lines.map((l) => l.slot)).toEqual([0, 1, 2, 3, 4]);
  expect(buildNetwork(SLOT_COUNT).lines).toHaveLength(12);
  expect(() => buildNetwork(1)).toThrow(RangeError);
  expect(() => buildNetwork(13)).toThrow(RangeError);
});

test("every line starts at the vault and reaches its hall's door side", () => {
  const net = buildNetwork(SLOT_COUNT);
  for (const line of net.lines) {
    const first = line.rounded[0];
    const last = line.rounded[line.rounded.length - 1];
    // The vault's east face is where the fibre leaves.
    expect(first[0]).toBeGreaterThan(VAULT.x);
    expect(first[0]).toBeLessThanOrEqual(VAULT.x + VAULT.width / 2);
    // The end climbs the front wall beside the door (0.8 along): it is within a unit of the door's z, over the door's width and
    // 0.6 above where it lay on the road.
    const door = hallDoor(line.slot);
    expect(last[2]).toBeGreaterThan(door.z);
    expect(last[2] - door.z).toBeLessThan(1);
    expect(Math.abs(last[0] - (door.x + 0.8))).toBeLessThan(0.3);
    expect(first[1]).toBeCloseTo(FIBRE.y, 9);
    expect(last[1]).toBeCloseTo(FIBRE.y + FIBRE.climb, 9);
  }
});

test("no line crosses any hall footprint, placed or not", () => {
  const net = buildNetwork(SLOT_COUNT);
  const halls = Array.from({ length: SLOT_COUNT }, (_, i) => hallFootprint(i));
  for (const line of net.lines) {
    for (const [i, hall] of halls.entries()) {
      expect(crosses(line.rounded, hall), `line ${line.slot} through hall ${i}`).toBe(false);
      expect(crosses(line.points, hall), `corners of line ${line.slot} through hall ${i}`).toBe(
        false,
      );
    }
  }
});

test("lines are laid 0.03 above the road, 0.4 in from the kerb, on the road grid, with right-angle corners", () => {
  expect(FIBRE).toMatchObject({ radius: 0.05, lift: 0.03, kerbInset: 0.4, bend: 0.6, climb: 0.6 });
  expect(FIBRE.y).toBeCloseTo(0.03 + 0.03 + 0.05, 9);
  const net = buildNetwork(SLOT_COUNT);
  for (const line of net.lines) {
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1];
      const b = line.points[i];
      // Each leg runs along exactly one axis.
      const axes = [0, 1, 2].filter((k) => Math.abs(a[k] - b[k]) > 1e-9);
      expect(axes).toHaveLength(1);
    }
  }
  // The first leg of every line lies 0.4 from the kerb of the road in front of row 0 (z 12-15).
  expect(net.lines[0].points[0][2]).toBeCloseTo(12.4, 9);
});

test("bends are rounded: the rounded path is a little shorter than its corners and never a right angle", () => {
  const net = buildNetwork(SLOT_COUNT);
  for (const line of net.lines) {
    expect(pathLength(line.rounded)).toBeLessThan(pathLength(line.points) + 1e-9);
    expect(pathLength(line.rounded)).toBeCloseTo(line.length, 9);
    expect(line.rounded.length).toBeGreaterThan(line.points.length);
  }
  // One corner of radius 0.6 between two long legs: the arc replaces the corner.
  const square: Vec3[] = [
    [0, 0, 0],
    [5, 0, 0],
    [5, 0, 5],
  ];
  const rounded = roundPath(square, [false, false, false], 0.6);
  expect(rounded[0]).toEqual([0, 0, 0]);
  expect(rounded[rounded.length - 1]).toEqual([5, 0, 5]);
  expect(pathLength(rounded)).toBeCloseTo(10 - 2 * 0.6 + (Math.PI / 2) * 0.6, 1);
  // A corner marked sharp (a junction) is kept.
  expect(roundPath(square, [false, true, false], 0.6)).toEqual(square);
  // A leg too short for the bend clamps the radius to half of it.
  const tight = roundPath(
    [
      [0, 0, 0],
      [0.4, 0, 0],
      [0.4, 0, 3],
    ],
    [false, false, false],
    0.6,
  );
  expect(tight.every((p) => p[0] <= 0.4 + 1e-9 && p[2] >= -1e-9)).toBe(true);
});

test("lines share their trunk: one tube per branch, a junction box where lines branch, and the same paths for the same hall set", () => {
  const two = buildNetwork(2);
  const twelve = buildNetwork(12);
  expect(two.chains.length).toBeLessThan(twelve.chains.length);
  // Every junction has three or more branches.
  expect(twelve.junctions.length).toBeGreaterThan(two.junctions.length);
  // The total tube length is far under the sum of the line lengths (a shared trunk).
  const tubes = twelve.chains.reduce((sum, chain) => sum + pathLength(chain.rounded), 0);
  const lines = twelve.lines.reduce((sum, line) => sum + line.length, 0);
  expect(tubes).toBeLessThan(lines * 0.7);
  expect(buildNetwork(12).lines[7].points).toEqual(twelve.lines[7].points);
  // Hall B (slot 1) is in both and takes the same road either way: the same ends and the same
  // length between corners (more halls only add junction vertices along it).
  const [b2, b12] = [two.lines[1], twelve.lines[1]];
  expect(b2.points[0]).toEqual(b12.points[0]);
  expect(b2.points[b2.points.length - 1]).toEqual(b12.points[b12.points.length - 1]);
  expect(pathLength(b2.points)).toBeCloseTo(pathLength(b12.points), 9);
});

test("every hall's line ends in an entry box at the top of its climb", () => {
  const net = buildNetwork(6);
  expect(net.entries).toHaveLength(6);
  net.entries.forEach((entry, i) => {
    expect(entry.slot).toBe(i);
    expect(entry.y).toBeCloseTo(FIBRE.y + FIBRE.climb, 9);
  });
});
