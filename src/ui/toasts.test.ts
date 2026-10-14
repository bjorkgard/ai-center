import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { resetStore, useStore } from "../app/store/index.ts";
import { departedToasts, restoreToastFor, restoringToastVisible, TOAST_MS } from "./toasts.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { innerWidth: 1280, innerHeight: 720 });
  resetStore();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a normal toast lasts 6 s and then leaves the store", () => {
  expect(TOAST_MS).toBe(6000);
  useStore.getState().pushToast("3D view restored");
  expect(useStore.getState().toasts.map((t) => t.text)).toEqual(["3D view restored"]);
  vi.advanceTimersByTime(TOAST_MS - 1);
  expect(useStore.getState().toasts).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(useStore.getState().toasts).toHaveLength(0);
});

test("newest toast comes first", () => {
  useStore.getState().pushToast("a");
  useStore.getState().pushToast("b");
  expect(useStore.getState().toasts.map((t) => t.text)).toEqual(["b", "a"]);
});

test("dismissing early cancels nothing else", () => {
  const id = useStore.getState().pushToast("a");
  useStore.getState().pushToast("b");
  useStore.getState().dismissToast(id);
  expect(useStore.getState().toasts.map((t) => t.text)).toEqual(["b"]);
});

test("the restoring toast shows only while restoring and no card shows", () => {
  expect(restoringToastVisible("restoring", null)).toBe(true);
  expect(restoringToastVisible("ok", null)).toBe(false);
  expect(restoringToastVisible("unavailable", "webgl-lost")).toBe(false);
  expect(restoringToastVisible("restoring", "scene-error")).toBe(false);
});

test("the restored toast follows restoring -> ok and a late restore of the lost card", () => {
  expect(restoreToastFor({ status: "restoring", reason: "lost" }, "ok", null)).toBe(true);
  expect(restoreToastFor({ status: "unavailable", reason: "lost" }, "ok", null)).toBe(true);
  expect(restoreToastFor({ status: "unavailable", reason: "start" }, "ok", null)).toBe(false);
  expect(restoreToastFor({ status: "ok", reason: null }, "ok", null)).toBe(false);
  expect(restoreToastFor({ status: "restoring", reason: "lost" }, "ok", "scene-error")).toBe(false);
});

test("departedToasts drops only the restoring toast when a card shows", () => {
  const restoring = { id: -1, restoring: true };
  const normal = { id: 3, restoring: false };
  expect(departedToasts([restoring, normal], [], "webgl-lost")).toEqual([normal]);
  expect(departedToasts([restoring], [], null)).toEqual([restoring]);
  expect(departedToasts([restoring, normal], [restoring], null)).toEqual([normal]);
});
