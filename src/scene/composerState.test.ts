import { beforeEach, expect, test, vi } from "vite-plus/test";
import { resetStore, useStore } from "../app/store/index.ts";
import { composerFailed, composerRestored, INITIAL_COMPOSER } from "./composerState.ts";

beforeEach(() => resetStore());

function deps() {
  return { log: vi.fn(), unbind: vi.fn() };
}

test("a composer error turns bloom off, unbinds the composer and logs it", () => {
  const d = deps();
  const next = composerFailed(INITIAL_COMPOSER, new Error("shader"), d);
  expect(next.failed).toBe(true);
  expect(d.unbind).toHaveBeenCalledTimes(1);
  expect(d.log).toHaveBeenCalledWith("composer failed, bloom off: shader");
});

test("a composer error shows no card and leaves the scene running", () => {
  composerFailed(INITIAL_COMPOSER, new Error("shader"), deps());
  expect(useStore.getState().sceneError).toBeNull();
  expect(useStore.getState().webgl).not.toBe("unavailable");
});

test("a context restore bumps the generation so the composer remounts", () => {
  expect(composerRestored({ failed: true, gen: 2 })).toEqual({ failed: false, gen: 3 });
});

test("a failed rebuild after restore turns bloom off again", () => {
  const d = deps();
  const restored = composerRestored({ failed: true, gen: 0 });
  expect(restored.failed).toBe(false);
  const again = composerFailed(restored, new Error("rebuild"), d);
  expect(again).toEqual({ failed: true, gen: 1 });
  expect(d.unbind).toHaveBeenCalledTimes(1);
});
