import { expect, test } from "vite-plus/test";
import { createRng, hash01 } from "./rng.ts";

test("the same seed gives the same sequence, a different seed a different one", () => {
  const a = createRng(7);
  const b = createRng(7);
  const first = Array.from({ length: 8 }, () => a.next());
  expect(Array.from({ length: 8 }, () => b.next())).toEqual(first);
  const other = createRng(8);
  expect(Array.from({ length: 8 }, () => other.next())).not.toEqual(first);
});

test("the sequence is pinned, so chunk 11's generator reads the same numbers", () => {
  const rng = createRng(1);
  expect([rng.next(), rng.next(), rng.next()]).toEqual([
    0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
  ]);
});

test("next stays in [0, 1) and int stays in [0, n)", () => {
  const rng = createRng(42);
  for (let i = 0; i < 2000; i++) {
    const x = rng.next();
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(1);
    const n = rng.int(6);
    expect(Number.isInteger(n) && n >= 0 && n < 6).toBe(true);
  }
});

test("pick returns members of the list", () => {
  const rng = createRng(3);
  const list = ["a", "b", "c"] as const;
  for (let i = 0; i < 50; i++) expect(list).toContain(rng.pick(list));
});

test("hash01 is a pure function of its inputs, in [0, 1), and spreads", () => {
  expect(hash01(1, 2, 3)).toBe(hash01(1, 2, 3));
  expect(hash01(1, 2, 3)).not.toBe(hash01(1, 3, 2));
  const values = Array.from({ length: 4000 }, (_, i) => hash01(1, i));
  expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
  expect(Math.max(...values)).toBeLessThan(1);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  expect(mean).toBeGreaterThan(0.47);
  expect(mean).toBeLessThan(0.53);
});
