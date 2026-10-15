import { expect, test } from "vite-plus/test";
import { createRng } from "../sim/rng.ts";
import { mockEvents } from "./mock.ts";
import {
  NO_EVENTS,
  applyBatch,
  createRing,
  emptyData,
  noSessionsText,
  peekEvents,
  ringEvents,
  sessionList,
  totalInvalid,
  validate,
  type DataState,
} from "./reduce.ts";
import type { AgentEvent } from "./schema.ts";

let n = 0;
function ev(over: Partial<AgentEvent> = {}): AgentEvent {
  n++;
  return {
    id: `e${n}`,
    vendor: "claude",
    projectKey: "/work/orbit-api",
    sessionId: "s1",
    parentKnown: true,
    agentKind: "main",
    ts: new Date(Date.UTC(2026, 0, 1, 9, 0, n)).toISOString(),
    type: "tool_call",
    provenance: {},
    ...over,
  };
}
const tok = (i: number, o: number) => ({ in: i, out: o, cacheRead: 1, cacheWrite: 2 });
const aggregates = (s: DataState) => ({
  projects: s.projects,
  sessions: s.sessions,
  subagents: s.subagents,
  tokens: s.tokens,
});

test("a fixed fixture gives the expected session counts and token totals", () => {
  const events = [
    ev({ sessionId: "a", type: "usage", tokens: tok(10, 5) }),
    ev({ sessionId: "a", type: "usage", tokens: tok(20, 5) }),
    ev({ sessionId: "b", projectKey: "/work/lumen-web", vendor: "codex", tokens: tok(1, 1) }),
    ev({
      sessionId: "c",
      agentKind: "sub",
      parentSessionId: "a",
      type: "usage",
      tokens: tok(4, 4),
    }),
  ];
  const s = applyBatch(emptyData(), events);
  expect(s.sessions.size).toBe(2);
  expect(s.subagents.size).toBe(1);
  expect(s.projects.size).toBe(2);
  expect(s.projects.get("/work/orbit-api")).toMatchObject({ sessions: 1, subagents: 1, events: 3 });
  expect(s.sessions.get("a")).toMatchObject({
    events: 2,
    tokens: { in: 30, out: 10, cacheRead: 2, cacheWrite: 4 },
  });
  expect(s.tokens).toEqual({ in: 35, out: 15, cacheRead: 4, cacheWrite: 8 });
  expect(s.dataHealth.applied).toBe(4);
});

test("an empty batch returns the very same state", () => {
  const s = emptyData();
  expect(applyBatch(s, [])).toBe(s);
});

test("the same batch twice leaves every total unchanged and counts its size as duplicates", () => {
  const batch = mockEvents(1, "steady", 0, 60_000);
  const once = applyBatch(emptyData(), batch);
  const twice = applyBatch(once, batch);
  expect(aggregates(twice)).toEqual(aggregates(once));
  expect(twice.dataHealth.duplicates).toBe(batch.length);
  expect(twice.dataHealth.applied).toBe(once.dataHealth.applied);
});

test("a duplicate inside one batch is skipped", () => {
  const e = ev();
  const s = applyBatch(emptyData(), [e, e]);
  expect(s.dataHealth).toMatchObject({ applied: 1, duplicates: 1 });
});

test("a shuffled batch gives the same aggregates, lastSeen and status as the ts-sorted one", () => {
  const sorted = mockEvents(2, "steady", 0, 4 * 60_000).slice(0, 500);
  const shuffled = [...sorted];
  const rng = createRng(9);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  expect(shuffled).not.toEqual(sorted);
  const a = applyBatch(emptyData(), sorted);
  const b = applyBatch(emptyData(), shuffled);
  expect(aggregates(b)).toEqual(aggregates(a));
  for (const [id, session] of a.sessions) {
    expect(b.sessions.get(id)?.lastSeen).toBe(session.lastSeen);
    expect(b.sessions.get(id)?.status).toBe(session.status);
  }
});

test("an older event arriving later does not move lastSeen or status", () => {
  const e1 = ev({ ts: "2026-01-01T09:00:05.000Z", status: "tool" });
  const e2 = ev({ ts: "2026-01-01T09:00:10.000Z", status: "waiting_user" });
  const s = applyBatch(applyBatch(emptyData(), [e2]), [e1]);
  expect(s.sessions.get("s1")).toMatchObject({
    lastSeen: Date.parse(e2.ts),
    status: "waiting_user",
    events: 2,
  });
});

test("session_end sets done", () => {
  const s = applyBatch(emptyData(), [
    ev({ type: "session_start", status: "idle" }),
    ev({ type: "session_end" }),
  ]);
  expect(s.sessions.get("s1")?.status).toBe("done");
});

test("evicting from the ring leaves every aggregate unchanged and drops the evicted ids", () => {
  const events = mockEvents(1, "steady", 0, 2 * 60_000).slice(0, 200);
  const big = applyBatch(emptyData(), events);
  const small = applyBatch(emptyData(5), events);
  expect(aggregates(small)).toEqual(aggregates(big));
  expect(small.ring.size).toBe(5);
  expect(ringEvents(small.ring)).toEqual(events.slice(-5));
  expect(small.ring.seen.size).toBe(5);
  expect(small.ring.seen.has(events[0].id)).toBe(false);
  expect(small.ring.seen.has(events.at(-1)!.id)).toBe(true);
});

test("the ring wraps around its head without moving entries", () => {
  const ring = createRing(3);
  const s = applyBatch({ ...emptyData(3), ring }, [ev(), ev(), ev(), ev()]);
  expect(s.ring.head).toBe(1);
  expect(ringEvents(s.ring)).toHaveLength(3);
});

test("the peek lists that session's events only, in arrival order, at most 20", () => {
  const mine = Array.from({ length: 25 }, () => ev({ sessionId: "me" }));
  const other = Array.from({ length: 5 }, () => ev({ sessionId: "other" }));
  const mixed = [...mine.slice(0, 10), ...other, ...mine.slice(10)];
  const s = applyBatch(emptyData(), mixed);
  const peek = peekEvents(s.ring, "me");
  expect(peek).toEqual(mine.slice(-20));
  expect(peekEvents(s.ring, "other")).toEqual(other);
  expect(peekEvents(s.ring, "nobody")).toEqual([]);
});

test("with a small ring a session whose events were all evicted gives the empty state", () => {
  const s = applyBatch(emptyData(3), [
    ev({ sessionId: "old" }),
    ev({ sessionId: "new" }),
    ev({ sessionId: "new" }),
    ev({ sessionId: "new" }),
  ]);
  expect(s.sessions.has("old")).toBe(true);
  expect(peekEvents(s.ring, "old")).toEqual([]);
  expect(NO_EVENTS).toBe("No recent events (older than the buffer)");
});

test("with 60 sessions the list shows 50 rows and +10 more, newest first; with none the empty text", () => {
  const events = Array.from({ length: 60 }, (_, i) => ev({ sessionId: `s${i}` }));
  const s = applyBatch(emptyData(), events);
  const list = sessionList(s.sessions);
  expect(list.rows).toHaveLength(50);
  expect(list.more).toBe(10);
  expect(list.rows[0].sessionId).toBe("s59");
  expect(sessionList(emptyData().sessions)).toEqual({ rows: [], more: 0 });
  expect(noSessionsText("catching_up")).toBe("No sessions yet (source: catching_up)");
});

test("validate keeps the valid events, drops the invalid ones and reports the first issue path and code", () => {
  const good = ev();
  const bad = { ...ev(), vendor: "SECRET-VALUE" };
  const { events, rejects } = validate([good, bad, 42]);
  expect(events).toEqual([good]);
  expect(rejects).toHaveLength(2);
  expect(rejects[0]).toMatchObject({ id: bad.id, path: "vendor" });
  expect(JSON.stringify(rejects)).not.toContain("SECRET-VALUE");
  expect(rejects[1].id).toBeNull();
});

test("totalInvalid sums the per-path counts", () => {
  expect(
    totalInvalid({ ...emptyData().dataHealth, invalid: { "mock:vendor": 2, "mock:ts": 1 } }),
  ).toBe(3);
});
