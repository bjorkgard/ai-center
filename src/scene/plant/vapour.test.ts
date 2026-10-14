import { expect, test } from "vite-plus/test";
import { MATERIALS } from "../materials.ts";
import { RENDER } from "../render.ts";
import {
  FAN,
  VAPOUR,
  VapourLatch,
  clampDuty,
  fanTurnsPerSecond,
  particleAge,
  particleFade,
  particleRise,
  particleShown,
  particleSize,
  sortBackToFront,
  vapourDensity,
  visibleCount,
} from "./vapour.ts";
import { TOWER_COUNT } from "./plantLayout.ts";

// Linear luminance of a colour, as the bloom threshold sees it.
const luminance = (c: { r: number; g: number; b: number }) =>
  0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

test("at scene time 0 a tower shows 60 particles at duty 1 and none at duty 0 (E26)", () => {
  const latch = new VapourLatch(TOWER_COUNT * VAPOUR.perTower);
  for (const [duty, want] of [
    [1, 60],
    [0, 0],
  ] as const) {
    const fresh = new VapourLatch(TOWER_COUNT * VAPOUR.perTower);
    fresh.begin(0);
    for (let tower = 0; tower < TOWER_COUNT; tower++) {
      let shown = 0;
      for (let k = 0; k < VAPOUR.perTower; k++) {
        const i = tower * VAPOUR.perTower + k;
        if (fresh.isShown(i, particleAge(0, (i * 0.37) % VAPOUR.life), duty, false)) shown++;
      }
      expect(shown).toBe(want);
    }
    fresh.end();
  }
  expect(latch.count).toBe(180);
  expect(visibleCount(1, false)).toBe(60);
  expect(visibleCount(0, false)).toBe(0);
});

test("emission is linear in duty: particle k shows when k < 60 x duty", () => {
  expect(visibleCount(0.5, false)).toBe(30);
  expect(visibleCount(0.25, false)).toBe(15);
  expect(particleShown(29, 0.5, false)).toBe(true);
  expect(particleShown(30, 0.5, false)).toBe(false);
  expect(clampDuty(2)).toBe(1);
  expect(clampDuty(-1)).toBe(0);
  expect(clampDuty(Number.NaN)).toBe(0);
});

test("reduced motion keeps 30% of the vapour and a quarter of the fan speed", () => {
  expect(vapourDensity(1, true)).toBeCloseTo(0.3, 9);
  expect(visibleCount(1, true)).toBe(18);
  expect(visibleCount(0.5, true)).toBe(9);
  expect(visibleCount(0, true)).toBe(0);
  expect(fanTurnsPerSecond(1, true)).toBeCloseTo(fanTurnsPerSecond(1, false) * 0.25, 9);
  expect(fanTurnsPerSecond(0.4, true)).toBeCloseTo(fanTurnsPerSecond(0.4, false) * 0.25, 9);
});

test("fans turn 0.5 times a second at duty 1 and a tenth of that at duty 0, linear between", () => {
  expect(FAN.turnsPerSecond).toBe(0.5);
  expect(fanTurnsPerSecond(1, false)).toBeCloseTo(0.5, 9);
  expect(fanTurnsPerSecond(0, false)).toBeCloseTo(0.05, 9);
  expect(fanTurnsPerSecond(0.5, false)).toBeCloseTo(0.275, 9);
  // Never stopped, and faster with more duty.
  expect(fanTurnsPerSecond(0, true)).toBeGreaterThan(0);
  expect(fanTurnsPerSecond(0.8, false)).toBeGreaterThan(fanTurnsPerSecond(0.2, false));
});

test("a particle's age wraps at 6 s and its fade is in over 0.5 s and out over the last 1.5 s", () => {
  expect(particleAge(0, 2)).toBe(2);
  expect(particleAge(5, 2)).toBeCloseTo(1, 9);
  expect(particleAge(12, 0)).toBe(0);
  expect(particleAge(1, -3)).toBeCloseTo(4, 9);
  expect(particleFade(0)).toBe(0);
  expect(particleFade(0.25)).toBeCloseTo(0.5, 9);
  expect(particleFade(0.5)).toBe(1);
  expect(particleFade(3)).toBe(1);
  expect(particleFade(4.5)).toBe(1);
  expect(particleFade(5.25)).toBeCloseTo(0.5, 9);
  expect(particleFade(6)).toBe(0);
  // Both ends are invisible, so the rebirth never pops.
  expect(particleFade(0) + particleFade(VAPOUR.life)).toBe(0);
});

test("billboards grow from 1.2 to 2.4 units over the life and rise 0.6 units a second", () => {
  expect(particleSize(0)).toBeCloseTo(1.2, 9);
  expect(particleSize(3)).toBeCloseTo(1.8, 9);
  expect(particleSize(6)).toBeCloseTo(2.4, 9);
  expect(particleRise(0)).toBe(0);
  expect(particleRise(5)).toBeCloseTo(3, 9);
});

test("the sort puts the farthest particle first and is stable for equal depths", () => {
  const depths = [3, 9, 1, 9, 5];
  const order = Uint16Array.from([0, 1, 2, 3, 4]);
  sortBackToFront(depths, order);
  expect(Array.from(order)).toEqual([1, 3, 4, 0, 2]);
  // Already sorted input stays put, and a nearly sorted one is repaired.
  sortBackToFront(depths, order);
  expect(Array.from(order)).toEqual([1, 3, 4, 0, 2]);
  const moved = [3, 9, 1, 9, 6.5];
  sortBackToFront(moved, order);
  expect(Array.from(order)).toEqual([1, 3, 4, 0, 2]);
  moved[2] = 20;
  sortBackToFront(moved, order);
  expect(Array.from(order)).toEqual([2, 1, 3, 4, 0]);
});

test("the sort handles empty and single particle lists", () => {
  const none = new Uint16Array(0);
  sortBackToFront([], none);
  expect(none.length).toBe(0);
  const one = Uint16Array.from([0]);
  sortBackToFront([4], one);
  expect(Array.from(one)).toEqual([0]);
});

test("the vapour colour read from the material uniform stays under the bloom threshold, and the material blends normally (W-RW10, W-RW18)", () => {
  const material = MATERIALS.vapour;
  expect(`#${material.color.getHexString().toUpperCase()}`).toBe(VAPOUR.color.toUpperCase());
  expect(luminance(material.color)).toBeLessThan(RENDER.bloom.luminanceThreshold);
  expect(luminance(material.color)).toBeCloseTo(0.27, 1);
  // Overlaps converge to this colour, so it must be the colour that is under the threshold, not an emissive.
  expect(material.opacity).toBe(VAPOUR.opacity);
  expect(material.transparent).toBe(true);
  expect(material.depthWrite).toBe(false);
  expect(material.blending).toBe(1); // NormalBlending
});

test("a particle takes a new duty when it is reborn, and a stalled clock takes it at once", () => {
  const latch = new VapourLatch(60);
  const age = (i: number, t: number) => particleAge(t, (i * 0.1) % VAPOUR.life);
  const count = (t: number, duty: number) => {
    latch.begin(t);
    let n = 0;
    for (let i = 0; i < 60; i++) if (latch.isShown(i, age(i, t), duty, false)) n++;
    latch.end();
    return n;
  };
  expect(count(0, 1)).toBe(60);
  // Time moves and the duty drops: only particles that wrapped since the last frame go.
  const after = count(0.5, 0);
  expect(after).toBeGreaterThan(0);
  expect(after).toBeLessThan(60);
  // Within one life every particle has been reborn.
  let t = 0.5;
  while (t < 6.6) count((t += 0.25), 0);
  expect(count(6.8, 0)).toBe(0);
  // A frame with the same time (frozen) takes the change at once.
  expect(count(6.8, 1)).toBe(60);
});

test("visibleCount and particleShown agree at 0.7 and at the accumulated float 0.7000000000000001", () => {
  for (const duty of [0.7, 0.7000000000000001, 0.7 - 1e-16, 0.3 + 0.4]) {
    for (const reduced of [false, true]) {
      let shown = 0;
      for (let k = 0; k < VAPOUR.perTower; k++) if (particleShown(k, duty, reduced)) shown++;
      expect(shown).toBe(visibleCount(duty, reduced));
    }
  }
  expect(visibleCount(0.7000000000000001, false)).toBe(42);
  expect(particleShown(42, 0.7000000000000001, false)).toBe(false);
});
