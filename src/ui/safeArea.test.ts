import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { SafeArea } from "../app/store/index.ts";
import { carveSafeArea, createSafeAreaWatcher, type Rect } from "./safeArea.ts";

const canvas: Rect = { x: 0, y: 0, width: 1280, height: 720 };
const topBar: Rect = { x: 0, y: 0, width: 1280, height: 56 };
const tabStrip: Rect = { x: 0, y: 672, width: 1280, height: 48 };
const kpi: Rect = { x: 16, y: 72, width: 528, height: 120 };
const tracker: Rect = { x: 16, y: 544, width: 536, height: 112 };
const rightPanel: Rect = { x: 904, y: 72, width: 360, height: 584 };

test("with no panels the safe area is the whole canvas", () => {
  expect(carveSafeArea(canvas, [])).toEqual(canvas);
});

test("docked panels are cut away from their own side", () => {
  expect(carveSafeArea(canvas, [topBar, tabStrip])).toEqual({
    x: 0,
    y: 56,
    width: 1280,
    height: 616,
  });
});

test("the full shell leaves the free middle and the right panel removes its width", () => {
  const without = carveSafeArea(canvas, [topBar, kpi, tracker, tabStrip]);
  expect(without).toEqual({ x: 0, y: 192, width: 1280, height: 352 });
  const withPanel = carveSafeArea(canvas, [topBar, kpi, rightPanel, tracker, tabStrip]);
  expect(withPanel).toEqual({ x: 0, y: 192, width: 904, height: 352 });
});

test("panels that miss the rect are ignored", () => {
  expect(carveSafeArea(canvas, [{ x: 2000, y: 0, width: 10, height: 10 }])).toEqual(canvas);
});

// A fake animation-frame queue: callbacks run only when flush() is called.
function harness(initial: { canvas: Rect; panels: Rect[] }) {
  let layout = initial;
  let area: SafeArea = { ...initial.canvas };
  const queue = new Map<number, () => void>();
  let next = 1;
  const write = vi.fn((a: SafeArea) => {
    area = a;
  });
  const warn = vi.fn();
  const watcher = createSafeAreaWatcher({
    measure: () => layout,
    read: () => area,
    write,
    raf: (cb) => {
      queue.set(next, cb);
      return next++;
    },
    caf: (id) => queue.delete(id),
    warn,
  });
  const flush = () => {
    const pending = [...queue.values()];
    queue.clear();
    for (const cb of pending) cb();
  };
  return {
    watcher,
    write,
    warn,
    flush,
    pending: () => queue.size,
    set: (l: typeof layout) => {
      layout = l;
    },
  };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness({ canvas, panels: [topBar, kpi, tracker, tabStrip] });
});

test("the first frame writes the measured rect", () => {
  h.watcher.schedule();
  h.flush();
  expect(h.write).toHaveBeenCalledOnce();
  expect(h.write).toHaveBeenCalledWith({ x: 0, y: 192, width: 1280, height: 352 });
});

test("many notifications in one frame coalesce into one write", () => {
  for (let i = 0; i < 20; i++) h.watcher.schedule();
  expect(h.pending()).toBe(1);
  h.flush();
  expect(h.write).toHaveBeenCalledTimes(1);
});

test("an unchanged rect is not written again", () => {
  h.watcher.schedule();
  h.flush();
  h.watcher.schedule();
  h.flush();
  expect(h.write).toHaveBeenCalledTimes(1);
});

test("a resize changes the rect and writes it", () => {
  h.watcher.schedule();
  h.flush();
  const big: Rect = { x: 0, y: 0, width: 1920, height: 1080 };
  h.set({
    canvas: big,
    panels: [
      { ...topBar, width: 1920 },
      kpi,
      { ...tracker, y: 904 },
      { x: 0, y: 1032, width: 1920, height: 48 },
    ],
  });
  h.watcher.schedule();
  h.flush();
  expect(h.write).toHaveBeenLastCalledWith({ x: 0, y: 192, width: 1920, height: 712 });
});

test("opening and closing the right panel writes both rects", () => {
  h.watcher.schedule();
  h.flush();
  h.set({ canvas, panels: [topBar, kpi, rightPanel, tracker, tabStrip] });
  h.watcher.schedule();
  h.flush();
  expect(h.write).toHaveBeenLastCalledWith({ x: 0, y: 192, width: 904, height: 352 });
  h.set({ canvas, panels: [topBar, kpi, tracker, tabStrip] });
  h.watcher.schedule();
  h.flush();
  expect(h.write).toHaveBeenLastCalledWith({ x: 0, y: 192, width: 1280, height: 352 });
  expect(h.write).toHaveBeenCalledTimes(3);
});

test("an empty rect falls back to the full canvas with one warning", () => {
  const small: Rect = { x: 0, y: 0, width: 300, height: 200 };
  h.set({ canvas: small, panels: [{ x: 0, y: 0, width: 300, height: 200 }] });
  h.watcher.schedule();
  h.flush();
  expect(h.write).toHaveBeenCalledWith(small);
  h.watcher.schedule();
  h.flush();
  h.watcher.schedule();
  h.flush();
  expect(h.warn).toHaveBeenCalledOnce();
});

test("stop cancels a scheduled frame", () => {
  h.watcher.schedule();
  h.watcher.stop();
  expect(h.pending()).toBe(0);
  h.watcher.schedule();
  expect(h.pending()).toBe(0);
});
