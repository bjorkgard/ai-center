import { afterEach, expect, test, vi } from "vite-plus/test";
import { clearSceneLines, lastSceneLines } from "../sceneLog.ts";
import {
  displayedRate,
  fibreLines,
  packetRateOverride,
  packetSpeed,
  reportNetwork,
  resetNetworkDev,
  setPacketRate,
  subscribeNetwork,
} from "./networkDev.ts";

afterEach(() => {
  resetNetworkDev();
  clearSceneLines();
  vi.restoreAllMocks();
});

const quiet = () => ({
  warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  info: vi.spyOn(console, "info").mockImplementation(() => {}),
});

test("the rate starts on the default (no override), and setPacketRate stores it, tells subscribers and logs one line", () => {
  const { warn } = quiet();
  expect(packetRateOverride()).toBeNull();
  let calls = 0;
  const stop = subscribeNetwork(() => calls++);
  setPacketRate(4);
  expect(packetRateOverride()).toBe(4);
  expect(calls).toBe(1);
  expect(lastSceneLines().filter((l) => l.includes("packet rate"))).toHaveLength(1);
  setPacketRate(4);
  expect(calls).toBe(1);
  stop();
  setPacketRate(2);
  expect(calls).toBe(1);
  expect(warn).not.toHaveBeenCalled();
});

test("an out of range or NaN rate clamps to 0-10 and warns once each, naming the argument", () => {
  const { warn } = quiet();
  setPacketRate(99);
  expect(packetRateOverride()).toBe(10);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('"perSecond"');
  setPacketRate(-3);
  expect(packetRateOverride()).toBe(0);
  setPacketRate(Number.NaN);
  expect(packetRateOverride()).toBe(0);
  expect(warn).toHaveBeenCalledTimes(3);
});

test("a non-number rate warns and leaves the value unchanged", () => {
  const { warn } = quiet();
  setPacketRate(3);
  for (const bad of [undefined, "2", null, {}]) setPacketRate(bad as never);
  expect(packetRateOverride()).toBe(3);
  expect(warn).toHaveBeenCalledTimes(4);
  expect(warn.mock.calls[0][0]).toContain('"perSecond"');
  resetNetworkDev();
  setPacketRate(undefined as never);
  expect(packetRateOverride()).toBeNull();
});

test("the HUD shows the override when set, else the default rate", () => {
  expect(displayedRate(3)).toBe(3);
  expect(displayedRate(0)).toBe(0);
  expect(displayedRate(null)).toBe(1);
});

test("the fibre reports its drawn line count and packet speed, and a reset clears them", () => {
  expect(fibreLines()).toBeNull();
  expect(packetSpeed()).toBeNull();
  reportNetwork(4, 2.5);
  expect(fibreLines()).toBe(4);
  expect(packetSpeed()).toBe(2.5);
  reportNetwork(5, null);
  expect(fibreLines()).toBe(5);
  expect(packetSpeed()).toBe(2.5);
  resetNetworkDev();
  expect(fibreLines()).toBeNull();
  expect(packetSpeed()).toBeNull();
});
