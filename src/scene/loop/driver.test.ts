import { afterEach, expect, test, vi } from "vite-plus/test";
import { createRenderDriver, type DriverOptions } from "./driver.ts";
import { createFakeEnv } from "./fakeEnv.ts";

afterEach(() => vi.restoreAllMocks());

function setup(options: Partial<DriverOptions> = {}) {
  const fake = createFakeEnv();
  const times: number[] = [];
  const driver = createRenderDriver({
    env: fake.env,
    render: (s) => {
      times.push(s);
    },
    onFatal: () => {},
    ...options,
  });
  return { fake, driver, times };
}

// Drive the loop at a display rate for ms of simulated time, returning rendered frames.
function run(fake: ReturnType<typeof createFakeEnv>, hz: number, ms: number, jitter = 0) {
  const dt = 1000 / hz;
  const end = fake.now + ms;
  let i = 0;
  while (fake.now + dt + jitter <= end + 1e-6) fake.step(dt + (i++ % 2 ? jitter : -jitter));
}

for (const hz of [60, 75, 90, 120, 144]) {
  test(`pacing at ${hz} Hz averages 60 fps and never exceeds it`, () => {
    const { fake, driver, times } = setup({ calm: false });
    driver.start();
    run(fake, hz, 10_000);
    const fps = times.length / 10;
    expect(fps).toBeLessThanOrEqual(60);
    expect(fps).toBeGreaterThan(hz < 60 ? 0 : 59);
  });
}

test("jittered 60 Hz renders every refresh, never halving", () => {
  const { fake, driver, times } = setup({ calm: false });
  driver.start();
  let ticks = 0;
  const end = fake.now + 10_000;
  while (fake.now < end) {
    fake.step(16.667 + (ticks++ % 3 === 0 ? 1.5 : ticks % 3 === 1 ? -1.5 : 0.4));
  }
  expect(times.length).toBe(ticks);
});

test("calm mode drops to 30 fps after 5 s without input and returns on input", () => {
  const { fake, driver, times } = setup();
  driver.start();
  run(fake, 60, 4000);
  expect(driver.state).toEqual({ capFps: 60, mode: "active" });
  run(fake, 60, 1500);
  expect(driver.state).toEqual({ capFps: 30, mode: "calm" });
  const before = times.length;
  run(fake, 60, 2000);
  expect(times.length - before).toBeLessThanOrEqual(61);
  expect(times.length - before).toBeGreaterThanOrEqual(58);
  driver.notifyInput();
  const atInput = times.length;
  fake.step(1000 / 60);
  expect(times.length).toBe(atInput + 1);
  expect(driver.state).toEqual({ capFps: 60, mode: "active" });
});

test("notifyCameraMotion also resets calm mode", () => {
  const { fake, driver } = setup();
  driver.start();
  run(fake, 60, 6000);
  expect(driver.state.mode).toBe("calm");
  driver.notifyCameraMotion();
  fake.step(16.7);
  expect(driver.state.mode).toBe("active");
});

test("calm=false never drops below 60 fps", () => {
  const { fake, driver } = setup({ calm: false });
  driver.start();
  run(fake, 60, 20_000);
  expect(driver.state).toEqual({ capFps: 60, mode: "active" });
});

test("a hidden tab renders nothing and reports hidden", () => {
  const { fake, driver, times } = setup();
  driver.start();
  run(fake, 60, 500);
  fake.doc.hidden = true;
  const before = times.length;
  run(fake, 60, 1000);
  expect(times.length).toBe(before);
  expect(driver.state.mode).toBe("hidden");
  fake.doc.hidden = false;
  fake.emit("doc", "visibilitychange");
  run(fake, 60, 100);
  expect(times.length).toBeGreaterThan(before);
  expect(driver.state.mode).toBe("active");
});

test("scene time: first delta 0, in seconds, real interval", () => {
  const { fake, driver, times } = setup();
  driver.start();
  fake.step(16.667);
  fake.step(16.667);
  fake.step(16.667);
  expect(times[0]).toBe(0);
  expect(times[1]).toBeCloseTo(0.01667, 4);
  expect(times[2]).toBeCloseTo(0.03333, 4);
});

test("a 60 s gap advances scene time by at most 0.1 s", () => {
  const { fake, driver, times } = setup();
  driver.start();
  fake.step(16.667);
  fake.step(16.667);
  const before = times[times.length - 1];
  fake.step(60_000);
  expect(times[times.length - 1] - before).toBeCloseTo(0.1, 6);
});

test("freeze renders one frame at scene time 0 and then only on invalidateFrozen", () => {
  const { fake, driver, times } = setup({ freeze: true });
  driver.start();
  run(fake, 60, 2000);
  expect(times).toEqual([0]);
  expect(driver.state.mode).toBe("frozen");
  driver.invalidateFrozen();
  run(fake, 60, 100);
  expect(times).toEqual([0, 0]);
  run(fake, 60, 1000);
  expect(times).toHaveLength(2);
});

test("a one-off frame error keeps looping and logs once", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const onFatal = vi.fn();
  let n = 0;
  const { fake, driver } = setup({
    onFatal,
    render: () => {
      if (++n === 2) throw new Error("bad frame");
    },
  });
  driver.start();
  run(fake, 60, 1000);
  expect(n).toBeGreaterThan(30);
  expect(driver.errorCount).toBe(1);
  expect(error).toHaveBeenCalledTimes(1);
  expect(String(error.mock.calls[0][0])).toContain("bad frame");
  expect(onFatal).not.toHaveBeenCalled();
});

test("the same message repeated non-consecutively logs once but counts every time", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  let n = 0;
  const { fake, driver } = setup({
    render: () => {
      if (++n % 3 === 0) throw new Error("same");
    },
  });
  driver.start();
  run(fake, 60, 1000);
  expect(driver.errorCount).toBeGreaterThan(5);
  expect(error).toHaveBeenCalledTimes(1);
});

test("three consecutive failing frames call onFatal and stop; two do not", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onFatal = vi.fn();
  let n = 0;
  const two = setup({
    onFatal,
    render: () => {
      n++;
      if (n === 2 || n === 3) throw new Error("two");
    },
  });
  two.driver.start();
  run(two.fake, 60, 500);
  expect(onFatal).not.toHaveBeenCalled();
  expect(two.fake.pending()).toBe(1);

  const fatal = vi.fn();
  const three = setup({
    onFatal: fatal,
    render: () => {
      throw new Error("always");
    },
  });
  three.driver.start();
  run(three.fake, 60, 500);
  expect(fatal).toHaveBeenCalledTimes(1);
  expect(fatal).toHaveBeenCalledWith("always");
  expect(three.driver.errorCount).toBe(3);
  expect(three.fake.pending()).toBe(0);
  expect(three.fake.listeners()).toBe(0);
});

test("start, stop, start leaves one scheduled callback and no extra listeners", () => {
  const { fake, driver } = setup();
  const stop1 = driver.start();
  const listeners = fake.listeners();
  expect(fake.pending()).toBe(1);
  stop1();
  expect(fake.pending()).toBe(0);
  expect(fake.listeners()).toBe(0);
  const stop2 = driver.start();
  expect(fake.pending()).toBe(1);
  expect(fake.listeners()).toBe(listeners);
  stop2();
  expect(fake.pending()).toBe(0);
});

test("starting twice without a stop does not schedule twice", () => {
  const { fake, driver } = setup();
  driver.start();
  driver.start();
  expect(fake.pending()).toBe(1);
});

test("the next frame is requested before rendering, so a throwing render still loops", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let pendingDuringRender = -1;
  const fake = createFakeEnv();
  const driver = createRenderDriver({
    env: fake.env,
    render: () => {
      pendingDuringRender = fake.pending();
      throw new Error("x");
    },
    onFatal: () => {},
  });
  driver.start();
  fake.step(16.7);
  expect(pendingDuringRender).toBe(1);
});

test("the monitor hooks receive intervals, the cap interval, pauses and discontinuities", () => {
  const frames: [number, number][] = [];
  const pauses: boolean[] = [];
  const onDiscontinuity = vi.fn();
  const { fake, driver } = setup({
    onFrame: (ms, cap) => frames.push([ms, cap]),
    onPause: (p) => pauses.push(p),
    onDiscontinuity,
  });
  driver.start();
  run(fake, 60, 200);
  expect(frames.length).toBeGreaterThan(5);
  expect(frames[0][1]).toBeCloseTo(1000 / 60, 6);
  fake.doc.hidden = true;
  run(fake, 60, 100);
  expect(pauses).toEqual([true]);
  fake.doc.hidden = false;
  fake.emit("doc", "visibilitychange");
  expect(onDiscontinuity).toHaveBeenCalledTimes(1);
  fake.emit("win", "resize");
  expect(onDiscontinuity).toHaveBeenCalledTimes(2);
  run(fake, 60, 100);
  expect(pauses).toEqual([true, false]);
});
