import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import {
  HALL_COOLING_CAPACITY_KW,
  HOT_AISLE_DELTA_C,
  IDLE_END_MS,
  IDLE_KW,
  INLET_BASE_C,
  INLET_C_PER_KW,
  KW_PER_TOKEN_PER_MIN,
  LAG_TAU_S,
  RACK_MAX_KW,
} from "../config/estimation.ts";
import { PRICES, PRICES_AS_OF } from "../config/prices.ts";
import {
  LIVE_WINDOW,
  activeSessions,
  coolingDuty,
  cost,
  formatMetric,
  hallHeat,
  hallInlet,
  hotAisle,
  hottestHall,
  maxProvenance,
  rackInlet,
  rackKw,
  rackLoad,
  rackTokensPerMin,
  tokensPerMin,
  tokensTotal,
  type Metric,
} from "./metrics.ts";
import { advance, applyBatch, emptyData, type DataState } from "./reduce.ts";
import type { AgentEvent } from "./schema.ts";

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
let n = 0;
function ev(over: Partial<AgentEvent> & { at?: number } = {}): AgentEvent {
  n++;
  const { at = 0, ...rest } = over;
  return {
    id: `m${n}`,
    vendor: "claude",
    projectKey: "/work/orbit-api",
    sessionId: "s1",
    parentKnown: true,
    agentKind: "main",
    model: "claude-sonnet-4",
    ts: new Date(T0 + at).toISOString(),
    type: "usage",
    provenance: {},
    ...rest,
  };
}
const use = (i: number, o = 0, cacheRead = 0, cacheWrite = 0) => ({
  in: i,
  out: o,
  cacheRead,
  cacheWrite,
});
const build = (...events: AgentEvent[]): DataState => applyBatch(emptyData(), events);
const value = (m: Metric) => m.value as number;

test("the estimation constants are the plan's values", () => {
  expect([IDLE_KW, KW_PER_TOKEN_PER_MIN, RACK_MAX_KW, INLET_BASE_C, INLET_C_PER_KW]).toEqual([
    0.8, 0.004, 40, 22, 0.25,
  ]);
  expect([HOT_AISLE_DELTA_C, LAG_TAU_S, HALL_COOLING_CAPACITY_KW, IDLE_END_MS]).toEqual([
    12, 30, 400, 1_800_000,
  ]);
});

test("tokens/min counts in + out of the trailing 60 s, not cache tokens", () => {
  const s = build(ev({ tokens: use(600, 400, 9000, 9000) }), ev({ at: 30_000, tokens: use(100) }));
  expect(value(rackTokensPerMin(s, "s1", T0 + 30_000))).toBe(1100);
  // The first event leaves the window at T0 + 60 s and not before.
  expect(value(rackTokensPerMin(s, "s1", T0 + 59_999))).toBe(1100);
  expect(value(rackTokensPerMin(s, "s1", T0 + 60_000))).toBe(100);
  expect(value(rackTokensPerMin(s, "s1", T0 + 90_000))).toBe(0);
  expect(value(tokensPerMin(s, T0 + 30_000))).toBe(1100);
});

test("rack kW = idle + k x tokens/min, clamped to the maximum", () => {
  const s = build(ev({ tokens: use(1000) }), ev({ sessionId: "busy", tokens: use(50_000) }));
  expect(value(rackKw(s, "s1", T0))).toBeCloseTo(0.8 + 0.004 * 1000, 12);
  expect(value(rackKw(s, "busy", T0))).toBe(40);
  const idle = build(ev({ type: "session_start", status: "idle" }));
  expect(value(rackKw(idle, "s1", T0))).toBe(0.8);
  expect(value(rackLoad(s, "s1", T0))).toBeCloseTo((4.8 / 40) * 100, 12);
  expect(rackKw(s, "nope", T0).value).toBeNull();
});

test("a subagent's tokens/min add to its parent's rack", () => {
  const s = build(
    ev({ tokens: use(500) }),
    ev({ sessionId: "sub1", agentKind: "sub", parentSessionId: "s1", tokens: use(300) }),
    ev({ sessionId: "sub2", agentKind: "sub", parentSessionId: "s1", tokens: use(200) }),
  );
  expect(value(rackTokensPerMin(s, "s1", T0))).toBe(1000);
  expect(value(tokensPerMin(s, T0))).toBe(1000);
});

test("rack inlet takes one lag step per second toward 22 + 0.25 x kW", () => {
  const s0 = build(ev({ tokens: use(5000) }));
  expect(value(rackInlet(s0, "s1", T0))).toBeCloseTo(22 + 0.25 * 0.8, 12);
  const s1 = advance(s0, T0 + 1000);
  const target = 22 + 0.25 * (0.8 + 0.004 * 5000);
  const expected = target + (22.2 - target) * Math.exp(-1 / 30);
  expect(value(rackInlet(s1, "s1", T0 + 1000))).toBeCloseTo(expected, 12);
});

test("hall heat sums its racks; hall inlet is their mean; hot aisle adds 12 C x mean load", () => {
  const s = advance(
    build(
      ev({ tokens: use(2500) }),
      ev({ sessionId: "s2", tokens: use(7500) }),
      ev({ sessionId: "o1", projectKey: "/work/other", tokens: use(1000) }),
    ),
    T0 + 5000,
  );
  const now = T0 + 5000;
  const kw1 = 0.8 + 0.004 * 2500;
  const kw2 = 0.8 + 0.004 * 7500;
  expect(value(hallHeat(s, "/work/orbit-api", now))).toBeCloseTo(kw1 + kw2, 12);
  const inlets = ["s1", "s2"].map((id) => value(rackInlet(s, id, now)));
  expect(value(hallInlet(s, "/work/orbit-api", now))).toBeCloseTo((inlets[0] + inlets[1]) / 2, 12);
  const meanLoad = (kw1 / 40 + kw2 / 40) / 2;
  expect(value(hotAisle(s, "/work/orbit-api", now))).toBeCloseTo(
    value(hallInlet(s, "/work/orbit-api", now)) + 12 * meanLoad,
    12,
  );
  expect(hallInlet(s, "/work/empty", now).value).toBeNull();
  expect(hottestHall(s, now)).toBe("/work/orbit-api");
  expect(hottestHall(emptyData(), now)).toBeUndefined();
});

test("cooling duty = hall heat / (400 kW x placed halls), floor of 2 halls", () => {
  const one = build(ev({ tokens: use(5000) }));
  const kw = 0.8 + 0.004 * 5000;
  const duty = coolingDuty(one, T0);
  expect(duty.value).toBeCloseTo((kw / 800) * 100, 12);
  expect(duty.basis).toContain("2 placed halls");
  expect(duty.basis).not.toContain("over capacity");
  const three = build(
    ev({ tokens: use(5000) }),
    ev({ sessionId: "b", projectKey: "/work/b", tokens: use(5000) }),
    ev({ sessionId: "c", projectKey: "/work/c", tokens: use(5000) }),
  );
  expect(coolingDuty(three, T0).basis).toContain("3 placed halls");
  expect(value(coolingDuty(three, T0))).toBeCloseTo(((3 * kw) / 1200) * 100, 12);
});

test("cooling duty clamps at 100 and its basis says over capacity", () => {
  // 25 racks at the 40 kW maximum = 1,000 kW against 2 x 400 kW.
  const s = build(
    ...Array.from({ length: 25 }, (_, i) => ev({ sessionId: `r${i}`, tokens: use(50_000) })),
  );
  const duty = coolingDuty(s, T0);
  expect(duty.value).toBe(100);
  expect(duty.basis).toContain("over capacity");
});

test("one provenance test per composite selector: the highest of its inputs", () => {
  const s = build(ev({ tokens: use(1000) }));
  expect(maxProvenance("real", "real")).toBe("real");
  expect(maxProvenance("real", "derived")).toBe("derived");
  expect(maxProvenance("derived", "estimated", "real")).toBe("estimated");
  expect(tokensTotal(s).provenance).toBe("real");
  expect(activeSessions(s).provenance).toBe("derived");
  expect(tokensPerMin(s, T0).provenance).toBe("derived");
  expect(rackTokensPerMin(s, "s1", T0).provenance).toBe("derived");
  expect(rackKw(s, "s1", T0).provenance).toBe("estimated");
  expect(rackLoad(s, "s1", T0).provenance).toBe("estimated");
  expect(rackInlet(s, "s1", T0).provenance).toBe("estimated");
  expect(hallHeat(s, "/work/orbit-api", T0).provenance).toBe("estimated");
  expect(hallInlet(s, "/work/orbit-api", T0).provenance).toBe("estimated");
  expect(hotAisle(s, "/work/orbit-api", T0).provenance).toBe("estimated");
  expect(coolingDuty(s, T0).provenance).toBe("estimated");
  expect(cost(s).provenance).toBe("estimated");
});

test("an unknown model gives null and formats as unknown, never 0", () => {
  const s = build(ev({ model: "mystery-1", tokens: use(1_000_000) }));
  const c = cost(s);
  expect(c.value).toBeNull();
  expect(formatMetric(c)).toBe("unknown");
  const none = build(ev({ model: undefined, tokens: use(5) }));
  expect(cost(none).value).toBeNull();
});

test("cost totals: all known, mixed (excludes N unknown) and all unknown", () => {
  const known = ev({ model: "claude-sonnet-4", tokens: use(1_000_000, 1_000_000) });
  const all = cost(build(known));
  expect(all.value).toBeCloseTo(3 + 15, 9);
  expect(all.basis).not.toContain("excludes");

  const mixed = cost(
    build(
      known,
      ev({ sessionId: "u1", model: "mystery-1", tokens: use(1_000_000) }),
      ev({ sessionId: "u2", model: "mystery-2", tokens: use(1_000_000) }),
    ),
  );
  expect(mixed.value).toBeCloseTo(18, 9);
  expect(mixed.basis).toContain("excludes 2 sessions with unknown model");

  const unknown = cost(
    build(
      ev({ model: "mystery-1", tokens: use(10) }),
      ev({ sessionId: "u2", model: "mystery-2", tokens: use(10) }),
    ),
  );
  expect(unknown.value).toBeNull();
  expect(unknown.basis).toContain("2 sessions");
  // No session at all is not an unknown model.
  expect(cost(emptyData()).value).toBe(0);
});

test("cost is the sum over the four token classes, not one blended rate", () => {
  const cacheHeavy = cost(build(ev({ tokens: use(0, 0, 1_000_000, 0) })));
  expect(cacheHeavy.value).toBeCloseTo(PRICES["claude-sonnet-4"].cacheRead, 9);
  const mix = cost(build(ev({ tokens: use(1_000_000, 1_000_000, 1_000_000, 1_000_000) })));
  const p = PRICES["claude-sonnet-4"];
  expect(mix.value).toBeCloseTo(p.in + p.out + p.cacheRead + p.cacheWrite, 9);
  expect(
    cost(build(ev({ model: "gpt-5-codex", tokens: use(1_000_000, 0, 0, 1_000_000) }))).value,
  ).toBeCloseTo(PRICES["gpt-5-codex"].in + PRICES["gpt-5-codex"].cacheWrite, 9);
});

test("the cost basis names asOf and says it is not a subscription bill; live totals name their window", () => {
  const s = build(ev({ tokens: use(10) }));
  const c = cost(s);
  expect(c.basis).toContain(PRICES_AS_OF);
  expect(c.basis).toContain("not a subscription bill");
  expect(c.unit).toBe("USD");
  expect(cost(s, LIVE_WINDOW).basis).toContain("last 24 h, backfill window");
  expect(tokensTotal(s, LIVE_WINDOW).basis).toContain("last 24 h, backfill window");
  expect(tokensTotal(s).basis).not.toContain("last 24 h");
});

test("formatMetric renders value and unit, and a raw number does not compile", () => {
  expect(formatMetric({ value: 4.8, unit: "kW", provenance: "estimated", basis: "b" })).toBe(
    "4.80 kW",
  );
  expect(formatMetric({ value: 12_345, unit: "tokens", provenance: "real", basis: "b" })).toBe(
    "12,345 tokens",
  );
  expect(formatMetric({ value: 7, unit: "sessions", provenance: "derived", basis: "b" })).toBe(
    "7 sessions",
  );
  // @ts-expect-error a bare number is not a Metric
  expect(() => formatMetric(5)).toThrow();
});

test("the README has the provenance legend with its image, formulas and tombstone limits", () => {
  const readme = readFileSync("README.md", "utf8");
  const start = readme.indexOf("## Provenance legend");
  expect(start).toBeGreaterThan(-1);
  const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
  expect(section).toContain("docs/img/13-provenance.png");
  expect(section).toContain("0.8 + 0.004 x tokens/min");
  expect(section).toContain("restarts its per-session counters at 0");
  expect(section).toContain("100,000-id tombstone set");
});
