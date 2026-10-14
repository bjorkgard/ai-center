import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { resetStore, useStore } from "./index.ts";

beforeEach(() => {
  vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 720 });
  resetStore();
});
afterEach(() => vi.unstubAllGlobals());

test("ui slice defaults", () => {
  const s = useStore.getState();
  expect(s.reducedMotion).toBe(false);
  expect(s.quality).toBe("high");
  expect(s.webgl).toBe("ok");
  expect(s.webglReason).toBeNull();
  expect(s.sceneError).toBeNull();
  expect(s.safeArea).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
});

test("setters change the slice", () => {
  const s = useStore.getState();
  s.setReducedMotion(true);
  s.setQuality("low");
  s.setWebgl("unavailable", "lost");
  s.setSceneError({ message: "boom" });
  s.setSafeArea({ x: 1, y: 2, width: 3, height: 4 });
  expect(useStore.getState()).toMatchObject({
    reducedMotion: true,
    quality: "low",
    webgl: "unavailable",
    webglReason: "lost",
    sceneError: { message: "boom" },
    safeArea: { x: 1, y: 2, width: 3, height: 4 },
  });
});

test("webgl ok clears the reason", () => {
  const s = useStore.getState();
  s.setWebgl("unavailable", "start");
  s.setWebgl("ok");
  expect(useStore.getState().webglReason).toBeNull();
});

test("resetStore restores the defaults", () => {
  useStore.getState().setQuality("low");
  useStore.getState().setSceneError({ message: "x" });
  resetStore();
  expect(useStore.getState().quality).toBe("high");
  expect(useStore.getState().sceneError).toBeNull();
});
