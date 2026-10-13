import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { resetStore, useStore } from "../app/store/index.ts";
import { clearSceneLines, lastSceneLines } from "./sceneLog.ts";
import { transitionSceneError, transitionWebgl } from "./transitions.ts";

beforeEach(() => {
  vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 720 });
  vi.spyOn(console, "info").mockImplementation(() => {});
  resetStore();
  clearSceneLines();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a webgl transition sets the store and logs one [scene] line with the reason", () => {
  transitionWebgl("restoring", undefined, "context lost");
  expect(useStore.getState().webgl).toBe("restoring");
  transitionWebgl("unavailable", "lost", "no restore within 10 s");
  expect(useStore.getState()).toMatchObject({ webgl: "unavailable", webglReason: "lost" });
  expect(lastSceneLines()).toEqual([
    "[scene] webgl ok -> restoring: context lost",
    "[scene] webgl restoring -> unavailable (lost): no restore within 10 s",
  ]);
});

test("repeating the same state logs nothing", () => {
  transitionWebgl("restoring", undefined, "context lost");
  transitionWebgl("restoring", undefined, "context lost");
  expect(lastSceneLines()).toHaveLength(1);
});

test("a scene error sets the store and logs once, a second identical one does not", () => {
  transitionSceneError("boom", "driver gave up");
  transitionSceneError("boom", "driver gave up");
  expect(useStore.getState().sceneError).toEqual({ message: "boom" });
  expect(lastSceneLines()).toEqual(["[scene] sceneError none -> set: driver gave up (boom)"]);
});
