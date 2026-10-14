import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  RESTORE_TIMEOUT_MS,
  WebGLUnavailableError,
  createGlFactory,
  hasWebgl2,
  precheckWebgl,
  watchContext,
  type WebglChange,
} from "./webgl.ts";
import { reportShaderError } from "./shaderErrors.ts";

afterEach(() => vi.useRealTimers());

function fakeCanvas() {
  const handlers = new Map<string, Set<(e: Event) => void>>();
  return {
    addEventListener: (type: string, fn: (e: Event) => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => handlers.get(type)?.delete(fn),
    fire(type: string) {
      const preventDefault = vi.fn();
      const event = { preventDefault } as unknown as Event;
      for (const fn of handlers.get(type) ?? []) fn(event);
      return preventDefault;
    },
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

test("the gl factory rethrows a failed WebGLRenderer as WebGLUnavailableError (E24)", () => {
  class Throwing {
    constructor() {
      throw new Error("Error creating WebGL context.");
    }
  }
  const factory = createGlFactory(Throwing as never);
  expect(() => factory({} as never)).toThrow(WebGLUnavailableError);
  expect(() => factory({} as never)).toThrow("Error creating WebGL context.");
});

test("the gl factory passes the RENDER settings to the constructor", () => {
  const seen: unknown[] = [];
  class Fake {
    constructor(params: unknown) {
      seen.push(params);
    }
  }
  const canvas = {} as HTMLCanvasElement;
  createGlFactory(Fake as never)({ canvas } as never);
  expect(seen[0]).toMatchObject({ canvas, antialias: true, powerPreference: "default" });
});

test("hasWebgl2 is true only when a webgl2 context comes back", () => {
  const lose = vi.fn();
  const ok = () => ({
    getContext: () => ({ getExtension: () => ({ loseContext: lose }) }),
  });
  expect(hasWebgl2(ok as never)).toBe(true);
  expect(lose).toHaveBeenCalledTimes(1);
  expect(hasWebgl2((() => ({ getContext: () => null })) as never)).toBe(false);
  expect(
    hasWebgl2((() => ({
      getContext: () => {
        throw new Error("no");
      },
    })) as never),
  ).toBe(false);
});

test("precheckWebgl throws WebGLUnavailableError when forced off or unsupported", () => {
  const none = (() => ({ getContext: () => null })) as never;
  expect(() => precheckWebgl(false, none)).toThrow(WebGLUnavailableError);
  expect(() => precheckWebgl(true, none)).toThrow(WebGLUnavailableError);
  const ok = (() => ({ getContext: () => ({ getExtension: () => null }) })) as never;
  expect(() => precheckWebgl(true, ok)).not.toThrow();
});

test("context lost then restored goes restoring then ok", () => {
  vi.useFakeTimers();
  const canvas = fakeCanvas();
  const changes: WebglChange[] = [];
  watchContext(canvas as never, (c) => changes.push(c));
  const lost = canvas.fire("webglcontextlost");
  expect(lost).toHaveBeenCalled();
  vi.advanceTimersByTime(RESTORE_TIMEOUT_MS - 1);
  canvas.fire("webglcontextrestored");
  vi.advanceTimersByTime(RESTORE_TIMEOUT_MS * 2);
  expect(changes).toEqual([{ status: "restoring" }, { status: "ok" }]);
});

test("no restore within 10 s becomes unavailable with reason lost", () => {
  vi.useFakeTimers();
  const canvas = fakeCanvas();
  const changes: WebglChange[] = [];
  watchContext(canvas as never, (c) => changes.push(c));
  canvas.fire("webglcontextlost");
  vi.advanceTimersByTime(RESTORE_TIMEOUT_MS);
  expect(changes).toEqual([{ status: "restoring" }, { status: "unavailable", reason: "lost" }]);
});

test("a late restore after the timeout returns to ok", () => {
  vi.useFakeTimers();
  const canvas = fakeCanvas();
  const changes: WebglChange[] = [];
  watchContext(canvas as never, (c) => changes.push(c));
  canvas.fire("webglcontextlost");
  vi.advanceTimersByTime(RESTORE_TIMEOUT_MS + 5000);
  canvas.fire("webglcontextrestored");
  expect(changes.at(-1)).toEqual({ status: "ok" });
});

test("stop removes the listeners and the pending timeout", () => {
  vi.useFakeTimers();
  const canvas = fakeCanvas();
  const changes: WebglChange[] = [];
  const stop = watchContext(canvas as never, (c) => changes.push(c));
  expect(canvas.listeners()).toBe(2);
  canvas.fire("webglcontextlost");
  stop();
  vi.advanceTimersByTime(RESTORE_TIMEOUT_MS * 2);
  expect(canvas.listeners()).toBe(0);
  expect(changes).toEqual([{ status: "restoring" }]);
});

test("the gl factory routes shader compile failures to the [scene] reporter (CEO W-RW30)", () => {
  class Fake {
    debug: { onShaderError: unknown } = { onShaderError: null };
  }
  const renderer = createGlFactory(Fake as never)({} as never) as unknown as Fake;
  expect(renderer.debug.onShaderError).toBe(reportShaderError);
});
