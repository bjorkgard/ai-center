import { afterEach, expect, test, vi } from "vite-plus/test";
import { clearSceneLines, lastSceneLines } from "../sceneLog.ts";
import {
  placedHalls,
  resetCampusDev,
  setPlacedHalls,
  setWaypoints,
  showWaypoints,
  subscribeCampus,
} from "./campusDev.ts";

afterEach(() => {
  resetCampusDev();
  clearSceneLines();
  vi.restoreAllMocks();
});

const quiet = () => ({
  warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  info: vi.spyOn(console, "info").mockImplementation(() => {}),
});

test("A and B are always placed, and the campus starts with two halls and no graph", () => {
  expect(placedHalls()).toBe(2);
  expect(showWaypoints()).toBe(false);
});

test("setPlacedHalls stores 2-12, tells subscribers and logs one [scene] transition line", () => {
  const { warn } = quiet();
  const seen: number[] = [];
  const stop = subscribeCampus(() => seen.push(placedHalls()));
  setPlacedHalls(3);
  expect(placedHalls()).toBe(3);
  expect(seen).toEqual([3]);
  expect(lastSceneLines()).toEqual(["[scene] placed halls 2 -> 3"]);
  // Setting the same count changes and logs nothing.
  setPlacedHalls(3);
  expect(seen).toEqual([3]);
  expect(lastSceneLines()).toHaveLength(1);
  expect(warn).not.toHaveBeenCalled();
  stop();
});

test("out of range, fractional and NaN counts clamp to 2-12 with one warning naming the argument", () => {
  const { warn } = quiet();
  const cases: [number, number][] = [
    [99, 12],
    [0, 2],
    [-4, 2],
    [5.6, 6],
    [Number.NaN, 2],
    [Number.POSITIVE_INFINITY, 12],
  ];
  for (const [input, want] of cases) {
    warn.mockClear();
    setPlacedHalls(input);
    expect(placedHalls(), String(input)).toBe(want);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"n"');
  }
});

test("setWaypoints takes a boolean, tells subscribers, and warns on anything else", () => {
  const { warn } = quiet();
  const seen: boolean[] = [];
  const stop = subscribeCampus(() => seen.push(showWaypoints()));
  setWaypoints(true);
  expect(showWaypoints()).toBe(true);
  setWaypoints(true);
  expect(seen).toEqual([true]);
  setWaypoints("yes" as never);
  expect(showWaypoints()).toBe(true);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain('"on"');
  setWaypoints(false);
  expect(seen).toEqual([true, false]);
  stop();
});
