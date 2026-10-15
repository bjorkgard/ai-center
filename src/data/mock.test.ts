import { expect, test, vi } from "vite-plus/test";
import { ANCHOR_MS, CATCHUP_MS, MockSource, mockEvents, type MockSourceOptions } from "./mock.ts";
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

test("an unknown scenario throws", () => {
  expect(() => mockEvents(1, "burst", 0, 1000)).toThrow("unknown scenario");
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
  let clock = CATCHUP_MS;
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
    now: () => clock,
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
    setClock: (ms: number) => (clock = ms),
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
