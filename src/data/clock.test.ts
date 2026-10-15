import { afterEach, expect, test, vi } from "vite-plus/test";
import { createLiveClock, createSimClock } from "./clock.ts";

afterEach(() => vi.restoreAllMocks());

function fake(options: { speed?: 1 | 10 | 60; paused?: boolean; locked?: boolean } = {}) {
  let real = 5000;
  const clock = createSimClock({ realNow: () => real, startMs: 1_000_000, ...options });
  return { clock, advance: (ms: number) => (real += ms), setReal: (ms: number) => (real = ms) };
}
const lines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

test("a running clock advances by real elapsed time times the speed", () => {
  const f = fake();
  expect(f.clock.now()).toBe(1_000_000);
  f.advance(1000);
  expect(f.clock.now()).toBe(1_001_000);
  vi.spyOn(console, "info").mockImplementation(() => {});
  f.clock.setSpeed(10);
  f.advance(1000);
  expect(f.clock.now()).toBe(1_011_000);
  f.clock.setSpeed(60);
  f.advance(1000);
  expect(f.clock.now()).toBe(1_071_000);
});

test("pause freezes now(), play rebases with no jump and no step back", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const f = fake();
  f.advance(2000);
  f.clock.pause();
  const frozen = f.clock.now();
  expect(frozen).toBe(1_002_000);
  f.advance(9000);
  expect(f.clock.now()).toBe(frozen);
  expect(f.clock.paused).toBe(true);
  f.clock.play();
  expect(f.clock.now()).toBe(frozen);
  f.advance(500);
  expect(f.clock.now()).toBe(frozen + 500);
  expect(lines(info)).toEqual(["[data] clock: paused", "[data] clock: playing"]);
});

test("every transition logs exactly one line, and a repeat of the current state logs none", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const f = fake();
  f.clock.play();
  f.clock.setSpeed(10);
  f.clock.setSpeed(10);
  f.clock.pause();
  f.clock.pause();
  f.clock.setSpeed(60);
  f.clock.play();
  expect(lines(info)).toEqual([
    "[data] clock: 1x -> 10x",
    "[data] clock: paused",
    "[data] clock: 10x -> 60x",
    "[data] clock: playing",
  ]);
});

test("an invalid speed changes nothing and warns once", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const f = fake();
  for (const bad of [0, 5, -1, 1.5, NaN, 600]) f.clock.setSpeed(bad);
  expect(f.clock.speed).toBe(1);
  expect(warn).toHaveBeenCalledTimes(6);
  expect(String(warn.mock.calls[0][0])).toContain("[data] clock");
  expect(info).not.toHaveBeenCalled();
  f.advance(1000);
  expect(f.clock.now()).toBe(1_001_000);
});

test("setSpeed(current) does nothing and logs nothing", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = fake({ speed: 10 });
  f.advance(100);
  f.clock.setSpeed(10);
  expect(f.clock.now()).toBe(1_001_000);
  expect(info).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
});

test("setSpeed while paused changes the speed and stays paused", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = fake({ paused: true });
  f.clock.setSpeed(60);
  expect(f.clock.speed).toBe(60);
  expect(f.clock.paused).toBe(true);
  f.advance(1000);
  expect(f.clock.now()).toBe(1_000_000);
  f.clock.play();
  f.advance(1000);
  expect(f.clock.now()).toBe(1_060_000);
});

test("a locked clock ignores play, pause and setSpeed and logs one line per call", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const f = fake({ locked: true });
  f.clock.pause();
  f.clock.play();
  f.clock.setSpeed(10);
  f.clock.setSpeed(7);
  expect(f.clock.locked).toBe(true);
  expect(f.clock.speed).toBe(1);
  expect(f.clock.paused).toBe(false);
  f.advance(1000);
  expect(f.clock.now()).toBe(1_001_000);
  expect(info).not.toHaveBeenCalled();
  expect(warn.mock.calls).toHaveLength(4);
  expect(lines(warn).every((l) => l.startsWith("[data] clock: locked"))).toBe(true);
});

test("a clock created paused holds its start until play", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const f = fake({ paused: true, locked: true });
  f.advance(5000);
  expect(f.clock.now()).toBe(1_000_000);
  expect(f.clock.paused).toBe(true);
});

test("hold stops now() like a pause without touching paused, and release resumes with no jump", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const f = fake();
  f.advance(1000);
  f.clock.hold(true);
  f.advance(9000);
  expect(f.clock.now()).toBe(1_001_000);
  expect(f.clock.paused).toBe(false);
  f.clock.hold(false);
  f.advance(500);
  expect(f.clock.now()).toBe(1_001_500);
  // A user pause survives a hold and its release.
  f.clock.pause();
  f.clock.hold(true);
  f.clock.hold(false);
  f.advance(1000);
  expect(f.clock.now()).toBe(1_001_500);
  expect(f.clock.paused).toBe(true);
  expect(lines(info)).toEqual(["[data] clock: paused"]);
});

test("the live clock is locked at 1x and reads max(previous, wall clock)", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let wall = 10_000;
  const clock = createLiveClock(() => wall);
  expect(clock.locked).toBe(true);
  expect(clock.speed).toBe(1);
  expect(clock.paused).toBe(false);
  expect(clock.now()).toBe(10_000);
  wall = 12_000;
  expect(clock.now()).toBe(12_000);
  wall = 11_000;
  expect(clock.now()).toBe(12_000);
  wall = 13_000;
  expect(clock.now()).toBe(13_000);
  clock.pause();
  clock.hold(true);
  expect(clock.now()).toBe(13_000);
  expect(warn).toHaveBeenCalledTimes(1);
});
