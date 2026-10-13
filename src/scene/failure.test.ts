import { beforeEach, afterEach, expect, test, vi } from "vite-plus/test";
import { resetStore, useStore } from "../app/store/index.ts";
import { classifyError, reportContentFailure, reportSceneFailure } from "./failure.ts";
import { SceneContentBoundary } from "./SceneBoundary.tsx";
import { clearSceneLines } from "./sceneLog.ts";
import { WebGLUnavailableError } from "./webgl.ts";

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

test("classifyError tells WebGL failures from scene errors by class", () => {
  expect(classifyError(new WebGLUnavailableError("x"))).toBe("webgl");
  expect(classifyError(new Error("x"))).toBe("scene");
  expect(classifyError("a string")).toBe("scene");
});

test("a WebGL failure sets webgl unavailable (start) and no scene error", () => {
  reportSceneFailure(new WebGLUnavailableError("no webgl2"));
  expect(useStore.getState()).toMatchObject({
    webgl: "unavailable",
    webglReason: "start",
    sceneError: null,
  });
});

test("a component that throws sets the scene error, not the WebGL card", () => {
  reportSceneFailure(new Error("cube exploded"));
  expect(useStore.getState()).toMatchObject({
    webgl: "ok",
    sceneError: { message: "cube exploded" },
  });
});

test("a content error stops the driver and sets the scene error, keeping webgl ok", () => {
  const stop = vi.fn();
  reportContentFailure(new Error("cube exploded"), stop);
  expect(stop).toHaveBeenCalledOnce();
  expect(useStore.getState()).toMatchObject({
    webgl: "ok",
    sceneError: { message: "cube exploded" },
  });
});

test("the content boundary reports a caught error through the driver stop", () => {
  const stop = vi.fn();
  const boundary = new SceneContentBoundary({ stopDriver: stop });
  boundary.componentDidCatch(new Error("hall failed"));
  expect(stop).toHaveBeenCalledOnce();
  expect(useStore.getState().sceneError).toEqual({ message: "hall failed" });
  expect(SceneContentBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  boundary.state = { failed: true };
  expect(boundary.render()).toBeNull();
});

test("the outer boundary still maps WebGLUnavailableError to the WebGL card", () => {
  reportSceneFailure(new WebGLUnavailableError("no webgl2"));
  expect(useStore.getState().webgl).toBe("unavailable");
});
