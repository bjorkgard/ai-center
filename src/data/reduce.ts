import {
  IDLE_END_MS,
  IDLE_KW,
  INLET_BASE_C,
  INLET_C_PER_KW,
  KW_PER_TOKEN_PER_MIN,
  LAG_TAU_S,
  RACK_MAX_KW,
  RATE_WINDOW_S,
} from "../config/estimation.ts";
import { priceOf } from "../config/prices.ts";
import { applyJobEvent, dropJobsOf, type JobAgg } from "./jobs.ts";
import { AgentEvent } from "./schema.ts";

// Pure reducers for the data slice (CEO C36, C38; eng Q1, P4). They run in Node tests and in
// mock:dump without the store; the slice only calls them and commits.

export const RING_CAP = 50_000;
// Evicted session ids remembered so a late event reactivates them (CEO T4).
export const TOMBSTONE_CAP = 100_000;
export const SESSION_ROWS = 50;
export const PEEK_EVENTS = 20;
export const NO_EVENTS = "No recent events (older than the buffer)";

export const noSessionsText = (status: string): string => `No sessions yet (source: ${status})`;

export interface Tokens {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

export type SessionStatus = NonNullable<AgentEvent["status"]>;

export interface SessionAgg {
  sessionId: string;
  projectKey: string;
  vendor: AgentEvent["vendor"];
  agentKind: AgentEvent["agentKind"];
  parentSessionId?: string;
  // Epoch ms of the greatest event ts, and of the first.
  lastSeen: number;
  startedAt: number;
  events: number;
  tokens: Tokens;
  // Follows the event with the greatest ts that carries a status (ties by id), not arrival.
  status: SessionStatus;
  statusAt: number;
  statusId: string;
  // The latest model seen on an event of this session.
  model?: string;
  // Tokens that arrived before the session named any model; they move to the first one named.
  pending?: Tokens;
  // Set while the session is done only because it was idle for IDLE_END_MS: the end time and
  // the status it had, so a late event can reopen it.
  inferred?: { endAt: number; status: SessionStatus; statusAt: number; statusId: string };
  // The TodoWrite item in progress, for the job model.
  activeTodo?: string;
}

// Rate state of one session, kept apart from the aggregates because it depends on when the
// store advanced, not only on which events arrived (C49).
export interface RateAgg {
  // Tokens (in + out) per sim second, keyed by the second; only the trailing window is kept
  // once the store has advanced.
  buckets: Map<number, number>;
  // Inlet temperature lag of a rack (a main session): its value at the start of sim second
  // `lagSec`. `advance` integrates it exactly in sim time (CEO T3).
  inletC: number;
  lagSec: number;
}

export interface ProjectAgg {
  projectKey: string;
  sessions: number;
  subagents: number;
  lastSeen: number;
  events: number;
  tokens: Tokens;
}

export interface DataHealth {
  applied: number;
  batches: number;
  lastBatchSize: number;
  lastApplyMs: number;
  // Dropped events per "source:issuePath" (the first issue of each event).
  invalid: Record<string, number>;
  duplicates: number;
  failedBatches: number;
}

// A fixed-size circular array with a head index: no Array.shift. `seen` holds exactly the ids
// in the ring, so it is bounded with it.
export interface Ring {
  cap: number;
  buf: (AgentEvent | undefined)[];
  head: number;
  size: number;
  seen: Set<string>;
  // Events in the ring per session id: a done session is evicted only at 0 (CEO X1).
  refs: Map<string, number>;
}

export interface DataState {
  projects: Map<string, ProjectAgg>;
  sessions: Map<string, SessionAgg>;
  subagents: Map<string, SessionAgg>;
  tokens: Tokens;
  // Rate state by `rateKey(kind, sessionId)`.
  rates: Map<string, RateAgg>;
  // Tokens by the model in effect when they arrived ("" = never named). Never reduced by
  // eviction, so compaction cannot change cost; a model with no price is an unknown model.
  modelTokens: Map<string, Tokens>;
  // Rate keys of sessions that ever had tokens under an unknown model, each counted once
  // whatever became of them (capped like the tombstones). Live pending tokens are not here.
  unknownSessions: Set<string>;
  // Jobs per session (authoritative, eng Q1); dropped with their session.
  jobs: Map<string, JobAgg>;
  // Ids of evicted sessions, oldest first, mutated in place like the ring.
  tombstones: Set<string>;
  // Mutated in place at commit time; ringVersion changes with every commit that touches it.
  ring: Ring;
  ringVersion: number;
  dataHealth: DataHealth;
}

export function createRing(cap: number = RING_CAP): Ring {
  return {
    cap,
    buf: new Array<AgentEvent | undefined>(cap).fill(undefined),
    head: 0,
    size: 0,
    seen: new Set(),
    refs: new Map(),
  };
}

export function emptyHealth(): DataHealth {
  return {
    applied: 0,
    batches: 0,
    lastBatchSize: 0,
    lastApplyMs: 0,
    invalid: {},
    duplicates: 0,
    failedBatches: 0,
  };
}

const zeroTokens = (): Tokens => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 });

export function emptyData(cap: number = RING_CAP): DataState {
  return {
    projects: new Map(),
    sessions: new Map(),
    subagents: new Map(),
    tokens: zeroTokens(),
    rates: new Map(),
    modelTokens: new Map(),
    unknownSessions: new Set(),
    jobs: new Map(),
    tombstones: new Set(),
    ring: createRing(cap),
    ringVersion: 0,
    dataHealth: emptyHealth(),
  };
}

export const aggregatesOf = (
  s: Pick<DataState, "projects" | "sessions" | "subagents" | "tokens">,
) => ({
  projects: s.projects,
  sessions: s.sessions,
  subagents: s.subagents,
  tokens: s.tokens,
});

export const totalInvalid = (health: DataHealth): number =>
  Object.values(health.invalid).reduce((a, b) => a + b, 0);

export interface Reject {
  id: string | null;
  path: string;
  code: string;
}

// Every event passes AgentEvent.safeParse (C36). A rejected event reports its first issue's
// path and code, never a field value.
export function validate(raw: readonly unknown[]): { events: AgentEvent[]; rejects: Reject[] } {
  const events: AgentEvent[] = [];
  const rejects: Reject[] = [];
  for (const item of raw) {
    const result = AgentEvent.safeParse(item);
    if (result.success) {
      events.push(result.data);
      continue;
    }
    const issue = result.error.issues[0];
    const id = (item as { id?: unknown } | null)?.id;
    rejects.push({
      id: typeof id === "string" ? id : null,
      path: issue.path.join(".") || "(root)",
      code: issue.code,
    });
  }
  return { events, rejects };
}

const newer = (at: number, id: string, curAt: number, curId: string) =>
  at > curAt || (at === curAt && id > curId);

const addTokens = (a: Tokens, b: Tokens | undefined): Tokens =>
  b
    ? {
        in: a.in + b.in,
        out: a.out + b.out,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
      }
    : a;

// Copy-on-write: an entry is copied once per batch, then changed in place.
function own<T extends object>(map: Map<string, T>, key: string, owned: Set<T>, make: () => T): T {
  const cur = map.get(key);
  if (cur && owned.has(cur)) return cur;
  const next = cur ? { ...cur } : make();
  owned.add(next);
  map.set(key, next);
  return next;
}

// A rate's buckets are changed in place, so its first copy in a batch copies them too.
function ownRate(
  map: Map<string, RateAgg>,
  key: string,
  owned: Set<RateAgg>,
  make: () => RateAgg,
): RateAgg {
  const had = map.get(key);
  const rate = own(map, key, owned, make);
  if (had && had !== rate) rate.buckets = new Map(had.buckets);
  return rate;
}

function pushRing(ring: Ring, event: AgentEvent): void {
  if (ring.size === ring.cap) {
    const old = ring.buf[ring.head];
    if (old) {
      ring.seen.delete(old.id);
      const left = (ring.refs.get(old.sessionId) ?? 1) - 1;
      if (left <= 0) ring.refs.delete(old.sessionId);
      else ring.refs.set(old.sessionId, left);
    }
  } else {
    ring.size++;
  }
  ring.buf[ring.head] = event;
  ring.seen.add(event.id);
  ring.refs.set(event.sessionId, (ring.refs.get(event.sessionId) ?? 0) + 1);
  ring.head = (ring.head + 1) % ring.cap;
}

const idleInletC = INLET_BASE_C + INLET_C_PER_KW * IDLE_KW;
// Ids of sessions and subagents share no namespace guarantee, so keys carry the kind.
export const rateKey = (kind: AgentEvent["agentKind"], id: string): string => `${kind}:${id}`;

// A copy of the set with `key` added; the oldest id goes past the cap, as with the tombstones.
function withUnknown(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set).add(key);
  if (next.size > TOMBSTONE_CAP) next.delete(next.values().next().value!);
  return next;
}

export interface ApplyOptions {
  // Source time now (epoch ms): an event later than this counts as now (spec 1.4).
  now?: number;
  // The last time the store advanced: an earlier event counts as that time for the buckets
  // and the lag, which are already integrated up to it (eng voice H1).
  mark?: number;
}

// Builds the next state from valid events (C38). Nothing is touched until the whole batch has
// reduced, so a throw leaves the ring and the seen ids as they were.
export function applyBatch(
  state: DataState,
  events: readonly AgentEvent[],
  options: ApplyOptions = {},
): DataState {
  if (events.length === 0) return state;
  const { now = Infinity, mark = -Infinity } = options;
  const local = new Set<string>();
  const fresh: AgentEvent[] = [];
  for (const e of events) {
    if (state.ring.seen.has(e.id) || local.has(e.id)) continue;
    local.add(e.id);
    fresh.push(e);
  }
  const duplicates = events.length - fresh.length;
  if (fresh.length === 0) {
    return {
      ...state,
      dataHealth: { ...state.dataHealth, duplicates: state.dataHealth.duplicates + duplicates },
    };
  }

  const sessions = new Map(state.sessions);
  const subagents = new Map(state.subagents);
  const projects = new Map(state.projects);
  const jobs = new Map(state.jobs);
  const rates = new Map(state.rates);
  const ownedRates = new Set<RateAgg>();
  const ownedSessions = new Set<SessionAgg>();
  const ownedProjects = new Set<ProjectAgg>();
  let tokens = state.tokens;
  const reactivated: string[] = [];
  let modelTokens = state.modelTokens;
  let modelOwned = false;
  let unknownSessions = state.unknownSessions;

  for (const e of fresh) {
    const at = Date.parse(e.ts);
    // `seen` is the time the derived values use; `at` still orders statuses.
    const seen = Math.min(at, now);
    const bucketAt = Math.max(seen, mark);
    const sub = e.agentKind === "sub";
    const map = sub ? subagents : sessions;
    const isNew = !map.has(e.sessionId);
    const key = rateKey(e.agentKind, e.sessionId);
    const revived = isNew && state.tombstones.has(key);
    const session = own<SessionAgg>(map, e.sessionId, ownedSessions, () => ({
      sessionId: e.sessionId,
      projectKey: e.projectKey,
      vendor: e.vendor,
      agentKind: e.agentKind,
      parentSessionId: e.parentSessionId,
      lastSeen: seen,
      startedAt: seen,
      events: 0,
      tokens: zeroTokens(),
      status: "idle",
      statusAt: -Infinity,
      statusId: "",
    }));
    const sec = Math.floor(bucketAt / 1000);
    const rate = ownRate(rates, key, ownedRates, () => ({
      buckets: new Map(),
      inletC: idleInletC,
      lagSec: sec,
    }));
    // Before its first advance a rack's lag starts at its earliest event, whatever the order.
    rate.lagSec = Math.min(rate.lagSec, sec);
    if (revived) reactivated.push(key);
    const ended = session.inferred;
    if (ended) {
      session.inferred = undefined;
      if (seen < ended.endAt) {
        // A late event inside the idle window: the session never ended.
        session.status = ended.status;
        session.statusAt = ended.statusAt;
        session.statusId = ended.statusId;
      } else {
        // Activity after the idle end: a resumed session, whatever it was doing before.
        session.status = "idle";
        session.statusAt = ended.endAt;
        session.statusId = "";
      }
    }
    session.events++;
    session.lastSeen = Math.max(session.lastSeen, seen);
    session.startedAt = Math.min(session.startedAt, seen);
    session.tokens = addTokens(session.tokens, e.tokens);
    // Tokens are priced at the model in effect when they arrive; those before any model wait.
    const credit = (model: string, t: Tokens) => {
      if (!modelOwned) {
        modelTokens = new Map(modelTokens);
        modelOwned = true;
      }
      modelTokens.set(model, addTokens(modelTokens.get(model) ?? zeroTokens(), t));
      if (!priceOf(model) && !unknownSessions.has(key))
        unknownSessions = withUnknown(unknownSessions, key);
    };
    if (e.model !== undefined) {
      if (session.model === undefined && session.pending) {
        credit(e.model, session.pending);
        session.pending = undefined;
      }
      session.model = e.model;
    }
    if (e.tokens) {
      if (session.model !== undefined) credit(session.model, e.tokens);
      else session.pending = addTokens(session.pending ?? zeroTokens(), e.tokens);
      const flow = e.tokens.in + e.tokens.out;
      if (flow > 0) {
        rate.buckets.set(sec, (rate.buckets.get(sec) ?? 0) + flow);
      }
    }
    const status: SessionStatus | undefined =
      e.status ?? (e.type === "session_end" ? "done" : undefined);
    if (status && newer(at, e.id, session.statusAt, session.statusId)) {
      session.status = status;
      session.statusAt = at;
      session.statusId = e.id;
    }
    applyJobEvent(jobs, session, e, at);

    const project = own(projects, e.projectKey, ownedProjects, () => ({
      projectKey: e.projectKey,
      sessions: 0,
      subagents: 0,
      lastSeen: at,
      events: 0,
      tokens: zeroTokens(),
    }));
    project.events++;
    project.lastSeen = Math.max(project.lastSeen, at);
    project.tokens = addTokens(project.tokens, e.tokens);
    // A revived session was counted when it first appeared.
    if (isNew && !revived) project[sub ? "subagents" : "sessions"]++;
    tokens = addTokens(tokens, e.tokens);
  }

  for (const e of fresh) pushRing(state.ring, e);
  for (const key of reactivated) state.tombstones.delete(key);
  return {
    ...state,
    modelTokens,
    unknownSessions,
    sessions,
    subagents,
    projects,
    jobs,
    rates,
    tokens,
    ringVersion: state.ringVersion + 1,
    dataHealth: {
      ...state.dataHealth,
      applied: state.dataHealth.applied + fresh.length,
      duplicates: state.dataHealth.duplicates + duplicates,
    },
  };
}

export interface AdvanceOptions {
  // While the source is still delivering its backlog nothing is inferred or integrated: the
  // batches arrive in time order but the seconds they fill are not complete (eng voice H1).
  catchingUp?: boolean;
}

// Tokens of a main session and its subagents, per sim second.
function rackBuckets(rate: RateAgg | undefined, subs: readonly RateAgg[]): Map<number, number> {
  const out = new Map(rate?.buckets);
  for (const sub of subs) for (const [sec, n] of sub.buckets) out.set(sec, (out.get(sec) ?? 0) + n);
  return out;
}

export const rackKwOf = (tokensPerMin: number): number =>
  Math.min(RACK_MAX_KW, IDLE_KW + KW_PER_TOKEN_PER_MIN * tokensPerMin);
const inletTarget = (tokensPerMin: number): number =>
  INLET_BASE_C + INLET_C_PER_KW * rackKwOf(tokensPerMin);

// Integrates the first-order lag over the whole seconds [fromSec, toSec) (CEO T3, E57): one
// step per second while any bucket is in the window, one closed-form decay once it is empty.
// A step uses the tokens of the 60 s ending in that second, so the result depends only on
// which seconds have been filled, never on how the time was cut into advances.
export function integrateInlet(
  inlet: number,
  buckets: ReadonlyMap<number, number>,
  fromSec: number,
  toSec: number,
): number {
  let last = -Infinity;
  for (const sec of buckets.keys()) last = Math.max(last, sec);
  let window = 0;
  for (let j = fromSec - RATE_WINDOW_S + 1; j <= fromSec; j++) window += buckets.get(j) ?? 0;
  let value = inlet;
  for (let k = fromSec; k < toSec; k++) {
    if (k > fromSec) window += (buckets.get(k) ?? 0) - (buckets.get(k - RATE_WINDOW_S) ?? 0);
    if (window === 0 && k >= last) {
      // Nothing left in the window or after it: the rest is one decay toward idle.
      const target = inletTarget(0);
      value = target + (value - target) * Math.exp(-(toSec - k) / LAG_TAU_S);
      return Math.abs(value - target) < 1e-12 ? target : value;
    }
    const target = inletTarget(window);
    value = target + (value - target) * Math.exp(-1 / LAG_TAU_S);
  }
  return value;
}

// Moves the derived state to source time `toMs` (epoch ms): ends sessions idle for IDLE_END_MS
// at exactly last activity + IDLE_END_MS, integrates every rack's inlet lag over the whole
// seconds up to it, drops buckets that left the window and evicts done sessions the ring no
// longer holds. Returns the same state when none of that changed anything (E-voice M9).
export function advance(state: DataState, toMs: number, options: AdvanceOptions = {}): DataState {
  if (options.catchingUp) return state;
  const toSec = Math.floor(toMs / 1000);
  const keepFrom = toSec - RATE_WINDOW_S + 1;
  let sessions = state.sessions;
  let subagents = state.subagents;
  let rates = state.rates;
  const owned = new Set<SessionAgg>();
  const edit = (kind: "main" | "sub", s: SessionAgg): SessionAgg => {
    if (owned.has(s)) return s;
    if (kind === "main" && sessions === state.sessions) sessions = new Map(sessions);
    if (kind === "sub" && subagents === state.subagents) subagents = new Map(subagents);
    const copy = { ...s };
    owned.add(copy);
    (kind === "main" ? sessions : subagents).set(s.sessionId, copy);
    return copy;
  };
  const ownedRates = new Set<RateAgg>();
  const editRate = (key: string, r: RateAgg): RateAgg => {
    if (ownedRates.has(r)) return r;
    if (rates === state.rates) rates = new Map(rates);
    const copy = { ...r, buckets: new Map(r.buckets) };
    ownedRates.add(copy);
    rates.set(key, copy);
    return copy;
  };

  // Idle end.
  for (const [kind, map] of [
    ["main", state.sessions],
    ["sub", state.subagents],
  ] as const) {
    for (const s of map.values()) {
      if (s.status === "done" || s.lastSeen + IDLE_END_MS > toMs) continue;
      const next = edit(kind, s);
      next.inferred = {
        endAt: s.lastSeen + IDLE_END_MS,
        status: s.status,
        statusAt: s.statusAt,
        statusId: s.statusId,
      };
      next.status = "done";
      next.statusAt = next.inferred.endAt;
      next.statusId = "";
    }
  }

  // Inlet lag of every rack that is not done, then the window.
  const subsOf = new Map<string, RateAgg[]>();
  for (const sub of subagents.values()) {
    const rate = state.rates.get(rateKey("sub", sub.sessionId));
    if (sub.parentSessionId === undefined || !rate) continue;
    const list = subsOf.get(sub.parentSessionId);
    if (list) list.push(rate);
    else subsOf.set(sub.parentSessionId, [rate]);
  }
  for (const s of sessions.values()) {
    const key = rateKey("main", s.sessionId);
    const rate = state.rates.get(key);
    // Done racks integrate too: pruning moves lagSec, so it must never skip unintegrated time.
    if (!rate || rate.lagSec >= toSec) continue;
    const inlet = integrateInlet(
      rate.inletC,
      rackBuckets(rate, subsOf.get(s.sessionId) ?? []),
      rate.lagSec,
      toSec,
    );
    if (inlet === rate.inletC) continue;
    const next = editRate(key, rate);
    next.inletC = inlet;
    next.lagSec = toSec;
  }
  for (const [key, rate] of [...rates]) {
    let stale = false;
    for (const sec of rate.buckets.keys()) if (sec < keepFrom) stale = true;
    if (!stale) continue;
    const next = editRate(key, rate);
    for (const sec of next.buckets.keys()) if (sec < keepFrom) next.buckets.delete(sec);
    if (key.startsWith("main:")) next.lagSec = Math.max(next.lagSec, toSec);
  }

  // Eviction of done sessions the ring no longer holds (CEO X1).
  const gone = new Set<string>();
  let modelTokens = state.modelTokens;
  let unknownSessions = state.unknownSessions;
  for (const [kind, map] of [
    ["main", sessions],
    ["sub", subagents],
  ] as const) {
    for (const s of [...map.values()]) {
      const key = rateKey(kind, s.sessionId);
      if (
        s.status !== "done" ||
        state.ring.refs.has(s.sessionId) ||
        (rates.get(key)?.buckets.size ?? 0) > 0
      )
        continue;
      if (kind === "main" && sessions === state.sessions) sessions = new Map(sessions);
      if (kind === "sub" && subagents === state.subagents) subagents = new Map(subagents);
      if (rates === state.rates) rates = new Map(rates);
      (kind === "main" ? sessions : subagents).delete(s.sessionId);
      rates.delete(key);
      gone.add(s.sessionId);
      state.tombstones.add(key);
      if (state.tombstones.size > TOMBSTONE_CAP)
        state.tombstones.delete(state.tombstones.values().next().value!);
      if (s.pending) {
        // Never named a model: its tokens become unknown-model tokens.
        if (modelTokens === state.modelTokens) modelTokens = new Map(modelTokens);
        modelTokens.set("", addTokens(modelTokens.get("") ?? zeroTokens(), s.pending));
        unknownSessions = withUnknown(unknownSessions, key);
      }
    }
  }
  let jobs = state.jobs;
  if (gone.size > 0) {
    jobs = new Map(jobs);
    dropJobsOf(jobs, gone);
  }

  if (sessions === state.sessions && subagents === state.subagents && rates === state.rates)
    return state;
  return {
    ...state,
    sessions,
    subagents,
    rates,
    jobs,
    modelTokens,
    unknownSessions,
  };
}

// Oldest first.
export function ringEvents(ring: Ring): AgentEvent[] {
  const out: AgentEvent[] = [];
  const start = (ring.head - ring.size + ring.cap) % ring.cap;
  for (let i = 0; i < ring.size; i++) out.push(ring.buf[(start + i) % ring.cap]!);
  return out;
}

// A session's last events from the ring, in arrival order (newest last) (C32).
export function peekEvents(
  ring: Ring,
  sessionId: string,
  limit: number = PEEK_EVENTS,
): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (let i = 1; i <= ring.size && out.length < limit; i++) {
    const e = ring.buf[(ring.head - i + ring.cap) % ring.cap]!;
    if (e.sessionId === sessionId) out.push(e);
  }
  return out.reverse();
}

// Project keys with at least one main session that is not done, sorted (C46). Reducers never
// remove projects, so this is what tells a live project from a finished one.
export function activeProjects(state: Pick<DataState, "sessions">): string[] {
  const keys = new Set<string>();
  for (const s of state.sessions.values()) if (s.status !== "done") keys.add(s.projectKey);
  return [...keys].sort();
}

// Sessions newest first, capped (C42).
export function sessionList(
  sessions: ReadonlyMap<string, SessionAgg>,
  max: number = SESSION_ROWS,
): { rows: SessionAgg[]; more: number } {
  const all = [...sessions.values()].sort(
    (a, b) => b.lastSeen - a.lastSeen || (a.sessionId < b.sessionId ? 1 : -1),
  );
  return { rows: all.slice(0, max), more: Math.max(0, all.length - max) };
}
