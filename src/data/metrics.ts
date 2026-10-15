import {
  HALL_COOLING_CAPACITY_KW,
  HOT_AISLE_DELTA_C,
  IDLE_KW,
  INLET_BASE_C,
  KW_PER_TOKEN_PER_MIN,
  MIN_PLACED_HALLS,
  RACK_MAX_KW,
  RATE_WINDOW_S,
} from "../config/estimation.ts";
import { PRICES_AS_OF, priceOf } from "../config/prices.ts";
import {
  activeProjects,
  rackKwOf,
  rateKey,
  type DataState,
  type RateAgg,
  type Tokens,
} from "./reduce.ts";

// Every number the dashboard shows is a Metric (CEO C75, design D19): the value, its unit, how
// it was obtained and a short human string saying how.
export type Provenance = "real" | "derived" | "estimated";

export interface Metric {
  // null means unknown, never zero (G7).
  value: number | null;
  unit: string;
  provenance: Provenance;
  basis: string;
}

const RANK: Record<Provenance, number> = { real: 0, derived: 1, estimated: 2 };

// A composite takes the highest provenance of its inputs on real < derived < estimated (M7).
export function maxProvenance(first: Provenance, ...rest: Provenance[]): Provenance {
  let out = first;
  for (const p of rest) if (RANK[p] > RANK[out]) out = p;
  return out;
}

const metric = (
  value: number | null,
  unit: string,
  provenance: Provenance,
  basis: string,
): Metric => ({ value, unit, provenance, basis });

function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  if (abs >= 1000) return Math.round(value).toLocaleString("en-US");
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

// The only way a value reaches the screen: it takes a Metric, so a raw number does not compile.
export function formatMetric(m: Metric): string {
  if (m.value === null) return "unknown";
  return m.unit ? `${formatNumber(m.value)} ${m.unit}` : formatNumber(m.value);
}

// The window every token or cost total names in live mode, so it never reads as all-time.
export const LIVE_WINDOW = "last 24 h, backfill window";

type Series = Pick<DataState, "sessions" | "subagents" | "rates">;
export type MetricsState = Series & Pick<DataState, "tokens" | "modelTokens" | "unknownSessions">;

const withWindow = (basis: string, window?: string): string =>
  window ? `${basis}, ${window}` : basis;

// Tokens in the trailing RATE_WINDOW_S sim seconds ending in the second of `nowMs`.
function windowSum(rate: RateAgg | undefined, nowMs: number): number {
  if (!rate) return 0;
  const end = Math.floor(nowMs / 1000);
  let sum = 0;
  for (const [sec, n] of rate.buckets) if (sec > end - RATE_WINDOW_S && sec <= end) sum += n;
  return sum;
}

export interface Rack {
  sessionId: string;
  projectKey: string;
  tokensPerMin: number;
  kw: number;
  inletC: number;
}

// A rack is a main session that is not done; its subagents' tokens/min add to it (section 2).
export function racksOf(state: Series, nowMs: number): Rack[] {
  const subs = new Map<string, number>();
  for (const sub of state.subagents.values()) {
    if (sub.parentSessionId === undefined) continue;
    const n = windowSum(state.rates.get(rateKey("sub", sub.sessionId)), nowMs);
    subs.set(sub.parentSessionId, (subs.get(sub.parentSessionId) ?? 0) + n);
  }
  const out: Rack[] = [];
  for (const s of state.sessions.values()) {
    if (s.status === "done") continue;
    const rate = state.rates.get(rateKey("main", s.sessionId));
    const tokensPerMin = windowSum(rate, nowMs) + (subs.get(s.sessionId) ?? 0);
    out.push({
      sessionId: s.sessionId,
      projectKey: s.projectKey,
      tokensPerMin,
      kw: rackKwOf(tokensPerMin),
      inletC: rate?.inletC ?? INLET_BASE_C,
    });
  }
  return out;
}

const KW_BASIS = `idle ${IDLE_KW} kW + ${KW_PER_TOKEN_PER_MIN} kW per token/min, max ${RACK_MAX_KW} kW`;

export function tokensTotal(state: Pick<MetricsState, "tokens">, window?: string): Metric {
  const t = state.tokens;
  return metric(
    t.in + t.out + t.cacheRead + t.cacheWrite,
    "tokens",
    "real",
    withWindow("in + out + cache read + cache write, from events", window),
  );
}

export function activeSessions(state: Pick<MetricsState, "sessions">): Metric {
  let n = 0;
  for (const s of state.sessions.values()) if (s.status !== "done") n++;
  return metric(
    n,
    "sessions",
    "derived",
    "main sessions not done; a session ends after 30 min idle",
  );
}

// All sessions and subagents, in + out tokens over the trailing 60 sim s.
export function tokensPerMin(state: Series, nowMs: number): Metric {
  let sum = 0;
  for (const rate of state.rates.values()) sum += windowSum(rate, nowMs);
  return metric(sum, "tokens/min", "derived", `in + out tokens in the last ${RATE_WINDOW_S} sim s`);
}

export function rackTokensPerMin(state: Series, sessionId: string, nowMs: number): Metric {
  const rack = racksOf(state, nowMs).find((r) => r.sessionId === sessionId);
  return metric(
    rack?.tokensPerMin ?? null,
    "tokens/min",
    "derived",
    `session and its subagents, in + out tokens in the last ${RATE_WINDOW_S} sim s`,
  );
}

export function rackKw(state: Series, sessionId: string, nowMs: number): Metric {
  const tpm = rackTokensPerMin(state, sessionId, nowMs);
  return metric(
    tpm.value === null ? null : rackKwOf(tpm.value),
    "kW",
    maxProvenance(tpm.provenance, "estimated"),
    KW_BASIS,
  );
}

export function rackLoad(state: Series, sessionId: string, nowMs: number): Metric {
  const kw = rackKw(state, sessionId, nowMs);
  return metric(
    kw.value === null ? null : (kw.value / RACK_MAX_KW) * 100,
    "%",
    maxProvenance(kw.provenance, "estimated"),
    `rack kW / ${RACK_MAX_KW} kW`,
  );
}

export function rackInlet(state: Series, sessionId: string, nowMs: number): Metric {
  const rack = racksOf(state, nowMs).find((r) => r.sessionId === sessionId);
  return metric(
    rack?.inletC ?? null,
    "°C",
    "estimated",
    `${INLET_BASE_C} °C + rack kW x inlet rise, first-order lag`,
  );
}

const hallRacks = (state: Series, projectKey: string, nowMs: number): Rack[] =>
  racksOf(state, nowMs).filter((r) => r.projectKey === projectKey);

export function hallHeat(state: Series, projectKey: string, nowMs: number): Metric {
  const racks = hallRacks(state, projectKey, nowMs);
  const tpm = tokensPerMin(state, nowMs);
  return metric(
    racks.reduce((a, r) => a + r.kw, 0),
    "kW",
    maxProvenance(tpm.provenance, "estimated"),
    `sum of rack kW in the hall (${KW_BASIS})`,
  );
}

// The mean of the hall's rack inlets; null for a hall with no rack.
export function hallInlet(state: Series, projectKey: string, nowMs: number): Metric {
  const racks = hallRacks(state, projectKey, nowMs);
  return metric(
    racks.length === 0 ? null : racks.reduce((a, r) => a + r.inletC, 0) / racks.length,
    "°C",
    "estimated",
    `mean rack inlet, ${INLET_BASE_C} °C + rise per kW, first-order lag`,
  );
}

export function hotAisle(state: Series, projectKey: string, nowMs: number): Metric {
  const racks = hallRacks(state, projectKey, nowMs);
  const inlet = hallInlet(state, projectKey, nowMs);
  const load =
    racks.length === 0 ? 0 : racks.reduce((a, r) => a + r.kw / RACK_MAX_KW, 0) / racks.length;
  return metric(
    inlet.value === null ? null : inlet.value + HOT_AISLE_DELTA_C * load,
    "°C",
    maxProvenance(inlet.provenance, "estimated"),
    `hall inlet + ${HOT_AISLE_DELTA_C} °C x mean rack load`,
  );
}

// Heat over the capacity of the placed halls, as a percentage clamped to 100.
export function coolingDuty(state: Series, nowMs: number): Metric {
  const heat = racksOf(state, nowMs).reduce((a, r) => a + r.kw, 0);
  const placed = Math.max(MIN_PLACED_HALLS, activeProjects(state).length);
  const raw = heat / (HALL_COOLING_CAPACITY_KW * placed);
  return metric(
    Math.min(1, raw) * 100,
    "%",
    maxProvenance(tokensPerMin(state, nowMs).provenance, "estimated"),
    `hall heat / (${HALL_COOLING_CAPACITY_KW} kW x ${placed} placed halls)${raw > 1 ? ", over capacity" : ""}`,
  );
}

// The project whose racks draw the most, or undefined when there is none.
export function hottestHall(state: Series, nowMs: number): string | undefined {
  const heat = new Map<string, number>();
  for (const r of racksOf(state, nowMs))
    heat.set(r.projectKey, (heat.get(r.projectKey) ?? 0) + r.kw);
  let best: string | undefined;
  for (const [key, kw] of heat)
    if (best === undefined || kw > heat.get(best)! || (kw === heat.get(best) && key < best))
      best = key;
  return best;
}

// API-equivalent cost: tokens x the price of their model, per token class (CEO F3, X4, F7).
// Sessions with an unknown model are left out and counted in the basis; null when all are.
export function cost(state: MetricsState, window?: string): Metric {
  let usd = 0;
  let knownTokens = 0;
  let unknownTokens = 0;
  const models: string[] = [];
  const sum = (t: Tokens) => t.in + t.out + t.cacheRead + t.cacheWrite;
  for (const [model, t] of state.modelTokens) {
    const p = priceOf(model);
    if (!p) {
      unknownTokens += sum(t);
      continue;
    }
    models.push(model);
    knownTokens += sum(t);
    usd +=
      (t.in * p.in + t.out * p.out + t.cacheRead * p.cacheRead + t.cacheWrite * p.cacheWrite) /
      1_000_000;
  }
  // Sessions still waiting for a model have unknown tokens for now.
  const unknown = new Set(state.unknownSessions);
  for (const [kind, map] of [
    ["main", state.sessions],
    ["sub", state.subagents],
  ] as const) {
    for (const s of map.values()) {
      if (!s.pending) continue;
      unknownTokens += sum(s.pending);
      unknown.add(rateKey(kind, s.sessionId));
    }
  }
  const unit = "USD";
  if (knownTokens === 0 && unknownTokens > 0)
    return metric(
      null,
      unit,
      "estimated",
      withWindow(
        `all ${unknown.size} sessions have an unknown model; prices as of ${PRICES_AS_OF}`,
        window,
      ),
    );
  const priced = models.length > 0 ? models.sort().join(", ") : "no model";
  const note = unknown.size > 0 ? `; excludes ${unknown.size} sessions with unknown model` : "";
  return metric(
    usd,
    unit,
    "estimated",
    withWindow(
      `API-equivalent cost, not a subscription bill: tokens x ${priced} price, prices as of ${PRICES_AS_OF}${note}`,
      window,
    ),
  );
}
