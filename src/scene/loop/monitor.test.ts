import { beforeEach, expect, test, vi } from "vite-plus/test";
import { resetStore, useStore } from "../../app/store/index.ts";
import { createRenderDriver } from "./driver.ts";
import { createFakeEnv } from "./fakeEnv.ts";
import { createFrameMonitor, simulateFrameInterval } from "./monitor.ts";

const CAP = 1000 / 60;

beforeEach(() => {
  resetStore();
  simulateFrameInterval(null);
});

function make() {
  const log = vi.fn();
  const monitor = createFrameMonitor({ log });
  return { monitor, log };
}

function feed(
  monitor: ReturnType<typeof make>["monitor"],
  ms: number,
  interval: number,
  cap = CAP,
) {
  for (let t = 0; t < ms; t += interval) monitor.feed(interval, cap);
}

function warmUp(monitor: ReturnType<typeof make>["monitor"]) {
  feed(monitor, 1000, CAP);
}

test("steady 60 fps stays on the high tier", () => {
  const { monitor, log } = make();
  feed(monitor, 30_000, CAP);
  expect(useStore.getState().quality).toBe("high");
  expect(log).not.toHaveBeenCalled();
});

test("degrades after 2 s of mean above 1.33 x cap, not before", () => {
  const { monitor, log } = make();
  warmUp(monitor);
  feed(monitor, 1900, 40);
  expect(useStore.getState().quality).toBe("high");
  feed(monitor, 800, 40);
  expect(useStore.getState().quality).toBe("medium");
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).toMatch(
    /^\[scene\] quality normal -> degraded \(mean [\d.]+ ms over 2 s\)$/,
  );
});

test("a slow patch shorter than 2 s does not degrade", () => {
  const { monitor } = make();
  warmUp(monitor);
  feed(monitor, 1200, 40);
  feed(monitor, 3000, CAP);
  feed(monitor, 1200, 40);
  feed(monitor, 3000, CAP);
  expect(useStore.getState().quality).toBe("high");
});

test("recovers after 10 s below 1.08 x cap, not before, and logs once", () => {
  const { monitor, log } = make();
  warmUp(monitor);
  feed(monitor, 3000, 40);
  expect(useStore.getState().quality).toBe("medium");
  feed(monitor, 9000, CAP);
  expect(useStore.getState().quality).toBe("medium");
  feed(monitor, 2500, CAP);
  expect(useStore.getState().quality).toBe("high");
  expect(log).toHaveBeenCalledTimes(2);
  expect(log.mock.calls[1][0]).toMatch(/^\[scene\] quality degraded -> normal/);
});

test("no flapping: borderline frames between the thresholds keep the tier", () => {
  const { monitor, log } = make();
  warmUp(monitor);
  feed(monitor, 3000, 40);
  feed(monitor, 30_000, CAP * 1.2);
  expect(useStore.getState().quality).toBe("medium");
  expect(log).toHaveBeenCalledTimes(1);
});

test("90 and 144 Hz cadences against a 60 fps cap are not misread", () => {
  for (const hz of [90, 144]) {
    resetStore();
    const { monitor, log } = make();
    // Delivered intervals alternate (22.2/11.1 ms at 90 Hz, 20.8/13.9 at 144 Hz); the mean is the cap.
    const pattern = hz === 90 ? [22.222, 11.111] : [20.833, 13.889, 13.889];
    let t = 0;
    for (let i = 0; t < 30_000; i++) {
      const ms = pattern[i % pattern.length];
      monitor.feed(ms, CAP);
      t += ms;
    }
    expect(useStore.getState().quality).toBe("high");
    expect(log).not.toHaveBeenCalled();
  }
});

test("the cap interval in force is used: 30 fps calm is not slow", () => {
  const { monitor } = make();
  feed(monitor, 20_000, 1000 / 30, 1000 / 30);
  expect(useStore.getState().quality).toBe("high");
});

test("paused (freeze or hidden) frames do not count and do not degrade", () => {
  const { monitor } = make();
  warmUp(monitor);
  monitor.setPaused(true);
  feed(monitor, 10_000, 100);
  expect(useStore.getState().quality).toBe("high");
  monitor.setPaused(false);
  feed(monitor, 5000, CAP);
  expect(useStore.getState().quality).toBe("high");
});

test("the first frames after a discontinuity are ignored", () => {
  const { monitor } = make();
  warmUp(monitor);
  monitor.discontinuity();
  feed(monitor, 5 * 500, 500); // 5 huge intervals right after resize
  feed(monitor, 3000, CAP);
  expect(useStore.getState().quality).toBe("high");
});

test("simulateFrameInterval replaces real intervals until cleared", () => {
  const { monitor } = make();
  warmUp(monitor);
  simulateFrameInterval(40);
  feed(monitor, 3000, CAP);
  expect(useStore.getState().quality).toBe("medium");
  simulateFrameInterval(null);
  feed(monitor, 12_000, CAP);
  expect(useStore.getState().quality).toBe("high");
});

test("it does not touch a tier it did not set", () => {
  const { monitor } = make();
  useStore.getState().setQuality("low");
  warmUp(monitor);
  feed(monitor, 5000, 40);
  expect(useStore.getState().quality).toBe("low");
});

test("stop makes later frames inert", () => {
  const { monitor } = make();
  warmUp(monitor);
  monitor.stop();
  feed(monitor, 5000, 40);
  expect(useStore.getState().quality).toBe("high");
});

test("75 and 120 Hz displays driven through the render driver do not degrade at a 60 fps cap", () => {
  for (const hz of [75, 120]) {
    resetStore();
    const { monitor, log } = make();
    const fake = createFakeEnv();
    const delivered: number[] = [];
    const driver = createRenderDriver({
      env: fake.env,
      calm: false,
      render: () => {},
      onFrame: (intervalMs, capIntervalMs) => {
        delivered.push(intervalMs);
        monitor.feed(intervalMs, capIntervalMs);
      },
      onFatal: () => {},
    });
    const stop = driver.start();
    const end = fake.now + 30_000;
    while (fake.now < end) fake.step(1000 / hz);
    stop();
    expect(delivered.length).toBeGreaterThan(1000);
    expect(useStore.getState().quality).toBe("high");
    expect(log).not.toHaveBeenCalled();
  }
});
