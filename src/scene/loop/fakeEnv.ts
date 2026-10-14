import type { DriverEnv } from "./driver.ts";

type Handler = () => void;

// A scripted scheduler for tests: time only moves when step() is called.
export function createFakeEnv() {
  let t = 1000;
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const docListeners = new Map<string, Set<Handler>>();
  const winListeners = new Map<string, Set<Handler>>();
  const target = (map: Map<string, Set<Handler>>) => ({
    addEventListener(type: string, fn: Handler) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: Handler) {
      map.get(type)?.delete(fn);
    },
  });
  const doc = { hidden: false, ...target(docListeners) };
  const env: DriverEnv = {
    raf(cb) {
      const id = nextId++;
      pending.set(id, () => cb(t));
      return id;
    },
    caf(id) {
      pending.delete(id);
    },
    now: () => t,
    doc,
    win: target(winListeners),
  };
  const count = (map: Map<string, Set<Handler>>) =>
    [...map.values()].reduce((n, set) => n + set.size, 0);
  return {
    env,
    doc,
    get now() {
      return t;
    },
    pending: () => pending.size,
    listeners: () => count(docListeners) + count(winListeners),
    emit(target: "doc" | "win", type: string) {
      for (const fn of (target === "doc" ? docListeners : winListeners).get(type) ?? []) fn();
    },
    // Advance the clock by dt and run the frame callback that was waiting.
    step(dt: number) {
      t += dt;
      const [id, fn] = pending.entries().next().value ?? [];
      if (id === undefined) return false;
      pending.delete(id);
      fn!();
      return true;
    },
  };
}
