import { afterEach, expect, test, vi } from "vite-plus/test";
import type { SceneSignals } from "../signals.ts";
import {
  isFakeLoad,
  ledColor,
  rackOverride,
  registerLeds,
  reportShown,
  resetRacksDev,
  setFakeLoad,
  setRackCount,
  shownCount,
  subscribeRacks,
  withDevOverrides,
} from "./racksDev.ts";

afterEach(() => {
  resetRacksDev();
  vi.restoreAllMocks();
});

const warnings = () => vi.spyOn(console, "warn").mockImplementation(() => {});

test("setRackCount stores a valid count for a hall and tells subscribers", () => {
  const warn = warnings();
  const seen: number[] = [];
  const stop = subscribeRacks(() => seen.push(rackOverride(2) ?? -1));
  setRackCount(2, 9);
  expect(rackOverride(2)).toBe(9);
  expect(rackOverride(3)).toBeNull();
  expect(seen).toEqual([9]);
  setRackCount(2, 9);
  expect(seen).toEqual([9]);
  expect(warn).not.toHaveBeenCalled();
  stop();
});

test("out of range, fractional and NaN counts clamp to 0-16, with one warning naming the argument", () => {
  const warn = warnings();
  const cases: [number, number][] = [
    [99, 16],
    [-3, 0],
    [4.6, 5],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 16],
  ];
  for (const [input, want] of cases) {
    warn.mockClear();
    setRackCount(0, input);
    expect(rackOverride(0)).toBe(want);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"n"');
  }
});

test("the hall argument clamps to 0-11 and warns naming it", () => {
  const warn = warnings();
  setRackCount(40, 5);
  expect(rackOverride(11)).toBe(5);
  expect(String(warn.mock.calls[0][0])).toContain('"hall"');
  warn.mockClear();
  setRackCount(Number.NaN, 6);
  expect(rackOverride(0)).toBe(6);
  expect(warn).toHaveBeenCalledTimes(1);
});

test("setFakeLoad takes a boolean; anything else warns and changes nothing", () => {
  const warn = warnings();
  expect(isFakeLoad()).toBe(true);
  setFakeLoad(false);
  expect(isFakeLoad()).toBe(false);
  setFakeLoad("yes" as never);
  expect(isFakeLoad()).toBe(false);
  expect(String(warn.mock.calls[0][0])).toContain('"on"');
});

test("the shown count is what the hall last reported", () => {
  expect(shownCount(1)).toBe(0);
  reportShown(1, 12);
  expect(shownCount(1)).toBe(12);
});

const base: SceneSignals = {
  rackCount: () => 4,
  ledLoad: () => ({ status: "tool", blades: ["tool"], load: 0.5, phase: 0.1 }),
  hallSign: () => ({ letter: "A", project: "Northwind" }),
  duty: () => 0.5,
  vapourPhase: () => 1,
  fanAngle: () => 0,
};

test("dev overrides win over the base signals; fake load off shows idle racks", () => {
  warnings();
  const signals = withDevOverrides(base);
  expect(signals.rackCount(0)).toBe(4);
  setRackCount(0, 11);
  expect(signals.rackCount(0)).toBe(11);
  expect(signals.rackCount(1)).toBe(4);
  expect(signals.ledLoad(0, 0).status).toBe("tool");
  setFakeLoad(false);
  const idle = signals.ledLoad(0, 0);
  expect(idle.status).toBe("idle");
  expect(idle.blades).toHaveLength(0);
  expect(idle.load).toBe(0);
  expect(signals.hallSign(0).project).toBe("Northwind");
  expect([signals.duty(), signals.vapourPhase(0), signals.fanAngle(0)]).toEqual([0.5, 1, 0]);
});

test("ledColor reads the strip colour a mounted hall registered, and null for anything else", () => {
  warnings();
  const stop = registerLeds(1, { ledColor: (rack) => (rack === 2 ? [0.1, 0.2, 0.3] : null) });
  expect(ledColor(1, 2)).toEqual([0.1, 0.2, 0.3]);
  expect(ledColor(1, 3)).toBeNull();
  expect(ledColor(5, 2)).toBeNull();
  stop();
  expect(ledColor(1, 2)).toBeNull();
});

test("the dev overrides pass reduced motion on to the base fan angle", () => {
  const signals = withDevOverrides({ ...base, fanAngle: (_, reduced) => (reduced ? 1 : 2) });
  expect(signals.fanAngle(0, true)).toBe(1);
  expect(signals.fanAngle(0, false)).toBe(2);
});
