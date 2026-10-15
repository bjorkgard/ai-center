import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { createSimClock, type SimClock } from "../../data/clock.ts";
import {
  ANCHOR_MS,
  CATCHUP_MS,
  MockSource,
  createMockSource,
  mockEvents,
} from "../../data/mock.ts";
import { aggregatesOf, ringEvents, totalInvalid } from "../../data/reduce.ts";
import { SCENARIO_NAMES } from "../../data/scenarios.ts";
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
      clock: createSimClock({
        realNow: () => 0,
        startMs: ANCHOR_MS + CATCHUP_MS,
        paused: true,
        locked: true,
      }),
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

const createMockSourceLocked = () =>
  createMockSource({ seed: 1, scenario: "steady", freeze: true });

// A mock on a fake real clock and timer: `tick(ms)` advances real time and fires one tick.
function mockOn(options: { speed?: 1 | 10 | 60; scenario?: string } = {}) {
  let real = 0;
  let fire: () => void = () => {};
  const ranges: [number, number][] = [];
  const clock = createSimClock({
    realNow: () => real,
    startMs: ANCHOR_MS + CATCHUP_MS,
    speed: options.speed,
  });
  const source = new MockSource({
    seed: 1,
    scenario: options.scenario ?? "steady",
    clock,
    schedule: (fn) => {
      fire = fn;
      return () => {};
    },
    generate: (seed, scenario, from, to) => (
      ranges.push([from, to]),
      mockEvents(seed, scenario, from, to)
    ),
  });
  return {
    source,
    clock,
    ranges,
    tick: (ms = 250) => {
      real += ms;
      fire();
    },
  };
}

test("play, pause and setSpeed drive the source clock and the store mirror equals its getters after each", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const m = mockOn();
  store().connect(m.source);
  const same = () =>
    expect([store().speed, store().paused, store().locked]).toEqual([
      m.clock.speed,
      m.clock.paused,
      m.clock.locked,
    ]);
  same();
  expect(store().clock).toBe(m.clock);
  store().setSpeed(10);
  same();
  expect(store().speed).toBe(10);
  store().pause();
  same();
  expect(store().paused).toBe(true);
  store().setSpeed(60);
  same();
  expect([store().speed, store().paused]).toEqual([60, true]);
  store().play();
  same();
  expect(store().paused).toBe(false);
  store().setSpeed(7);
  same();
  expect(store().speed).toBe(60);
  expect(warn).toHaveBeenCalledTimes(1);
});

test("play, pause and setSpeed that change nothing make no store commit", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  store().connect(mockOn().source);
  const calls = vi.fn();
  const unsub = useStore.subscribe(calls);
  store().play();
  store().setSpeed(1);
  store().setSpeed(7);
  expect(calls).not.toHaveBeenCalled();
  store().pause();
  expect(calls).toHaveBeenCalledTimes(1);
  store().pause();
  store().setSpeed(10);
  store().setSpeed(10);
  expect(calls).toHaveBeenCalledTimes(2);
  store().play();
  store().play();
  expect(calls).toHaveBeenCalledTimes(3);
  unsub();
  const locked = createMockSourceLocked();
  store().connect(locked);
  const lockedCalls = vi.fn();
  const unsubLocked = useStore.subscribe(lockedCalls);
  store().play();
  store().pause();
  store().setSpeed(10);
  unsubLocked();
  expect(lockedCalls).not.toHaveBeenCalled();
});

test("a source without a clock gets a locked 1x live clock, and the actions change nothing", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  store().connect(new FakeSource());
  expect([store().speed, store().paused, store().locked]).toEqual([1, false, true]);
  expect(store().clock?.locked).toBe(true);
  store().pause();
  store().play();
  store().setSpeed(10);
  expect([store().speed, store().paused]).toEqual([1, false]);
  expect(warn).toHaveBeenCalledTimes(3);
  store().disconnect();
  expect(store().clock).toBeNull();
  store().pause();
});

test("paused and caught up, N ticks deliver nothing and make no store commit", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const m = mockOn();
  store().connect(m.source);
  m.tick();
  store().pause();
  const before = store();
  const calls = vi.fn();
  const unsub = useStore.subscribe(calls);
  const ranges = m.ranges.length;
  for (let i = 0; i < 20; i++) m.tick();
  unsub();
  expect(calls).not.toHaveBeenCalled();
  expect(store()).toBe(before);
  expect(m.ranges.length).toBe(ranges);
  store().play();
  m.tick();
  expect(m.ranges.length).toBe(ranges + 1);
});

test("G18: 10x delivers 10 times the sim range of 1x per tick, and the actions change it as expected", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const m = mockOn();
  store().connect(m.source);
  const range = () => {
    const before = m.ranges.length;
    m.tick();
    if (m.ranges.length === before) return 0;
    const [from, to] = m.ranges.at(-1)!;
    return to - from;
  };
  const at1 = range();
  expect(at1).toBe(250);
  store().setSpeed(10);
  expect(range()).toBe(10 * at1);
  store().setSpeed(60);
  expect(range()).toBe(60 * at1);
  store().pause();
  expect(range()).toBe(0);
  store().setSpeed(1);
  expect(range()).toBe(0);
  store().play();
  expect(range()).toBe(at1);
});

test("G12: live fake, then the mock, then the live fake again equals the live fake alone, 0 duplicates", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const live = () => {
    const source = new FakeSource();
    source.name = "live";
    store().connect(source);
    source.emit(batch(300));
  };
  live();
  const alone = aggregatesOf(store());
  const aloneApplied = store().dataHealth.applied;
  store().connect(mockOn().source);
  expect(store().dataHealth.applied).toBeGreaterThan(300);
  live();
  expect(aggregatesOf(store())).toEqual(alone);
  expect(store().dataHealth.applied).toBe(aloneApplied);
  expect(store().dataHealth.duplicates).toBe(0);
});

test("sourceEpoch increments on every connect, a same-type scenario switch included, and on disconnect", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const start = store().sourceEpoch;
  store().connect(mockOn({ scenario: "steady" }).source);
  expect(store().sourceEpoch).toBe(start + 1);
  store().connect(mockOn({ scenario: "burst" }).source);
  expect(store().sourceEpoch).toBe(start + 2);
  store().connect(new FakeSource());
  expect(store().sourceEpoch).toBe(start + 3);
  store().disconnect();
  expect(store().sourceEpoch).toBe(start + 4);
  store().disconnect();
  expect(store().sourceEpoch).toBe(start + 5);
});

test.each(SCENARIO_NAMES)(
  "%s speed equivalence at T = 1,200 s: aggregates and ring contents match at 1x, 10x and 60x",
  (scenario) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const run = (speed: 1 | 10 | 60) => {
      store().disconnect();
      resetStore();
      const m = mockOn({ speed, scenario });
      store().connect(m.source);
      for (let sim = CATCHUP_MS; sim < 1_200_000; sim += 250 * speed) m.tick();
      expect(m.ranges.at(-1)![1]).toBe(1_200_000);
      return {
        agg: aggregatesOf(store()),
        ring: ringEvents(store().ring),
        applied: store().dataHealth.applied,
      };
    };
    const one = run(1);
    expect(one.ring.length).toBeGreaterThan(1000);
    for (const speed of [10, 60] as const) {
      const other = run(speed);
      expect(other.agg).toEqual(one.agg);
      expect(other.ring).toEqual(one.ring);
      expect(other.applied).toBe(one.applied);
    }
  },
  60_000,
);

// Session-end inference, the 1 s interval and commit-on-change (chunk 13: CEO C77, E51, M9).
const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);

class ClockedSource extends FakeSource {
  readonly clock: SimClock;
  constructor(speed: 1 | 10 | 60 = 1, paused = false, startMs = T0) {
    super();
    this.clock = createSimClock({ realNow: () => Date.now(), startMs, speed, paused });
  }
}

const quiet = (at: number, over: Partial<AgentEvent> = {}): AgentEvent => ({
  id: `q-${at}-${over.sessionId ?? "s1"}`,
  vendor: "claude",
  projectKey: "/work/orbit-api",
  sessionId: "s1",
  parentKnown: true,
  agentKind: "main",
  ts: new Date(at).toISOString(),
  type: "session_start",
  status: "idle",
  provenance: {},
  ...over,
});

const fake = () => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.spyOn(console, "info").mockImplementation(() => {});
};
afterEach(() => vi.useRealTimers());

test("a quiet source idle-ends a session at exactly T + 30 min", () => {
  fake();
  const source = new ClockedSource();
  store().connect(source);
  source.report("live");
  source.emit([quiet(T0, { status: "waiting_user" })]);
  vi.advanceTimersByTime(30 * MIN - 1000);
  expect(store().sessions.get("s1")!.status).toBe("waiting_user");
  vi.advanceTimersByTime(1000);
  expect(store().sessions.get("s1")!.status).toBe("done");
  expect(store().sessions.get("s1")!.inferred!.endAt).toBe(T0 + 30 * MIN);
});

test.each([1, 10, 60] as const)("the end ts is T + 30 min at %ix too (G6)", (speed) => {
  fake();
  const source = new ClockedSource(speed);
  store().connect(source);
  source.report("live");
  source.emit([quiet(T0)]);
  vi.advanceTimersByTime((31 * MIN) / speed);
  expect(store().sessions.get("s1")!.status).toBe("done");
  expect(store().sessions.get("s1")!.inferred!.endAt).toBe(T0 + 30 * MIN);
});

test("connect makes one interval, a second connect replaces it and disconnect clears it", () => {
  fake();
  expect(vi.getTimerCount()).toBe(0);
  store().connect(new ClockedSource());
  expect(vi.getTimerCount()).toBe(1);
  store().connect(new ClockedSource());
  expect(vi.getTimerCount()).toBe(1);
  store().disconnect();
  expect(vi.getTimerCount()).toBe(0);
});

test("after a scenario switch the new source's sessions idle-end again, even on an earlier clock", () => {
  fake();
  const a = new ClockedSource();
  store().connect(a);
  a.report("live");
  a.emit([quiet(T0)]);
  vi.advanceTimersByTime(10 * MIN);
  // The next source starts its own clock back at T0.
  const b = new ClockedSource();
  store().connect(b);
  b.report("live");
  b.emit([quiet(Date.now(), { sessionId: "s2" })]);
  const started = Date.now();
  vi.advanceTimersByTime(31 * MIN);
  expect(store().sessions.has("s1")).toBe(false);
  expect(store().sessions.get("s2")!.status).toBe("done");
  expect(started).toBe(T0 + 10 * MIN);
});

test("a paused clock makes no store commit and infers nothing", () => {
  fake();
  const source = new ClockedSource(1, true);
  store().connect(source);
  source.report("live");
  source.emit([quiet(T0)]);
  const before = store().sessions;
  const calls = vi.fn();
  const unsub = useStore.subscribe(calls);
  vi.advanceTimersByTime(40 * MIN);
  expect(calls).not.toHaveBeenCalled();
  expect(store().sessions).toBe(before);
  store().advanceTo(T0 + 40 * MIN);
  expect(calls).not.toHaveBeenCalled();
  unsub();
});

test("a running clock with no due change makes 0 commits over 20 ticks", () => {
  fake();
  const source = new ClockedSource();
  store().connect(source);
  source.report("live");
  source.emit([quiet(T0)]);
  const calls = vi.fn();
  const unsub = useStore.subscribe(calls);
  vi.advanceTimersByTime(20_000);
  expect(calls).not.toHaveBeenCalled();
  unsub();
});

test("advanceTo ignores a time that is not later than the last call", () => {
  fake();
  const source = new ClockedSource();
  store().connect(source);
  source.report("live");
  source.emit([quiet(T0)]);
  store().advanceTo(T0 + 31 * MIN);
  expect(store().sessions.get("s1")!.status).toBe("done");
  const calls = vi.fn();
  const unsub = useStore.subscribe(calls);
  store().advanceTo(T0 + 31 * MIN);
  store().advanceTo(T0 + 5 * MIN);
  expect(calls).not.toHaveBeenCalled();
  unsub();
});

test("a backfill delivered after now ends nothing while catching up, then ends at last + 30 min", () => {
  fake();
  const source = new ClockedSource(1, false, T0 + 3 * 60 * MIN);
  store().connect(source);
  source.report("catching_up");
  source.emit([quiet(T0, { sessionId: "old" }), quiet(T0 + 10 * MIN, { sessionId: "old2" })]);
  vi.advanceTimersByTime(5000);
  expect(store().sessions.get("old")!.status).toBe("idle");
  source.report("live");
  vi.advanceTimersByTime(1000);
  expect(store().sessions.get("old")!.status).toBe("done");
  expect(store().sessions.get("old")!.inferred!.endAt).toBe(T0 + 30 * MIN);
  expect(store().sessions.get("old2")!.inferred!.endAt).toBe(T0 + 40 * MIN);
});

test("a batch and the inference it triggers commit together", () => {
  fake();
  const source = new ClockedSource(1, false, T0 + 3 * 60 * MIN);
  store().connect(source);
  source.report("live");
  const calls = vi.fn();
  const unsub = useStore.subscribe(calls);
  source.emit([quiet(T0)]);
  expect(calls).toHaveBeenCalledTimes(1);
  expect(store().sessions.get("s1")!.status).toBe("done");
  unsub();
});

test("an event from the future counts as now, so it ends 30 min after now", () => {
  fake();
  const source = new ClockedSource();
  store().connect(source);
  source.report("live");
  source.emit([quiet(T0 + 10 * MIN)]);
  expect(store().sessions.get("s1")!.lastSeen).toBe(T0);
});

test("pausing freezes the derived values and play resumes them from the same point", () => {
  fake();
  const source = new ClockedSource();
  store().connect(source);
  source.report("live");
  source.emit([
    quiet(T0, {
      type: "usage",
      status: undefined,
      tokens: { in: 4000, out: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  ]);
  vi.advanceTimersByTime(10_000);
  store().pause();
  const frozen = store().rates;
  vi.advanceTimersByTime(60_000);
  expect(store().rates).toBe(frozen);
  store().play();
  vi.advanceTimersByTime(10_000);
  expect(store().rates).not.toBe(frozen);
});
