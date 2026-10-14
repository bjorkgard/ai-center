import { afterEach, expect, test, vi } from "vite-plus/test";
import { clearSceneLines, lastSceneLines } from "../sceneLog.ts";
import {
  displayedDuty,
  dutyOverride,
  fanTurnRate,
  liveDuty,
  reportPlant,
  resetPlantDev,
  setDuty,
  subscribePlant,
} from "./plantDev.ts";

afterEach(() => {
  resetPlantDev();
  clearSceneLines();
  vi.restoreAllMocks();
});

const quiet = () => ({
  warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  info: vi.spyOn(console, "info").mockImplementation(() => {}),
});

test("the duty starts on the fake (no override), and setDuty stores it, tells subscribers and logs one line", () => {
  const { warn } = quiet();
  expect(dutyOverride()).toBeNull();
  let calls = 0;
  const stop = subscribePlant(() => calls++);
  setDuty(0.4);
  expect(dutyOverride()).toBe(0.4);
  expect(calls).toBe(1);
  expect(lastSceneLines().filter((l) => l.includes("duty"))).toHaveLength(1);
  // The same value again changes nothing.
  setDuty(0.4);
  expect(calls).toBe(1);
  stop();
  setDuty(0.6);
  expect(calls).toBe(1);
  expect(warn).not.toHaveBeenCalled();
});

test("an out of range or NaN duty clamps to 0-1 and warns once, naming the argument", () => {
  const { warn } = quiet();
  setDuty(3);
  expect(dutyOverride()).toBe(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('"value"');
  setDuty(-0.5);
  expect(dutyOverride()).toBe(0);
  setDuty(Number.NaN);
  expect(dutyOverride()).toBe(0);
  expect(warn).toHaveBeenCalledTimes(3);
});

test("a non-number duty warns and leaves the value unchanged", () => {
  const { warn } = quiet();
  setDuty(0.4);
  for (const bad of [undefined, "0.9", null, {}]) setDuty(bad as never);
  expect(dutyOverride()).toBe(0.4);
  expect(warn).toHaveBeenCalledTimes(4);
  expect(warn.mock.calls[0][0]).toContain('"value"');
  resetPlantDev();
  setDuty(undefined as never);
  expect(dutyOverride()).toBeNull();
});

test("the HUD shows the override when set, else the live duty, else the starting value", () => {
  expect(displayedDuty(0.4, 0.8)).toBe(0.4);
  expect(displayedDuty(0, 0.8)).toBe(0);
  expect(displayedDuty(null, 0.62)).toBe(0.62);
  expect(displayedDuty(null, null)).toBe(0.75);
});

test("the plant reports its live duty and fan turn rate, and a reset clears them", () => {
  expect(liveDuty()).toBeNull();
  expect(fanTurnRate()).toBeNull();
  reportPlant(0.6, 0.3);
  expect(liveDuty()).toBe(0.6);
  expect(fanTurnRate()).toBe(0.3);
  reportPlant(0.7, null);
  expect(fanTurnRate()).toBe(0.3);
  resetPlantDev();
  expect(liveDuty()).toBeNull();
  expect(fanTurnRate()).toBeNull();
});
