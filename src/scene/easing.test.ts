import { expect, test } from "vite-plus/test";
import { cubicBezier, ease } from "./easing.ts";

test("the D20 easing starts at 0, ends at 1 and clamps outside", () => {
  expect(ease(0)).toBe(0);
  expect(ease(1)).toBe(1);
  expect(ease(-1)).toBe(0);
  expect(ease(2)).toBe(1);
});

test("the D20 easing is monotonic and ease-out (fast start, soft stop)", () => {
  let last = 0;
  for (let i = 1; i <= 100; i++) {
    const v = ease(i / 100);
    expect(v).toBeGreaterThanOrEqual(last);
    last = v;
  }
  expect(ease(0.1)).toBeGreaterThan(0.3);
  expect(ease(0.5)).toBeGreaterThan(0.85);
});

test("a linear bezier is the identity", () => {
  const linear = cubicBezier(0, 0, 1, 1);
  for (const t of [0.1, 0.25, 0.5, 0.9]) expect(linear(t)).toBeCloseTo(t, 5);
});
