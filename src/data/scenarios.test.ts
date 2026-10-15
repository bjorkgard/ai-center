import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { ANCHOR_MS, CATCHUP_MS, mockEvents } from "./mock.ts";
import { activeProjects, advance, applyBatch, emptyData, type DataState } from "./reduce.ts";
import { SCENARIOS, SCENARIO_NAMES } from "./scenarios.ts";

const MIN = 60_000;
const SEEDS = [1, 42];
const SLOW = ["/work/pine-sdk", "/work/delta-ops"];

// The state after every sim second, reduced through applyBatch in 1 s steps (C45): entry t is
// the state after every event with sim ms < t + 1,000, read through `read`.
function timeline<T>(
  seed: number,
  scenario: string,
  endSec: number,
  read: (s: DataState) => T,
  // Session-end inference on (chunk 13): each step also advances to the end of its second.
  infer = false,
): T[] {
  const events = mockEvents(seed, scenario, 0, endSec * 1000);
  const out: T[] = [];
  let state = emptyData();
  let i = 0;
  let mark: number | undefined;
  for (let t = 0; t < endSec; t++) {
    const from = i;
    while (i < events.length && Date.parse(events[i].ts) - ANCHOR_MS < t * 1000 + 1000) i++;
    const now = infer ? ANCHOR_MS + t * 1000 + 999 : undefined;
    state = applyBatch(state, events.slice(from, i), { now, mark });
    if (now !== undefined) {
      state = advance(state, now);
      mark = now;
    }
    out.push(read(state));
  }
  return out;
}

const frozen = (seed: number, scenario: string): DataState =>
  applyBatch(emptyData(), mockEvents(seed, scenario, 0, CATCHUP_MS));
const sessionsWhere = (
  s: DataState,
  f: (x: DataState["sessions"] extends Map<string, infer V> ? V : never) => boolean,
) => [...s.sessions.values()].filter(f);
const live = (s: DataState) => [...s.subagents.values()].filter((x) => x.status !== "done");
const fast = (s: DataState) => activeProjects(s).filter((k) => !SLOW.includes(k));
const biggest = (s: DataState) =>
  [...s.projects.values()].sort((a, b) => b.sessions - a.sessions)[0].projectKey;

test("the registry lists exactly the 7 names", () => {
  expect(SCENARIO_NAMES).toEqual([
    "steady",
    "burst",
    "churn",
    "overflow",
    "errors",
    "codex-only",
    "waiting",
  ]);
});

test.each(SEEDS)("steady keeps 3 projects and 7 main sessions at 600 s (seed %i)", (seed) => {
  const [at] = timeline(seed, "steady", 601, (s) => s).slice(600);
  expect([at.projects.size, at.sessions.size]).toEqual([3, 7]);
});

test.each(SEEDS)(
  "burst: exactly 10 live subagents under one parent at 120, 240, 600 s, none at 60 and 180 s (seed %i)",
  (seed) => {
    const t = timeline(seed, "burst", 601, live);
    for (const at of [120, 240, 600]) {
      expect(t[at], `at ${at}`).toHaveLength(10);
      expect(new Set(t[at].map((x) => x.parentSessionId)).size).toBe(1);
    }
    for (const at of [60, 180]) expect(t[at], `at ${at}`).toHaveLength(0);
    const all = timeline(seed, "burst", 601, (s) => s)[600];
    expect(all.sessions.size).toBe(7);
    expect(all.sessions.get(t[600][0].parentSessionId!)?.vendor).toBe("claude");
  },
);

// The churn shape of PLAN chunk 12 over [0, end) sim seconds; the same expectations hold with
// session-end inference on (chunk 13), since every idle gap is under 30 min or ends in a
// session_end.
function expectChurnShape(seed: number, end: number, infer: boolean) {
  const t = timeline(
    seed,
    "churn",
    end,
    (s) => ({
      fast: new Set(fast(s)),
      active: new Set(activeProjects(s)),
      keys: [...s.projects.keys()],
    }),
    infer,
  );
  for (let at = 100; at < end; at++) expect(t[at].fast.size, `at ${at}`).toBe(3);
  for (let b = 120; b < end; b += 20) {
    const before = t[b - 1].fast;
    const after = t[b].fast;
    expect(
      [...before].filter((k) => !after.has(k)),
      `out at ${b}`,
    ).toHaveLength(1);
    expect(
      [...after].filter((k) => !before.has(k)),
      `in at ${b}`,
    ).toHaveLength(1);
  }
  for (const key of t[end - 1].keys) expect(key.startsWith("/work/")).toBe(true);
  for (let at = 90; at < 990; at++) expect(t[at].active.has("/work/pine-sdk"), `${at}`).toBe(false);
  expect(t[990].active.has("/work/pine-sdk")).toBe(true);
  for (let at = 120; at < 730; at++)
    expect(t[at].active.has("/work/delta-ops"), `${at}`).toBe(false);
  expect(t[730].active.has("/work/delta-ops")).toBe(true);
}

test.each(SEEDS)(
  "churn: 3 fast projects from 100 s, one in and one out per 20 s boundary, slow lanes retire and return (seed %i)",
  (seed) => expectChurnShape(seed, 1200, false),
);

test.each(SEEDS)(
  "churn with session-end inference on: the same shapes over [0, 1,800 s) (seed %i)",
  (seed) => expectChurnShape(seed, 1800, true),
  30_000,
);

test.each(SEEDS)(
  "overflow: 29, 40, 32, 16 and 8 sessions in the growing project (seed %i)",
  (seed) => {
    const t = timeline(seed, "overflow", 1800, (s) => s);
    const key = biggest(t[1200]);
    const notDone = (s: DataState) =>
      sessionsWhere(s, (x) => x.projectKey === key && x.status !== "done").length;
    expect(t[900].projects.get(key)!.sessions).toBe(29);
    expect(t[1200].projects.get(key)!.sessions).toBe(40);
    expect(notDone(t[1200])).toBe(40);
    expect(notDone(t[1320])).toBe(32);
    expect(notDone(t[1560])).toBe(16);
    expect(notDone(t[1680])).toBe(8);
    expect(notDone(t[1800 - 1])).toBe(8);
    expect(t[1799].projects.size).toBe(2);
    expect([...t[1799].projects.values()].map((p) => p.sessions).sort((a, b) => a - b)).toEqual([
      2, 40,
    ]);
  },
);

test.each(SEEDS)(
  "errors: at least 5 sessions in error at 300, 600, 900 s and none at 400, 700, 1000 s (seed %i)",
  (seed) => {
    const t = timeline(
      seed,
      "errors",
      1001,
      (s) => sessionsWhere(s, (x) => x.status === "error").length,
    );
    for (const at of [300, 600, 900]) expect(t[at], `at ${at}`).toBeGreaterThanOrEqual(5);
    for (const at of [400, 700, 1000]) expect(t[at], `at ${at}`).toBe(0);
  },
);

test.each(SEEDS)(
  "codex-only: every event is codex, at least 3 projects and 5 main sessions (seed %i)",
  (seed) => {
    const events = mockEvents(seed, "codex-only", 0, 1200_000);
    expect(events.every((e) => e.vendor === "codex")).toBe(true);
    const at = timeline(seed, "codex-only", 601, (s) => s)[600];
    expect(at.projects.size).toBeGreaterThanOrEqual(3);
    expect(at.sessions.size).toBeGreaterThanOrEqual(5);
    expect(at.subagents.size).toBe(0);
  },
);

test.each(SEEDS)(
  "waiting: at least 3 sessions wait at 600 and 1200 s with no turn_start from 590 s (seed %i)",
  (seed) => {
    const waiting = (s: DataState) =>
      sessionsWhere(s, (x) => x.status === "waiting_user").map((x) => x.sessionId);
    const t = timeline(seed, "waiting", 1200, waiting);
    expect(t[600].length).toBeGreaterThanOrEqual(3);
    expect(t[1199].length).toBeGreaterThanOrEqual(3);
    const late = mockEvents(seed, "waiting", 590_000, 1200_000).filter(
      (e) => e.type === "turn_start",
    );
    for (const id of t[600])
      expect(
        late.some((e) => e.sessionId === id),
        id,
      ).toBe(false);
  },
);

test.each(SEEDS)(
  "waiting with session-end inference on: still waiting at 600 and 1,200 s, done at last event + 30 min (seed %i)",
  (seed) => {
    const waiting = (s: DataState) =>
      sessionsWhere(s, (x) => x.status === "waiting_user").map((x) => x.sessionId);
    const t = timeline(seed, "waiting", 1200, waiting, true);
    expect(t[600].length).toBeGreaterThanOrEqual(3);
    expect(t[1199].length).toBeGreaterThanOrEqual(3);
    // Run on to the end of the idle window: the same sessions are done at last + 30 min.
    const events = mockEvents(seed, "waiting", 0, 1200_000);
    let state = applyBatch(emptyData(), events, { now: ANCHOR_MS + 1200_000 });
    state = advance(state, ANCHOR_MS + 1200_000);
    for (const id of t[1199]) {
      const s = state.sessions.get(id)!;
      expect(s.status, id).toBe("waiting_user");
      const end = s.lastSeen + 30 * MIN;
      expect(advance(state, end - 1).sessions.get(id)!.status, id).toBe("waiting_user");
      const done = advance(state, end).sessions.get(id)!;
      expect(done.status, id).toBe("done");
      expect(done.inferred!.endAt).toBe(end);
      // Their last events are near 313-334 sim s, so they end near 2,113-2,134 sim s (the plan
      // says "about 2,390", which assumes a last event near 590 s).
      expect((end - ANCHOR_MS) / 1000).toBeGreaterThan(2000);
      expect((end - ANCHOR_MS) / 1000).toBeLessThan(2500);
    }
  },
  30_000,
);

test.each(SEEDS)("frozen frame signatures at the catch-up end (seed %i)", (seed) => {
  const burst = frozen(seed, "burst");
  expect(live(burst)).toHaveLength(10);
  expect(new Set(live(burst).map((x) => x.parentSessionId)).size).toBe(1);

  const churn = frozen(seed, "churn");
  expect(fast(churn)).toHaveLength(3);
  for (const key of SLOW) expect(activeProjects(churn)).not.toContain(key);

  const overflow = frozen(seed, "overflow");
  expect(overflow.projects.get(biggest(overflow))!.sessions).toBe(8);

  const errors = frozen(seed, "errors");
  expect(sessionsWhere(errors, (x) => x.status === "error").length).toBeGreaterThanOrEqual(5);

  const waiting = frozen(seed, "waiting");
  expect(sessionsWhere(waiting, (x) => x.status === "waiting_user").length).toBeGreaterThanOrEqual(
    3,
  );

  const steady = frozen(seed, "steady");
  expect([steady.projects.size, steady.sessions.size]).toEqual([3, 7]);
  const codex = frozen(seed, "codex-only");
  expect(codex.projects.size).toBeGreaterThanOrEqual(3);
  expect(codex.sessions.size).toBeGreaterThanOrEqual(5);
});

test.each(SCENARIO_NAMES)(
  "split invariance: %s over [0, 7 min) + [7 min, 20 min) equals [0, 20 min)",
  (name) => {
    for (const seed of SEEDS) {
      const whole = mockEvents(seed, name, 0, 20 * MIN);
      expect(whole.length).toBeGreaterThan(100);
      expect([
        ...mockEvents(seed, name, 0, 7 * MIN),
        ...mockEvents(seed, name, 7 * MIN, 20 * MIN),
      ]).toEqual(whole);
      expect(new Set(whole.map((e) => e.id)).size).toBe(whole.length);
    }
  },
  20_000,
);

test("every scenario's events are valid-looking and stay under /work/", () => {
  for (const { name } of SCENARIOS) {
    for (const e of mockEvents(3, name, 0, 5 * MIN))
      expect(e.projectKey.startsWith("/work/")).toBe(true);
  }
});

test("the README scenarios table lists every registry name with an example URL (C57)", () => {
  const readme = readFileSync("README.md", "utf8");
  for (const { name } of SCENARIOS) {
    const row = readme.split("\n").find((line) => new RegExp(`^\\| \`${name}\` +\\|`).test(line));
    expect(row, `README table row for ${name}`).toBeDefined();
    expect(row).toContain(`scenario=${name}`);
  }
});
