import { AgentEvent } from "./schema.ts";

// Pure reducers for the data slice (CEO C36, C38; eng Q1, P4). They run in Node tests and in
// mock:dump without the store; the slice only calls them and commits.

export const RING_CAP = 50_000;
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
}

export interface DataState {
  projects: Map<string, ProjectAgg>;
  sessions: Map<string, SessionAgg>;
  subagents: Map<string, SessionAgg>;
  tokens: Tokens;
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

function pushRing(ring: Ring, event: AgentEvent): void {
  if (ring.size === ring.cap) {
    const old = ring.buf[ring.head];
    if (old) ring.seen.delete(old.id);
  } else {
    ring.size++;
  }
  ring.buf[ring.head] = event;
  ring.seen.add(event.id);
  ring.head = (ring.head + 1) % ring.cap;
}

// Builds the next state from valid events (C38). Nothing is touched until the whole batch has
// reduced, so a throw leaves the ring and the seen ids as they were.
export function applyBatch(state: DataState, events: readonly AgentEvent[]): DataState {
  if (events.length === 0) return state;
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
  const ownedSessions = new Set<SessionAgg>();
  const ownedProjects = new Set<ProjectAgg>();
  let tokens = state.tokens;

  for (const e of fresh) {
    const at = Date.parse(e.ts);
    const sub = e.agentKind === "sub";
    const map = sub ? subagents : sessions;
    const isNew = !map.has(e.sessionId);
    const session = own<SessionAgg>(map, e.sessionId, ownedSessions, () => ({
      sessionId: e.sessionId,
      projectKey: e.projectKey,
      vendor: e.vendor,
      agentKind: e.agentKind,
      parentSessionId: e.parentSessionId,
      lastSeen: at,
      startedAt: at,
      events: 0,
      tokens: zeroTokens(),
      status: "idle",
      statusAt: -Infinity,
      statusId: "",
    }));
    session.events++;
    session.lastSeen = Math.max(session.lastSeen, at);
    session.startedAt = Math.min(session.startedAt, at);
    session.tokens = addTokens(session.tokens, e.tokens);
    const status: SessionStatus | undefined =
      e.status ?? (e.type === "session_end" ? "done" : undefined);
    if (status && newer(at, e.id, session.statusAt, session.statusId)) {
      session.status = status;
      session.statusAt = at;
      session.statusId = e.id;
    }

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
    if (isNew) project[sub ? "subagents" : "sessions"]++;
    tokens = addTokens(tokens, e.tokens);
  }

  for (const e of fresh) pushRing(state.ring, e);
  return {
    ...state,
    sessions,
    subagents,
    projects,
    tokens,
    ringVersion: state.ringVersion + 1,
    dataHealth: {
      ...state.dataHealth,
      applied: state.dataHealth.applied + fresh.length,
      duplicates: state.dataHealth.duplicates + duplicates,
    },
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
