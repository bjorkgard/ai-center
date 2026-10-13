import { expect, test } from "vite-plus/test";
import { nearestRank, summarize } from "./stats.ts";

test("nearest-rank picks the value at rank ceil(p/100 * n)", () => {
  const ten = Float64Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(nearestRank(ten, 50)).toBe(5);
  expect(nearestRank(ten, 95)).toBe(10);
  expect(nearestRank(ten, 99)).toBe(10);
  const twenty = Float64Array.from({ length: 20 }, (_, i) => i + 1);
  expect(nearestRank(twenty, 95)).toBe(19);
  expect(nearestRank(twenty, 50)).toBe(10);
});

test("summarize sorts a copy and reports n, median, p95, p99 and max", () => {
  const input = Float64Array.from([9, 1, 5, 3, 7, 2, 8, 4, 10, 6]);
  expect(summarize(input)).toEqual({ n: 10, median: 5, p95: 10, p99: 10, max: 10 });
  expect(Array.from(input)).toEqual([9, 1, 5, 3, 7, 2, 8, 4, 10, 6]);
});

test("summarize reads only the first n samples of a sized-up-front buffer", () => {
  const buffer = new Float64Array(8);
  buffer.set([3, 1, 2]);
  expect(summarize(buffer, 3)).toEqual({ n: 3, median: 2, p95: 3, p99: 3, max: 3 });
});

test("empty input gives null, never 0", () => {
  expect(summarize(new Float64Array(0))).toBeNull();
  expect(summarize(new Float64Array(4), 0)).toBeNull();
  expect(nearestRank(new Float64Array(0), 50)).toBeNull();
});
