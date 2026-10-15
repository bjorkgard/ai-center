import { createHash } from "node:crypto";
import { expect, test, vi } from "vite-plus/test";
import { createSimClock, type SimClock } from "./clock.ts";
import {
  ANCHOR_MS,
  CATCHUP_MS,
  MAX_TICK_SIM_MS,
  MockSource,
  createMockSource,
  mockEvents,
  type MockSourceOptions,
} from "./mock.ts";
import { applyBatch, emptyData, aggregatesOf } from "./reduce.ts";
import { AgentEvent, MAX_BATCH, type SourceStatus } from "./schema.ts";

const MIN = 60_000;

test("the same seed gives the same event sequence, another seed another one", () => {
  const a = mockEvents(7, "steady", 0, 5 * MIN);
  expect(mockEvents(7, "steady", 0, 5 * MIN)).toEqual(a);
  expect(mockEvents(8, "steady", 0, 5 * MIN)).not.toEqual(a);
  expect(a.length).toBeGreaterThan(100);
});

test("[0, 10 min) equals [0, 4 min) plus [4 min, 10 min), and so does any odd split", () => {
  const whole = mockEvents(3, "steady", 0, 10 * MIN);
  expect([
    ...mockEvents(3, "steady", 0, 4 * MIN),
    ...mockEvents(3, "steady", 4 * MIN, 10 * MIN),
  ]).toEqual(whole);
  const cut = 123_457;
  expect([...mockEvents(3, "steady", 0, cut), ...mockEvents(3, "steady", cut, 10 * MIN)]).toEqual(
    whole,
  );
  expect(new Set(whole.map((e) => e.id)).size).toBe(whole.length);
});

test("any split of [0, 10 min), mid-slot cuts included, joins to the unsplit output in order", () => {
  const cuts = [88_010, 123_456, 1, 999, 1001, 5_555, 17_321, 30_001, 44_444, 61_999, 77_777];
  for (let i = 0; i < 12; i++) cuts.push(100_003 + i * 41_117);
  for (let seed = 1; seed <= 5; seed++) {
    const whole = mockEvents(seed, "steady", 0, 10 * MIN);
    for (const cut of cuts) {
      const joined = [
        ...mockEvents(seed, "steady", 0, cut),
        ...mockEvents(seed, "steady", cut, 10 * MIN),
      ];
      expect(joined, `seed ${seed} cut ${cut}`).toEqual(whole);
    }
  }
}, 20_000);

test("it never reads the real clock, and every event is valid with ts at the anchor plus sim ms", () => {
  const now = vi.spyOn(Date, "now").mockImplementation(() => {
    throw new Error("Date.now read");
  });
  const events = mockEvents(1, "steady", 0, 2 * MIN);
  now.mockRestore();
  for (const e of events) {
    expect(AgentEvent.safeParse(e).success).toBe(true);
    const ms = Date.parse(e.ts) - ANCHOR_MS;
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(ms).toBeLessThan(2 * MIN);
  }
});

test("the steady scenario has 3 projects, both vendors and subagents", () => {
  const events = mockEvents(1, "steady", 0, 10 * MIN);
  expect(new Set(events.map((e) => e.projectKey)).size).toBe(3);
  expect(new Set(events.map((e) => e.vendor))).toEqual(new Set(["claude", "codex"]));
  expect(events.some((e) => e.agentKind === "sub" && e.parentSessionId)).toBe(true);
});

test("every mock projectKey starts with /work/ and no field holds a path of this machine", () => {
  const events = mockEvents(5, "steady", 0, 10 * MIN);
  for (const e of events) expect(e.projectKey.startsWith("/work/")).toBe(true);
  expect(JSON.stringify(events)).not.toContain(process.cwd());
});

test("an unknown scenario throws naming the valid ones", () => {
  expect(() => mockEvents(1, "nope", 0, 1000)).toThrow(/unknown scenario "nope".*steady.*waiting/);
});

test("the steady stream over [0, 1,200 s) keeps its chunk 11 SHA-256 digests (E36)", () => {
  const digest = (seed: number) =>
    createHash("sha256")
      .update(JSON.stringify(mockEvents(seed, "steady", 0, 1_200_000)))
      .digest("hex");
  expect(digest(1)).toBe("04b76c18f74fcf0a4c3cebc7d54cc05e459e62c28b0164de3234466fd83dd46a");
  expect(digest(42)).toBe("6cc9c1b793e636f33500fddcc48f25567ee204fc3df6b55d258fbb901fbc62c2");
});

test("every event of a session is strictly after its session_start, over seeds 1-50", () => {
  // One expect per seed over a collected list of violations, not one per event.
  const check = (seed: number, from: number, to: number) => {
    const starts = new Map<string, number>();
    const bad: string[] = [];
    for (const e of mockEvents(seed, "steady", 0, to)) {
      const ms = Date.parse(e.ts) - ANCHOR_MS;
      if (e.type === "session_start") starts.set(e.sessionId, ms);
      else if (ms >= from) {
        const start = starts.get(e.sessionId);
        if (start === undefined) bad.push(`${e.sessionId} ${e.type} before its start`);
        else if (ms <= start) bad.push(`${e.sessionId} ${e.type} at ${ms} <= start ${start}`);
      }
    }
    return bad;
  };
  for (let seed = 1; seed <= 50; seed++)
    expect(check(seed, 0, 12 * MIN), `seed ${seed}`).toEqual([]);
  expect(check(3, 0, 90 * 1000)).toEqual([]);
});

test("seed 23 lane 8: the tool call in the sub's first slot comes after its session_start", () => {
  const events = mockEvents(23, "steady", 123_000, 124_000).filter((e) =>
    e.sessionId.includes("sub"),
  );
  const start = events.find((e) => e.type === "session_start");
  expect(start).toBeDefined();
  for (const e of events) {
    if (e !== start) expect(Date.parse(e.ts)).toBeGreaterThan(Date.parse(start!.ts));
  }
});

// A fake sim clock and timer: nothing here waits for real time.
function harness(options: Partial<MockSourceOptions> = {}) {
  // Fake real time, in ms since the harness began; the clock runs at 1x unless a test changes it.
  let real = 0;
  const clock = createSimClock({ realNow: () => real, startMs: ANCHOR_MS + CATCHUP_MS });
  let tick: (() => void) | null = null;
  let lastFn: (() => void) | null = null;
  let cancelled = 0;
  const log: string[] = [];
  const batches: number[] = [];
  const statusAtBatch: (SourceStatus | undefined)[] = [];
  const events: unknown[] = [];
  let status: SourceStatus | undefined;
  const source = new MockSource({
    seed: 1,
    scenario: "steady",
    clock,
    schedule: (fn) => {
      tick = fn;
      lastFn = fn;
      return () => {
        cancelled++;
        tick = null;
      };
    },
    ...options,
  });
  source.onEvents((batch) => {
    batches.push(batch.length);
    statusAtBatch.push(status);
    events.push(...batch);
    log.push(`events ${batch.length}`);
  });
  source.onStatus((s) => {
    status = s;
    log.push(s);
  });
  return {
    source,
    log,
    batches,
    statusAtBatch,
    events,
    clock,
    // Sets the sim ms of a 1x clock that has never been paused or re-sped.
    setClock: (ms: number) => (real = ms - CATCHUP_MS),
    advance: (ms: number) => (real += ms),
    fire: () => lastFn?.(),
    hasTimer: () => tick !== null,
    cancelled: () => cancelled,
  };
}

test("start sends the first 10 sim minutes in batches of at most 500, catching_up then live", () => {
  const h = harness();
  h.source.start();
  expect(h.events).toEqual(mockEvents(1, "steady", 0, CATCHUP_MS));
  expect(h.batches.every((n) => n > 0 && n <= MAX_BATCH)).toBe(true);
  expect(h.log[0]).toBe("catching_up");
  expect(h.log.at(-1)).toBe("live");
  expect(h.log.filter((l) => l === "live")).toHaveLength(1);
  expect(h.statusAtBatch.every((s) => s === "catching_up")).toBe(true);
});

test("a catch-up of 1,200 events arrives as 500, 500 and 200, catching_up until the last", () => {
  const fake = Array.from({ length: 1200 }, (_, i) => ({
    ...mockEvents(1, "steady", 0, 1000)[0],
    id: `x${i}`,
  }));
  const h = harness({ generate: (_s, _sc, from) => (from === 0 ? fake : []) });
  h.source.start();
  expect(h.batches).toEqual([500, 500, 200]);
  expect(h.statusAtBatch).toEqual(["catching_up", "catching_up", "catching_up"]);
  expect(h.log).toEqual(["catching_up", "events 500", "events 500", "events 200", "live"]);
});

test("every tick sends the events between the last and the current clock", () => {
  const h = harness();
  h.source.start();
  const caught = h.events.length;
  h.setClock(CATCHUP_MS + 250);
  h.fire();
  h.setClock(CATCHUP_MS + 500);
  h.fire();
  expect(h.events.slice(caught)).toEqual(mockEvents(1, "steady", CATCHUP_MS, CATCHUP_MS + 500));
});

test("a tick of 1,200 events arrives as 500, 500 and 200", () => {
  const fake = (from: number) =>
    Array.from({ length: 1200 }, (_, i) => ({
      ...mockEvents(1, "steady", 0, 1000)[0],
      id: `t${from}-${i}`,
    }));
  const h = harness({ generate: (_s, _sc, from) => (from === 0 ? [] : fake(from)) });
  h.source.start();
  expect(h.batches).toEqual([]);
  h.setClock(CATCHUP_MS + 250);
  h.fire();
  expect(h.batches).toEqual([500, 500, 200]);
});

test("paused and behind, ticks drain the backlog under the cap; after play the stream has no gap or duplicate", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const ranges: [number, number][] = [];
  const h = harness({
    generate: (seed, scenario, from, to) => (
      ranges.push([from, to]),
      mockEvents(seed, scenario, from, to)
    ),
  });
  h.source.start();
  h.advance(130_000);
  h.clock.pause();
  h.advance(500_000);
  for (let i = 0; i < 6; i++) h.fire();
  const drained = ranges.slice(1);
  expect(drained).toEqual([
    [CATCHUP_MS, CATCHUP_MS + 60_000],
    [CATCHUP_MS + 60_000, CATCHUP_MS + 120_000],
    [CATCHUP_MS + 120_000, CATCHUP_MS + 130_000],
  ]);
  const count = h.events.length;
  h.clock.play();
  h.advance(10_000);
  h.fire();
  expect(ranges.at(-1)).toEqual([CATCHUP_MS + 130_000, CATCHUP_MS + 140_000]);
  expect(h.events.length).toBeGreaterThan(count);
  expect(h.events).toEqual(mockEvents(1, "steady", 0, CATCHUP_MS + 140_000));
});

test("10 real minutes at 60x in one step: no tick over 60 sim s, catching_up then live, aggregates equal an uncapped run", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const ranges: [number, number][] = [];
  const h = harness({
    generate: (seed, scenario, from, to) => (
      ranges.push([from, to]),
      mockEvents(seed, scenario, from, to)
    ),
  });
  h.clock.setSpeed(60);
  h.source.start();
  expect(h.log.at(-1)).toBe("live");
  h.log.length = 0;
  h.advance(10 * MIN);
  const target = CATCHUP_MS + 600 * MIN;
  for (let i = 0; i < 700; i++) h.fire();
  const ticks = ranges.slice(1);
  expect(Math.max(...ticks.map(([a, b]) => b - a))).toBeLessThanOrEqual(MAX_TICK_SIM_MS);
  expect(ticks.at(-1)![1]).toBe(target);
  expect(h.log.filter((l) => !l.startsWith("events"))).toEqual(["catching_up", "live"]);
  const uncapped = mockEvents(1, "steady", 0, target);
  expect(h.events).toEqual(uncapped);
  const reduce = (events: unknown[]) => {
    let state = emptyData();
    for (let i = 0; i < events.length; i += MAX_BATCH)
      state = applyBatch(state, events.slice(i, i + MAX_BATCH) as AgentEvent[]);
    return aggregatesOf(state);
  };
  expect(reduce(h.events)).toEqual(reduce(uncapped));
}, 60_000);

test("1 Hz ticks at 60x, exactly one cap each, cause no status change", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  const h = harness();
  h.clock.setSpeed(60);
  h.source.start();
  h.log.length = 0;
  for (let i = 0; i < 60; i++) {
    h.advance(1000);
    h.fire();
  }
  expect(h.log.filter((l) => !l.startsWith("events"))).toEqual([]);
  expect(h.events).toEqual(mockEvents(1, "steady", 0, CATCHUP_MS + 3_600_000));
});

test("hidden then visible delivers a continuous stream; a user pause survives the tab returning", () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  let setHidden: (hidden: boolean) => void = () => {};
  let unwatched = 0;
  const h = harness({
    visibility: (cb) => {
      setHidden = cb;
      return () => unwatched++;
    },
  });
  h.source.start();
  h.advance(5000);
  h.fire();
  setHidden(true);
  h.advance(600_000);
  h.fire();
  h.fire();
  expect(h.events).toEqual(mockEvents(1, "steady", 0, CATCHUP_MS + 5000));
  setHidden(false);
  h.advance(3000);
  h.fire();
  expect(h.events).toEqual(mockEvents(1, "steady", 0, CATCHUP_MS + 8000));
  h.clock.pause();
  setHidden(true);
  setHidden(false);
  expect(h.clock.paused).toBe(true);
  h.advance(60_000);
  h.fire();
  expect(h.events).toEqual(mockEvents(1, "steady", 0, CATCHUP_MS + 8000));
  h.source.stop();
  expect(unwatched).toBe(1);
});

test("a generator that throws during the catch-up reports error once and schedules no timer", () => {
  const h = harness({
    scenario: "burst",
    generate: () => {
      throw new RangeError("SECRET-VALUE");
    },
  });
  let detail = "";
  h.source.onStatus((s, d) => {
    if (s === "error") detail = d ?? "";
    h.log.push(`status ${s}`);
  });
  h.source.start();
  expect(h.log.filter((l) => l === "status error")).toHaveLength(1);
  expect(h.log).not.toContain("status live");
  expect(h.hasTimer()).toBe(false);
  expect(detail).toContain("burst");
  expect(detail).toContain("0-600000");
  expect(detail).not.toContain("SECRET-VALUE");
});

test("a generator that throws on a tick reports error once, cancels the timer and stops ticking", () => {
  let fail = false;
  const h = harness({
    generate: (seed, scenario, from, to) => {
      if (fail) throw new TypeError("boom");
      return mockEvents(seed, scenario, from, to);
    },
  });
  let errors = 0;
  let detail = "";
  h.source.onStatus((s, d) => {
    if (s === "error") {
      errors++;
      detail = d ?? "";
    }
  });
  h.source.start();
  fail = true;
  h.advance(250);
  h.fire();
  const seen = h.events.length;
  h.advance(250);
  h.fire();
  h.fire();
  expect(errors).toBe(1);
  expect(detail).toContain("steady");
  expect(detail).toContain(`${CATCHUP_MS}-${CATCHUP_MS + 250}`);
  expect(h.hasTimer()).toBe(false);
  expect(h.cancelled()).toBe(1);
  expect(h.events.length).toBe(seen);
});

test("a batch callback that throws is rescued the same way", () => {
  const h = harness();
  let calls = 0;
  let errors = 0;
  h.source.onEvents(() => {
    if (++calls > 5) throw new Error("sink");
  });
  h.source.onStatus((s) => {
    if (s === "error") errors++;
  });
  h.source.start();
  expect(errors).toBe(1);
  expect(h.hasTimer()).toBe(false);
});

test("a failure leaves the source not running, unwatches the tab and lets it start again", () => {
  let unwatched = 0;
  let fail = false;
  const h = harness({
    visibility: () => () => unwatched++,
    generate: (seed, scenario, from, to) => {
      if (fail) throw new TypeError("boom");
      return mockEvents(seed, scenario, from, to);
    },
  });
  h.source.start();
  fail = true;
  h.advance(250);
  h.fire();
  expect(h.log.filter((l) => l === "closed")).toHaveLength(0);
  expect(unwatched).toBe(1);
  h.source.stop();
  expect(h.log.filter((l) => l === "closed")).toHaveLength(0);
  fail = false;
  h.log.length = 0;
  h.source.start();
  expect(h.log[0]).toBe("catching_up");
  expect(h.log.at(-1)).toBe("live");
  h.source.stop();
  expect(unwatched).toBe(2);
});

test("a batch callback that throws during a tick reports error once and stops ticking", () => {
  let unwatched = 0;
  const h = harness({ visibility: () => () => unwatched++ });
  let throwing = false;
  let errors = 0;
  let detail = "";
  h.source.onEvents(() => {
    if (throwing) throw new Error("SECRET-VALUE");
  });
  h.source.onStatus((s, d) => {
    if (s === "error") {
      errors++;
      detail = d ?? "";
    }
  });
  h.source.start();
  throwing = true;
  h.advance(2000);
  h.fire();
  h.advance(250);
  h.fire();
  h.fire();
  expect(errors).toBe(1);
  expect(detail).toContain("steady");
  expect(detail).not.toContain("SECRET-VALUE");
  expect(h.hasTimer()).toBe(false);
  expect(h.cancelled()).toBe(1);
  expect(unwatched).toBe(1);
});

test("createMockSource makes a fresh clock at the catch-up end and never reads performance.now itself", () => {
  const perf = vi.spyOn(performance, "now").mockImplementation(() => {
    throw new Error("performance.now read");
  });
  let real = 100;
  const a = createMockSource({
    seed: 1,
    scenario: "steady",
    freeze: false,
    speed: 10,
    realNow: () => real,
  });
  const b = createMockSource({ seed: 1, scenario: "steady", freeze: false, realNow: () => real });
  expect(a.clock).not.toBe(b.clock);
  expect(a.clock.now()).toBe(ANCHOR_MS + CATCHUP_MS);
  expect(a.clock.speed).toBe(10);
  expect(a.clock.paused).toBe(false);
  expect(a.clock.locked).toBe(false);
  real += 1000;
  expect(a.clock.now()).toBe(ANCHOR_MS + CATCHUP_MS + 10_000);
  expect(perf).not.toHaveBeenCalled();
});

test("under freeze the clock starts paused and locked at the catch-up end with speed 1 whatever the URL says", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  let real = 0;
  const source = createMockSource({
    seed: 1,
    scenario: "steady",
    freeze: true,
    speed: 60,
    realNow: () => real,
  });
  const clock: SimClock = source.clock;
  expect([clock.paused, clock.locked, clock.speed]).toEqual([true, true, 1]);
  real += 60_000;
  expect(clock.now()).toBe(ANCHOR_MS + CATCHUP_MS);
  clock.play();
  expect(clock.paused).toBe(true);
});

test("a clock that repeats or goes back sends no events", () => {
  const h = harness();
  h.source.start();
  const before = h.events.length;
  h.fire();
  h.setClock(CATCHUP_MS - 5000);
  h.fire();
  h.setClock(CATCHUP_MS + 1000);
  h.fire();
  const after = h.events.length;
  expect(after).toBeGreaterThan(before);
  h.setClock(CATCHUP_MS + 1000);
  h.fire();
  h.setClock(CATCHUP_MS + 400);
  h.fire();
  expect(h.events.length).toBe(after);
});

test("stop twice is safe and nothing arrives after it, even from a late timer", () => {
  const h = harness();
  h.source.start();
  h.setClock(CATCHUP_MS + 250);
  h.fire();
  const late = h.fire;
  h.source.stop();
  h.source.stop();
  expect(h.log.filter((l) => l === "closed")).toHaveLength(1);
  const seen = h.log.length;
  h.setClock(CATCHUP_MS + 5000);
  late();
  h.setClock(CATCHUP_MS + 9000);
  late();
  expect(h.log).toHaveLength(seen);
  expect(h.cancelled()).toBeGreaterThan(0);
});

test("stop during the catch-up delivers nothing more", () => {
  const h = harness({
    generate: (_s, _sc, from) =>
      from === 0
        ? Array.from({ length: 1200 }, (_, i) => ({
            ...mockEvents(1, "steady", 0, 1000)[0],
            id: `y${i}`,
          }))
        : [],
  });
  let got = 0;
  h.source.onEvents(() => {
    got++;
    h.source.stop();
  });
  h.source.start();
  expect(got).toBe(1);
  expect(h.log).toEqual(["catching_up", "closed"]);
});

test("under freeze it sends only the catch-up and sets no timer", () => {
  const h = harness({ freeze: true });
  h.source.start();
  expect(h.hasTimer()).toBe(false);
  expect(h.events).toEqual(mockEvents(1, "steady", 0, CATCHUP_MS));
  expect(h.log.at(-1)).toBe("live");
});

test("start on a running source is a no-op", () => {
  const h = harness();
  h.source.start();
  const count = h.log.length;
  h.source.start();
  expect(h.log).toHaveLength(count);
});

test("stopping and restarting 20 times, then one more start, ends in the state of one clean run", () => {
  const h = harness();
  for (let i = 0; i < 20; i++) {
    h.source.start();
    h.source.stop();
  }
  h.events.length = 0;
  h.log.length = 0;
  h.source.start();
  const fresh = harness();
  fresh.source.start();
  expect(h.events).toEqual(fresh.events);
  expect(h.log).toEqual(fresh.log);
  expect(h.log.at(-1)).toBe("live");
  expect(h.hasTimer()).toBe(true);
});

test("a stop() inside the live callback leaves no timer running", () => {
  const h = harness();
  h.source.onStatus((s) => {
    if (s === "live") h.source.stop();
  });
  h.source.start();
  expect(h.hasTimer()).toBe(false);
});
