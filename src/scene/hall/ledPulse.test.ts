import { expect, test } from "vite-plus/test";
import { PULSE, REDUCED_MOTION_LEVEL, ledLevel, pulsePeriod } from "./ledPulse.ts";

test("the period runs from 3.0 s at no load to 1.2 s at full load", () => {
  expect(pulsePeriod(0.0001)).toBeCloseTo(PULSE.slowPeriod, 2);
  expect(pulsePeriod(1)).toBe(PULSE.fastPeriod);
  expect(PULSE.slowPeriod).toBe(3);
  expect(PULSE.fastPeriod).toBe(1.2);
  expect(pulsePeriod(0.5)).toBeGreaterThan(PULSE.fastPeriod);
  expect(pulsePeriod(0.5)).toBeLessThan(PULSE.slowPeriod);
  expect(pulsePeriod(7)).toBe(PULSE.fastPeriod);
});

test("the level stays between 0.6 and 1.0 for any load, phase and time", () => {
  let min = 1;
  let max = 0;
  for (let load = 0.05; load <= 1; load += 0.05) {
    for (let phase = 0; phase < 1; phase += 0.1) {
      for (let t = 0; t < 12; t += 0.05) {
        const level = ledLevel(load, phase, t, false);
        min = Math.min(min, level);
        max = Math.max(max, level);
      }
    }
  }
  expect(min).toBeGreaterThanOrEqual(0.6 - 1e-9);
  expect(max).toBeLessThanOrEqual(1 + 1e-9);
  expect(min).toBeLessThan(0.62);
  expect(max).toBeGreaterThan(0.98);
});

test("the level is periodic, and moves over time", () => {
  const period = pulsePeriod(0.6);
  expect(ledLevel(0.6, 0.2, 1.3, false)).toBeCloseTo(ledLevel(0.6, 0.2, 1.3 + period, false), 9);
  expect(ledLevel(0.6, 0.2, 0, false)).not.toBeCloseTo(ledLevel(0.6, 0.2, period / 4, false), 3);
});

test("under reduced motion every LED holds a steady 0.8 of its level", () => {
  expect(REDUCED_MOTION_LEVEL).toBe(0.8);
  for (const t of [0, 0.4, 1.1, 5, 99]) {
    expect(ledLevel(0.9, 0.3, t, true)).toBe(0.8);
    expect(ledLevel(0.1, 0.7, t, true)).toBe(0.8);
  }
});

test("a rack with no load holds steady at full level", () => {
  expect(ledLevel(0, 0, 0, false)).toBe(1);
  expect(ledLevel(0, 0.5, 3.3, false)).toBe(1);
});
