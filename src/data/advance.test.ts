import { expect, test } from "vite-plus/test";
import { IDLE_END_MS } from "../config/estimation.ts";
import {
  coolingDuty,
  cost,
  hallHeat,
  hallInlet,
  hotAisle,
  racksOf,
  tokensPerMin,
} from "./metrics.ts";
import { ANCHOR_MS, mockEvents } from "./mock.ts";
import {
  TOMBSTONE_CAP,
  advance,
  applyBatch,
  emptyData,
  integrateInlet,
  rateKey,
  type DataState,
} from "./reduce.ts";
import { SCENARIO_NAMES } from "./scenarios.ts";
import type { AgentEvent } from "./schema.ts";
import { createRng } from "../sim/rng.ts";

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
const MIN = 60_000;
let n = 0;
function ev(over: Partial<AgentEvent> & { at?: number } = {}): AgentEvent {
  n++;
  const { at = 0, ...rest } = over;
  return {
    id: `a${String(n).padStart(7, "0")}`,
    vendor: "claude",
    projectKey: "/work/orbit-api",
    sessionId: "s1",
    parentKnown: true,
    agentKind: "main",
    model: "claude-sonnet-4",
    ts: new Date(T0 + at).toISOString(),
    type: "tool_call",
    provenance: {},
    ...rest,
  };
}
const tok = (i: number, o = 0) => ({ in: i, out: o, cacheRead: 0, cacheWrite: 0 });
const inletOf = (s: DataState, id = "s1") => s.rates.get(rateKey("main", id))!.inletC;

test("a session ends at exactly its last activity + 30 min, whatever the tick size (G6)", () => {
  const ends = [1000, 10_000, 60_000].map((step) => {
    let s = applyBatch(emptyData(), [ev({ at: 5000, status: "waiting_user" })]);
    let doneAt = -1;
    for (let now = T0 + 5000; now <= T0 + 40 * MIN && doneAt < 0; now += step) {
      s = advance(s, now);
      if (s.sessions.get("s1")!.status === "done") doneAt = now;
    }
    expect(doneAt).toBeGreaterThanOrEqual(T0 + 5000 + IDLE_END_MS);
    expect(doneAt).toBeLessThan(T0 + 5000 + IDLE_END_MS + step);
    return s.sessions.get("s1")!.inferred!.endAt;
  });
  expect(ends).toEqual([T0 + 5000 + IDLE_END_MS, T0 + 5000 + IDLE_END_MS, T0 + 5000 + IDLE_END_MS]);
});

test("a session is not ended 1 ms early, and waiting_user holds until then", () => {
  const s = applyBatch(emptyData(), [ev({ status: "waiting_user" })]);
  expect(advance(s, T0 + IDLE_END_MS - 1).sessions.get("s1")!.status).toBe("waiting_user");
  expect(advance(s, T0 + IDLE_END_MS).sessions.get("s1")!.status).toBe("done");
});

test("advance returns the very same state when nothing changed", () => {
  const s = applyBatch(emptyData(), [ev({ type: "session_start", status: "idle" })]);
  expect(advance(s, T0 + 1000)).toBe(s);
  expect(advance(s, T0 + 20_000)).toBe(s);
  expect(advance(emptyData(), T0)).toEqual(emptyData());
});

test("a 10-minute jump equals 600 one-second advances to within 1e-9 C (E57)", () => {
  const events = [
    ev({ at: 0, tokens: tok(3000, 500) }),
    ev({ at: 7000, tokens: tok(9000) }),
    ev({ at: 31_000, tokens: tok(200) }),
    ev({
      sessionId: "sub",
      agentKind: "sub",
      parentSessionId: "s1",
      at: 12_000,
      tokens: tok(4000),
    }),
  ];
  const start = applyBatch(emptyData(), events);
  const jump = advance(start, T0 + 10 * MIN);
  let stepped = start;
  for (let t = 1; t <= 600; t++) stepped = advance(stepped, T0 + t * 1000);
  expect(Math.abs(inletOf(jump) - inletOf(stepped))).toBeLessThan(1e-9);
  // Mid-run too, while the window is still non-empty.
  const mid = advance(start, T0 + 40_000);
  let midStepped = start;
  for (let t = 1; t <= 40; t++) midStepped = advance(midStepped, T0 + t * 1000);
  expect(Math.abs(inletOf(mid) - inletOf(midStepped))).toBeLessThan(1e-9);
});

test("the lag steps per second while the window has tokens, then decays in closed form", () => {
  const buckets = new Map([[100, 10_000]]);
  const base = 22 + 0.25 * 0.8;
  const target = 22 + 0.25 * Math.min(40, 0.8 + 0.004 * 10_000);
  // Seconds 100..159 see the 10,000 tokens, 160 on see none.
  let v = base;
  for (let k = 100; k < 160; k++) v = target + (v - target) * Math.exp(-1 / 30);
  for (let k = 160; k < 200; k++) v = base + (v - base) * Math.exp(-1 / 30);
  expect(integrateInlet(base, buckets, 100, 200)).toBeCloseTo(v, 12);
  // Long after, it is back at the idle baseline exactly.
  expect(integrateInlet(v, new Map(), 200, 5000)).toBe(base);
});

test("an out-of-order batch gives the same rack state as the sorted one", () => {
  const sorted = mockEvents(2, "steady", 0, 4 * MIN).slice(0, 500);
  const shuffled = [...sorted];
  const rng = createRng(9);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const now = Date.parse(sorted.at(-1)!.ts) + 1000;
  const a = advance(applyBatch(emptyData(), sorted), now);
  const b = advance(applyBatch(emptyData(), shuffled), now);
  expect(b.rates).toEqual(a.rates);
  expect(b.sessions).toEqual(a.sessions);
});

test("an event older than the last advance counts as that moment; one from the future counts as now", () => {
  const mark = T0 + 100_000;
  const late = applyBatch(emptyData(), [ev({ at: 0, tokens: tok(500) })], { now: mark, mark });
  expect([...late.rates.get(rateKey("main", "s1"))!.buckets.keys()]).toEqual([mark / 1000]);
  expect(late.sessions.get("s1")!.lastSeen).toBe(T0);
  const future = applyBatch(emptyData(), [ev({ at: 500_000, tokens: tok(500) })], {
    now: T0 + 5000,
  });
  expect(future.sessions.get("s1")!.lastSeen).toBe(T0 + 5000);
  expect([...future.rates.get(rateKey("main", "s1"))!.buckets.keys()]).toEqual([T0 / 1000 + 5]);
});

test("a late event inside the 30-minute window reopens the session; a later one resumes it", () => {
  const ended = advance(
    applyBatch(emptyData(), [ev({ at: 0, status: "waiting_user" }), ev({ at: 20 * MIN })]),
    T0 + 60 * MIN,
  );
  expect(ended.sessions.get("s1")!.status).toBe("done");
  expect(ended.sessions.get("s1")!.inferred!.endAt).toBe(T0 + 50 * MIN);

  // 45 min is before the inferred end at 50 min: the session never ended.
  const reopened = applyBatch(ended, [ev({ at: 45 * MIN, type: "usage", tokens: tok(1) })]);
  const s = reopened.sessions.get("s1")!;
  expect(s.inferred).toBeUndefined();
  expect(s.status).not.toBe("done");
  // Its new end is recomputed from the new last activity.
  expect(advance(reopened, T0 + 50 * MIN + 1).sessions.get("s1")!.status).not.toBe("done");
  expect(advance(reopened, T0 + 75 * MIN).sessions.get("s1")!.inferred!.endAt).toBe(
    T0 + 45 * MIN + IDLE_END_MS,
  );

  // 55 min is after it: the session had ended and now resumes.
  const resumed = applyBatch(ended, [ev({ at: 55 * MIN, type: "turn_start", status: "thinking" })]);
  expect(resumed.sessions.get("s1")!.status).toBe("thinking");
  expect(resumed.sessions.get("s1")!.inferred).toBeUndefined();
});

test("nothing is inferred while the source catches up; the backlog then ends at last + 30 min", () => {
  const backlog = applyBatch(emptyData(), [ev({ at: 0, tokens: tok(10) })]);
  const now = T0 + 3 * 60 * MIN;
  expect(advance(backlog, now, { catchingUp: true })).toBe(backlog);
  const live = advance(backlog, now);
  expect(live.sessions.get("s1")).toMatchObject({ status: "done" });
  expect(live.sessions.get("s1")!.inferred!.endAt).toBe(T0 + IDLE_END_MS);
});

test("a done session still in the ring is kept; once the ring has moved on it is evicted", () => {
  let s = emptyData(3);
  s = applyBatch(s, [ev({ type: "session_end", tokens: tok(7) }), ev({ at: 1 })]);
  expect(advance(s, T0 + 10 * MIN).sessions.has("s1")).toBe(true);
  s = applyBatch(s, [ev({ sessionId: "s2", at: 2 }), ev({ sessionId: "s2", at: 3 })]);
  s = applyBatch(s, [ev({ sessionId: "s2", at: 4 })]);
  expect(s.ring.refs.has("s1")).toBe(false);
  const out = advance(s, T0 + 10 * MIN);
  expect(out.sessions.has("s1")).toBe(false);
  expect(out.rates.has(rateKey("main", "s1"))).toBe(false);
  expect(out.tombstones.has(rateKey("main", "s1"))).toBe(true);
  // Totals do not move.
  expect(out.tokens).toEqual(s.tokens);
  expect(out.projects).toEqual(s.projects);
  expect(cost(out).value).toBeCloseTo(cost(s).value!, 9);
});

test("an evicted session's jobs go with it", () => {
  let s = emptyData(2);
  s = applyBatch(s, [ev({ type: "turn_start" }), ev({ type: "session_end", at: 1 })]);
  expect([...s.jobs.values()].map((j) => j.sessionId)).toEqual(["s1"]);
  s = applyBatch(s, [ev({ sessionId: "s2", at: 2 }), ev({ sessionId: "s2", at: 3 })]);
  expect([...s.jobs.values()].map((j) => j.sessionId).sort()).toEqual(["s1", "s2"]);
  expect([...advance(s, T0 + MIN).jobs.values()].map((j) => j.sessionId)).toEqual(["s2"]);
});

test("a tombstoned id comes back active without a second session count, totals exact", () => {
  let s = emptyData(2);
  s = applyBatch(s, [ev({ type: "session_end", tokens: tok(7) })]);
  s = applyBatch(s, [ev({ sessionId: "s2", at: 1 }), ev({ sessionId: "s2", at: 2 })]);
  s = advance(s, T0 + MIN);
  expect(s.sessions.has("s1")).toBe(false);
  const before = s.projects.get("/work/orbit-api")!;
  s = applyBatch(s, [ev({ at: 3, type: "usage", tokens: tok(5) })]);
  const back = s.sessions.get("s1")!;
  expect(back.status).toBe("idle");
  // Per-session counters restart at 0; project and global totals stay exact.
  expect(back.tokens.in).toBe(5);
  expect(s.projects.get("/work/orbit-api")!.sessions).toBe(before.sessions);
  expect(s.projects.get("/work/orbit-api")!.tokens.in).toBe(12);
  expect(s.tokens.in).toBe(12);
  expect(s.tombstones.has(rateKey("main", "s1"))).toBe(false);
});

test("the tombstone set holds 100,000 ids; an id dropped from it returns as a new session", () => {
  const events = Array.from({ length: TOMBSTONE_CAP + 20 }, (_, i) =>
    ev({ sessionId: `x${i}`, type: "session_end", at: i % 1000 }),
  );
  let s = applyBatch(emptyData(10), events);
  s = advance(s, T0 + MIN);
  expect(s.tombstones.size).toBe(TOMBSTONE_CAP);
  expect(s.tombstones.has(rateKey("main", "x0"))).toBe(false);
  expect(s.tombstones.has(rateKey("main", `x${TOMBSTONE_CAP - 1}`))).toBe(true);
  const sessions = s.projects.get("/work/orbit-api")!.sessions;
  s = applyBatch(s, [ev({ sessionId: "x0", at: 5000 })]);
  expect(s.projects.get("/work/orbit-api")!.sessions).toBe(sessions + 1);
}, 30_000);

test("a session idle-ends, is evicted, then gets an event 40 min later: counts and totals match an uncompacted run", () => {
  const run = (cap: number) => {
    let s = emptyData(cap);
    s = applyBatch(s, [
      ev({ tokens: tok(100, 20) }),
      ev({ sessionId: "s2", at: 1, tokens: tok(1) }),
    ]);
    s = applyBatch(s, [ev({ sessionId: "s2", at: 2 }), ev({ sessionId: "s2", at: 3 })]);
    s = advance(s, T0 + 31 * MIN);
    const evicted = !s.sessions.has("s1");
    s = applyBatch(s, [ev({ at: 40 * MIN, tokens: tok(50) })], { now: T0 + 40 * MIN });
    s = advance(s, T0 + 41 * MIN);
    return { s, evicted };
  };
  const small = run(2);
  const big = run(1000);
  expect(small.evicted).toBe(true);
  expect(big.evicted).toBe(false);
  expect(small.s.projects).toEqual(big.s.projects);
  expect(small.s.tokens).toEqual(big.s.tokens);
  expect(cost(small.s).value).toBeCloseTo(cost(big.s).value!, 6);
  expect(small.s.sessions.get("s1")!.status).toBe("idle");
});

test("a 2-hour churn run at 60x keeps the maps bounded with totals equal to an uncompacted run", () => {
  const run = (cap: number) => {
    let s = emptyData(cap);
    let mark: number | undefined;
    let peak = 0;
    for (let t = 0; t < 7200; t += 60) {
      const now = ANCHOR_MS + t * 1000 + 60_000;
      s = applyBatch(s, mockEvents(1, "churn", t * 1000, t * 1000 + 60_000), { now, mark });
      s = advance(s, now);
      mark = now;
      peak = Math.max(peak, s.sessions.size + s.subagents.size);
    }
    return { s, peak };
  };
  const small = run(300);
  const big = run(50_000);
  expect(small.s.projects).toEqual(big.s.projects);
  expect(small.s.tokens).toEqual(big.s.tokens);
  expect(cost(small.s).value).toBeCloseTo(cost(big.s).value!, 6);
  expect(small.s.dataHealth.applied).toBe(big.s.dataHealth.applied);
  // At most the active sessions plus those the ring still references (or with live buckets).
  const bound = (s: DataState) =>
    [...s.sessions.values(), ...s.subagents.values()].filter(
      (x) => x.status !== "done" || s.ring.refs.has(x.sessionId),
    ).length;
  expect(small.s.sessions.size + small.s.subagents.size).toBeLessThanOrEqual(bound(small.s) + 10);
  expect(small.peak).toBeLessThan(big.peak);
  expect(small.s.sessions.size + small.s.subagents.size).toBeLessThan(
    big.s.sessions.size + big.s.subagents.size,
  );
}, 60_000);

// Feeds a scenario in ticks of `stepMs` the way a source at 1x, 10x or 60x would: the 10 sim
// minute catch-up in one batch, then [prev, now) every tick, advancing after each batch.
function drive(scenario: string, stepMs: number, endMs: number): DataState {
  const catchUp = 600_000;
  let s = emptyData();
  const first = ANCHOR_MS + catchUp;
  s = advance(applyBatch(s, mockEvents(7, scenario, 0, catchUp), { now: first }), first);
  let mark = first;
  for (let t = catchUp; t < endMs; t += stepMs) {
    const now = ANCHOR_MS + t + stepMs;
    s = applyBatch(s, mockEvents(7, scenario, t, t + stepMs), { now, mark });
    s = advance(s, now);
    mark = now;
  }
  return s;
}

test.each(SCENARIO_NAMES)(
  "%s: every derived selector is identical at 1x, 10x and 60x at T = 1,200 s",
  (scenario) => {
    const at = ANCHOR_MS + 1_200_000;
    const read = (s: DataState) => {
      const projects = [...s.projects.keys()].sort();
      return JSON.parse(
        JSON.stringify({
          tpm: tokensPerMin(s, at).value,
          cost: cost(s).value,
          duty: coolingDuty(s, at).value,
          racks: racksOf(s, at)
            .map((r) => ({ ...r, inletC: Math.round(r.inletC * 1e9) / 1e9 }))
            .sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1)),
          halls: projects.map((p) => [
            p,
            hallHeat(s, p, at).value,
            Math.round(hallInlet(s, p, at).value! * 1e9),
            Math.round(hotAisle(s, p, at).value! * 1e9),
          ]),
          status: [...s.sessions.values()].map((x) => [x.sessionId, x.status, x.inferred?.endAt]),
        }),
      );
    };
    const one = read(drive(scenario, 1000, 1_200_000));
    expect(one.racks.length).toBeGreaterThan(0);
    for (const step of [10_000, 60_000]) {
      expect(read(drive(scenario, step, 1_200_000)), `${step} ms ticks`).toEqual(one);
    }
  },
  60_000,
);

test("a done rack's inlet keeps integrating: a resumed session matches one that never ended, at any tick size", () => {
  const run = (stepMs: number, ended: boolean) => {
    let s = applyBatch(emptyData(), [
      ev({ at: 0, tokens: tok(6000), type: "usage" }),
      ...(ended ? [ev({ at: 1000, type: "session_end" })] : []),
    ]);
    for (let t = stepMs; t <= 100_000; t += stepMs) s = advance(s, T0 + t);
    s = applyBatch(s, [ev({ at: 100_000, tokens: tok(6000), type: "usage" })], {
      now: T0 + 100_000,
      mark: T0 + 100_000,
    });
    s = advance(s, T0 + 105_000);
    return inletOf(s);
  };
  const never = run(1000, false);
  for (const step of [1000, 20_000, 60_000]) expect(run(step, true)).toBeCloseTo(never, 9);
});

// A session leaves the store once done and out of the ring (ring of 2, two events of another).
const evict = (s: DataState, id: string, at = 100): DataState =>
  advance(
    applyBatch(s, [ev({ sessionId: `${id}-x`, at }), ev({ sessionId: `${id}-x`, at: at + 1 })]),
    T0 + 2 * MIN,
  );

test("evicting a known-model session never turns the cost into null or drops it", () => {
  let s = emptyData(2);
  s = applyBatch(s, [
    ev({ sessionId: "k", type: "session_end", tokens: tok(1_000_000) }),
    ev({ sessionId: "u", model: "mystery", at: 1, tokens: tok(10) }),
  ]);
  const before = cost(s);
  s = evict(s, "k");
  expect(s.sessions.has("k")).toBe(false);
  const after = cost(s);
  expect(after.value).toBeCloseTo(3, 9);
  expect(after.value).toBeCloseTo(before.value!, 9);
  expect(after.basis).toContain("excludes 1 sessions with unknown model");
  // And only known sessions, all evicted: still a value.
  let k = emptyData(2);
  k = applyBatch(k, [ev({ sessionId: "k", type: "session_end", tokens: tok(1_000_000) })]);
  k = evict(k, "k");
  expect(cost(k).value).toBeCloseTo(3, 9);
});

test("tokens that arrive before the session names a model are priced at that model", () => {
  const s = applyBatch(emptyData(), [
    ev({ model: undefined, at: 0, tokens: tok(1_000_000) }),
    ev({ model: "claude-sonnet-4", at: 1, type: "turn_start" }),
  ]);
  const c = cost(s);
  expect(c.value).toBeCloseTo(3, 9);
  expect(c.basis).not.toContain("excludes");
  // A session that never names one is unknown, not $0.
  const none = applyBatch(emptyData(), [ev({ model: undefined, tokens: tok(1_000_000) })]);
  expect(cost(none).value).toBeNull();
  const mixed = applyBatch(none, [ev({ sessionId: "k", tokens: tok(1_000_000), at: 1 })]);
  expect(cost(mixed).value).toBeCloseTo(3, 9);
  expect(cost(mixed).basis).toContain("excludes 1 sessions with unknown model");
});

test("a reactivated unknown-model session counts once in excludes N", () => {
  let s = emptyData(2);
  s = applyBatch(s, [
    ev({ sessionId: "k", tokens: tok(1_000_000), at: 0 }),
    ev({ sessionId: "u", model: "mystery", type: "session_end", at: 1, tokens: tok(10) }),
  ]);
  s = evict(s, "u", 10);
  expect(s.sessions.has("u")).toBe(false);
  expect(cost(s).basis).toContain("excludes 1 sessions");
  s = applyBatch(s, [ev({ sessionId: "u", model: "mystery", at: 200, tokens: tok(5) })]);
  expect(s.sessions.has("u")).toBe(true);
  expect(cost(s).basis).toContain("excludes 1 sessions");
  expect(cost(s).basis).not.toContain("excludes 2");
});
