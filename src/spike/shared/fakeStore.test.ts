import { expect, test, vi } from "vite-plus/test";
import { createFakeStore, startTicking, writeLedColors } from "./fakeStore.ts";

function run(seed: number, ticks: number): Float32Array {
  const store = createFakeStore({ seed, load: 1 });
  for (let i = 0; i < ticks; i++) store.tick();
  return Float32Array.from(store.values(0));
}

test("the same seed gives the same sequence", () => {
  expect(run(7, 25)).toEqual(run(7, 25));
});

test("a different seed gives a different sequence", () => {
  expect(run(7, 25)).not.toEqual(run(8, 25));
});

test("values stay in [0,1] across many ticks, for every hall", () => {
  const store = createFakeStore({ seed: 3, load: 4 });
  for (let i = 0; i < 300; i++) store.tick();
  for (let hall = 0; hall < 18; hall++) {
    const v = store.values(hall);
    expect(v.length).toBe(1024);
    expect(v.every((x) => x >= 0 && x <= 1)).toBe(true);
  }
});

test("listeners are called with the version on tick and counted", () => {
  const store = createFakeStore({ seed: 1, load: 1 });
  const seen: number[] = [];
  expect(store.listenerCount).toBe(0);
  const off = store.subscribe((v) => seen.push(v));
  const off2 = store.subscribe(() => {});
  expect(store.listenerCount).toBe(2);
  store.tick();
  store.tick();
  expect(seen).toEqual([1, 2]);
  off();
  off();
  expect(store.listenerCount).toBe(1);
  store.tick();
  expect(seen).toEqual([1, 2]);
  off2();
  expect(store.listenerCount).toBe(0);
});

test("startTicking ticks at 10 updates per second and stops", () => {
  vi.useFakeTimers();
  try {
    const store = createFakeStore({ seed: 1, load: 1 });
    const stop = startTicking(store, 10);
    vi.advanceTimersByTime(1000);
    expect(store.version).toBe(10);
    stop();
    vi.advanceTimersByTime(1000);
    expect(store.version).toBe(10);
  } finally {
    vi.useRealTimers();
  }
});

test("writeLedColors writes three finite channels in [0,1] per LED", () => {
  const store = createFakeStore({ seed: 1, load: 1 });
  const out = new Float32Array(256 * 3);
  writeLedColors(out, store.values(0));
  expect(out.every((x) => Number.isFinite(x) && x >= 0 && x <= 1)).toBe(true);
});
