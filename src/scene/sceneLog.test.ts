import { afterEach, expect, test, vi } from "vite-plus/test";
import { clearSceneLines, installSceneLogCapture, lastSceneLines, logScene } from "./sceneLog.ts";

afterEach(() => {
  clearSceneLines();
  vi.restoreAllMocks();
});

test("logScene writes one console line with the [scene] prefix", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  logScene("webgl ok -> restoring");
  expect(info).toHaveBeenCalledWith("[scene] webgl ok -> restoring");
  expect(lastSceneLines()).toEqual(["[scene] webgl ok -> restoring"]);
});

test("capture records [scene] lines from any console level and ignores the rest", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  const stop = installSceneLogCapture();
  console.info("[scene] a");
  console.error("[scene] frame error: x");
  console.warn("not ours");
  console.log("[params] nope");
  stop();
  expect(lastSceneLines()).toEqual(["[scene] a", "[scene] frame error: x"]);
});

test("capture keeps only the last 20 and stop restores console", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const before = console.error;
  const stop = installSceneLogCapture();
  expect(console.error).not.toBe(before);
  for (let i = 0; i < 30; i++) console.info(`[scene] n${i}`);
  stop();
  expect(console.error).toBe(before);
  const lines = lastSceneLines();
  expect(lines).toHaveLength(20);
  expect(lines[0]).toBe("[scene] n10");
  expect(lines[19]).toBe("[scene] n29");
});

test("installing twice and stopping once leaves one wrapper level (StrictMode)", () => {
  const before = console.info;
  const stopA = installSceneLogCapture();
  const stopB = installSceneLogCapture();
  stopA();
  stopB();
  expect(console.info).toBe(before);
});
