import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { CATCHUP_MS, MockSource, mockEvents } from "../../data/mock.ts";
import { aggregatesOf, totalInvalid } from "../../data/reduce.ts";
import type { AgentEvent, Source, SourceStatus } from "../../data/schema.ts";
import { resetStore, useStore } from "./index.ts";
import { setWarnClock } from "./data.ts";

class FakeSource implements Source {
  name = "fake";
  starts = 0;
  stops = 0;
  private events: (e: unknown[]) => void = () => {};
  private status: (s: SourceStatus, d?: string) => void = () => {};
  onEvents(cb: (e: unknown[]) => void) {
    this.events = cb;
  }
  onStatus(cb: (s: SourceStatus, d?: string) => void) {
    this.status = cb;
  }
  start() {
    this.starts++;
  }
  stop() {
    this.stops++;
  }
  emit(e: unknown[]) {
    this.events(e);
  }
  report(s: SourceStatus, d?: string) {
    this.status(s, d);
  }
}

const batch = (count: number, from = 0): AgentEvent[] =>
  mockEvents(1, "steady", from, 10 * 60_000).slice(0, count);
const store = () => useStore.getState();

beforeEach(() => {
  store().disconnect();
  resetStore();
});
afterEach(() => vi.restoreAllMocks());

test("a batch with one invalid event among 500 applies the 499, counts 1 and warns once without the value", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const events: unknown[] = batch(500);
  events[250] = { ...(events[250] as object), vendor: "SECRET-VALUE" };
  store().ingest("fake", events);
  expect(store().dataHealth.applied).toBe(499);
  expect(totalInvalid(store().dataHealth)).toBe(1);
  expect(warn).toHaveBeenCalledTimes(1);
  const line = String(warn.mock.calls[0][0]);
  expect(line).toContain("[data] fake");
  expect(line).toContain((events[250] as AgentEvent).id);
  expect(line).toContain("vendor");
  expect(line).not.toContain("SECRET-VALUE");
});

test("the first warning per path per minute only, on an injected clock", () => {
  let now = 0;
  setWarnClock(() => now);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const bad = (i: number) => ({ ...batch(1)[0], id: `b${i}`, vendor: "x" });
  store().ingest("fake", [bad(1), bad(2)]);
  store().ingest("fake", [bad(3)]);
  expect(warn).toHaveBeenCalledTimes(1);
  now = 61_000;
  store().ingest("fake", [bad(4)]);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(totalInvalid(store().dataHealth)).toBe(4);
  setWarnClock();
});

test("a batch of 500 invalid events counts 500 and leaves the aggregates untouched", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const before = store().sessions;
  store().ingest(
    "fake",
    Array.from({ length: 500 }, () => ({ nope: 1 })),
  );
  expect(totalInvalid(store().dataHealth)).toBe(500);
  expect(store().sessions).toBe(before);
});

test("a reducer forced to throw leaves the state unchanged and sets status error", () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const source = new FakeSource();
  store().connect(source);
  source.report("live");
  const before = aggregatesOf(store());
  const events = batch(10);
  store().ingest("fake", events, () => {
    throw new TypeError("boom");
  });
  expect(aggregatesOf(store())).toEqual(before);
  expect(store().source.status).toBe("error");
  expect(store().dataHealth.failedBatches).toBe(1);
  expect(err).toHaveBeenCalledTimes(1);
  const line = String(err.mock.calls[0][0]);
  expect(line).toContain("fake");
  expect(line).toContain("10");
  expect(line).toContain(events[0].id);
});

test("when batch 2 of 3 throws, batches 1 and 3 apply, failedBatches is 1 and the status stays error", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const { applyBatch } = await import("../../data/reduce.ts");
  const source = new FakeSource();
  store().connect(source);
  const all = batch(30);
  let call = 0;
  const flaky = (s: Parameters<typeof applyBatch>[0], e: AgentEvent[]) => {
    if (++call === 2) throw new RangeError("boom");
    return applyBatch(s, e);
  };
  store().ingest("fake", all.slice(0, 10), flaky);
  store().ingest("fake", all.slice(10, 20), flaky);
  store().ingest("fake", all.slice(20), flaky);
  source.report("live");
  expect(store().dataHealth.applied).toBe(20);
  expect(store().dataHealth.failedBatches).toBe(1);
  expect(store().source.status).toBe("error");
  store().connect(new FakeSource());
  expect(store().source.status).toBe("idle");
  expect(store().dataHealth.failedBatches).toBe(0);
});

test("a batch commits with one store update, an empty batch with none", () => {
  const calls = vi.fn();
  const unsub = useStore.subscribe(calls);
  store().ingest("fake", batch(100));
  expect(calls).toHaveBeenCalledTimes(1);
  store().ingest("fake", []);
  expect(calls).toHaveBeenCalledTimes(1);
  unsub();
});

test("each status transition logs exactly one [data] line", () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const source = new FakeSource();
  store().connect(source);
  source.report("catching_up");
  source.report("catching_up");
  source.report("live");
  expect(info.mock.calls.map((c) => c[0])).toEqual([
    "[data] fake: idle -> catching_up",
    "[data] fake: catching_up -> live",
  ]);
});

test("connect, disconnect, connect gives the same state as one connect, with 0 duplicates", () => {
  const run = (cycles: number) => {
    store().disconnect();
    for (let i = 0; i < cycles; i++) {
      const source = new FakeSource();
      store().connect(source);
      source.emit(batch(200));
      if (i < cycles - 1) store().disconnect();
    }
    const { dataHealth, ...rest } = store();
    return { agg: aggregatesOf(rest), health: { ...dataHealth, lastApplyMs: 0 } };
  };
  const once = run(1);
  const thrice = run(3);
  expect(thrice).toEqual(once);
  expect(thrice.health.duplicates).toBe(0);
});

test("connect stops the previous source and ignores its late reports; disconnect stops and clears", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const a = new FakeSource();
  const b = new FakeSource();
  store().connect(a);
  a.emit(batch(10));
  store().connect(b);
  expect(a.stops).toBe(1);
  expect(b.starts).toBe(1);
  expect(store().sessions.size).toBe(0);
  a.emit(batch(10));
  a.report("live");
  expect(store().sessions.size).toBe(0);
  expect(store().source.status).toBe("idle");
  b.emit(batch(10));
  store().disconnect();
  expect(b.stops).toBe(1);
  expect(store().sessions.size).toBe(0);
  expect(store().source).toEqual({ name: null, status: "idle" });
});

test("resetStore clears the data slice", () => {
  store().ingest("fake", batch(10));
  resetStore();
  expect(store().sessions.size).toBe(0);
  expect(store().dataHealth.applied).toBe(0);
});

test("under freeze the store holds exactly the catch-up events and no timer runs", () => {
  let timers = 0;
  store().connect(
    new MockSource({
      seed: 1,
      scenario: "steady",
      freeze: true,
      now: () => CATCHUP_MS,
      schedule: () => {
        timers++;
        return () => {};
      },
    }),
  );
  const caught = mockEvents(1, "steady", 0, CATCHUP_MS);
  expect(timers).toBe(0);
  expect(store().source.status).toBe("live");
  expect(store().dataHealth.applied).toBe(caught.length);
  expect(store().dataHealth.duplicates).toBe(0);
  const ref = { ...store() };
  store().disconnect();
  resetStore();
  store().ingest("ref", caught);
  expect(aggregatesOf(ref)).toEqual(aggregatesOf(store()));
});
