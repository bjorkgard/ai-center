import { expect, test } from "vite-plus/test";
import { PACKET, packetCount, packetGap, packetTravel, wrapPhase } from "./packets.ts";

test("the packet constants are the plan's: 2.5 units/s, 1.2 apart, at most 12 a line, 25% reduced", () => {
  expect(PACKET).toMatchObject({
    speed: 2.5,
    spacing: 1.2,
    cap: 12,
    radius: 0.08,
    color: "#A5F3FC",
    defaultRate: 1,
    reducedShare: 0.25,
  });
});

test("a line holds its capped packet count: the rate's worth, at most 12, never closer than 1.2 around the loop", () => {
  // Rate 1 a second over a line 10 units long: 4 s of travel, so 4 packets.
  expect(packetCount(10, 1)).toBe(4);
  // A long line is capped at 12.
  expect(packetCount(60, 1)).toBe(12);
  expect(packetCount(60, 10)).toBe(12);
  // A short line cannot hold more than its length allows at 1.2 apart.
  expect(packetCount(3, 10)).toBe(2);
  // No rate, no packets; a tiny rate still shows one.
  expect(packetCount(60, 0)).toBe(0);
  expect(packetCount(60, 0.01)).toBe(1);
  expect(packetCount(0, 5)).toBe(0);
});

test("packet j is at 2.5 t + j L / n mod the line length, so a line is populated at scene time 0 (E26)", () => {
  expect(packetTravel(0, false)).toBe(0);
  expect(packetTravel(4, false)).toBeCloseTo(10, 9);
  expect(wrapPhase(13.6, 12)).toBeCloseTo(1.6, 9);
  expect(wrapPhase(-1, 12)).toBeCloseTo(11, 9);
  expect(wrapPhase(5, 12)).toBe(5);
  // At time 0 every line's packets are evenly spaced over its whole length, the wrap gap included,
  // and at least 1.2 apart.
  for (const length of [1.3, 2.5, 3, 10, 17.3, 40, 60, 100]) {
    for (const rate of [0.01, 1, 4, 10]) {
      const n = packetCount(length, rate);
      const at = Array.from({ length: n }, (_, j) => wrapPhase(packetGap(length, n) * j, length));
      const gaps = at.map((d, j) => (j + 1 < n ? at[j + 1] : length + at[0]) - d);
      for (const gap of gaps) {
        expect(Math.abs(gap - length / n)).toBeLessThan(1e-6);
        expect(gap).toBeGreaterThanOrEqual(PACKET.spacing - 1e-6);
      }
    }
  }
});

test("at the default rate a packet passes a fixed point about once a second", () => {
  for (const length of [10, 17.3, 25, 29]) {
    const n = packetCount(length, PACKET.defaultRate);
    expect((PACKET.speed * n) / length).toBeGreaterThanOrEqual(1 - 1e-9);
    expect((PACKET.speed * n) / length).toBeLessThan(1.5);
  }
});

test("under reduced motion a packet moves at 25% of the speed (D20)", () => {
  const normal = packetTravel(8, false) - packetTravel(0, false);
  const reduced = packetTravel(8, true) - packetTravel(0, true);
  expect(normal).toBeCloseTo(20, 9);
  expect(reduced).toBeCloseTo(normal * 0.25, 9);
  // The spacing between packets does not shrink: it is the line's, not the clock's.
  expect(packetGap(30, 12)).toBeCloseTo(2.5, 9);
});
