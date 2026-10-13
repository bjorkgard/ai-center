import { expect, test } from "vite-plus/test";
import { watchReducedMotion } from "./reducedMotion.ts";

function fakeMedia(initial: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches: initial,
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  };
  return {
    matchMedia: (query: string) => {
      expect(query).toBe("(prefers-reduced-motion: reduce)");
      return mql;
    },
    set(value: boolean) {
      mql.matches = value;
      for (const fn of listeners) fn({ matches: value });
    },
    count: () => listeners.size,
  };
}

test("the flag takes the current value and follows the media query live", () => {
  const media = fakeMedia(true);
  const seen: boolean[] = [];
  const stop = watchReducedMotion((v) => seen.push(v), media.matchMedia as never);
  media.set(false);
  media.set(true);
  expect(seen).toEqual([true, false, true]);
  stop();
  expect(media.count()).toBe(0);
});
