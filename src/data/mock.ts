import { createRng, hash01, type Rng } from "../sim/rng.ts";
import { createSimClock, type SimClock, type Speed } from "./clock.ts";
import { scenarioList, isScenario, type ScenarioName } from "./scenarios.ts";
import { MAX_BATCH, type AgentEvent, type Source, type SourceStatus } from "./schema.ts";

// The seeded mock (CEO C33, C37). Everything is a pure function of (seed, scenario, sim ms):
// no Date.now(), no timers, so a range can be cut anywhere and the pieces join exactly.

// Sim time 0 is this instant; an event's ts is the anchor plus its sim ms.
export const ANCHOR_MS = Date.UTC(2026, 0, 1, 9, 0, 0);
export const CATCHUP_MS = 10 * 60_000;
export const TICK_MS = 250;
// One tick delivers at most this much sim time, the guard for main-thread stalls (C59).
export const MAX_TICK_SIM_MS = 60_000;
const SLOT_MS = 1000;

// Fixed fictional names; nothing here comes from the machine, cwd or env (C37).
const PROJECTS = [
  "/work/orbit-api",
  "/work/lumen-web",
  "/work/harbor-cli",
  "/work/atlas-docs",
  "/work/quartz-etl",
  "/work/ember-mobile",
];
const TASKS = [
  "Add pagination to the orders endpoint",
  "Fix flaky retry in the sync worker",
  "Write migration for the audit table",
  "Speed up the search index build",
  "Replace the legacy date helper",
  "Document the release checklist",
  "Trim unused exports from the client",
  "Add a dry-run flag to the importer",
];
const TOOLS = {
  claude: ["Read", "Edit", "Bash", "Grep", "Write"],
  codex: ["shell", "apply_patch", "read_file"],
} as const;
const MODELS = { claude: "claude-sonnet-4", codex: "gpt-5-codex" } as const;

const SUB_LANES = 3;
const SUB_PERIOD = 240;
const SUB_LIFE = 90;

// A lane is one agent's sessions over time. The generator reads only these fields, never a
// scenario name (CEO row 20).
interface Lane {
  index: number;
  sessionId: (cycle: number) => string;
  vendor: "claude" | "codex";
  projectKey: string;
  sub: boolean;
  parentIndex: number;
  // Slot at which the lane's first session begins.
  offset: number;
  turnLen: number;
  toolRate: number;
  // Slots between the starts of two sessions, and the slots of events in each; Infinity = one
  // session that holds.
  period: number;
  life: number;
  // Position in the session at which its session_end lands, at `endOff` ms of that slot;
  // Infinity = never. A position at `life` is the first slot after the last active one.
  endPos: number;
  endOff: number;
  // No turn_start or turn_end: tool calls and usage only.
  noTurns: boolean;
  // Error storm: from slot `from`, every `period` slots, `len` slots of nothing but an error.
  storm?: { from: number; period: number; len: number };
  // Silent after this slot.
  quietAfter?: number;
}

const HOLD = { period: Infinity, life: Infinity, endPos: Infinity, endOff: 0, noTurns: false };

function plan(seed: number): Lane[] {
  const rng = createRng(seed);
  const projects = [...PROJECTS];
  for (let i = projects.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [projects[i], projects[j]] = [projects[j], projects[i]];
  }
  const lanes: Lane[] = [];
  const mains = [0, 0, 1, 1, 2, 2, 2];
  mains.forEach((project, index) => {
    lanes.push({
      index,
      sessionId: () => `mock-${seed}-s${index}`,
      vendor: index % 3 === 2 ? "codex" : rng.next() < 0.3 ? "codex" : "claude",
      projectKey: projects[project],
      sub: false,
      parentIndex: -1,
      offset: 1 + rng.int(30),
      turnLen: 20 + rng.int(21),
      toolRate: 0.35 + rng.next() * 0.35,
      ...HOLD,
    });
  });
  for (let k = 0; k < SUB_LANES; k++) {
    const parent = lanes.filter((l) => l.vendor === "claude")[k % 4] ?? lanes[0];
    const index = mains.length + k;
    lanes.push({
      index,
      sessionId: (cycle) => `mock-${seed}-sub${k}-${cycle}`,
      vendor: "claude",
      projectKey: parent.projectKey,
      sub: true,
      parentIndex: parent.index,
      offset: 40 + rng.int(60) + k * 30,
      turnLen: 0,
      toolRate: 0.8,
      period: SUB_PERIOD,
      life: SUB_LIFE,
      endPos: SUB_LIFE - 1,
      endOff: 900,
      noTurns: true,
    });
  }
  return lanes;
}

// Scenarios (C44, E35, E36): each is a transform of the steady lanes, applied after plan(seed)
// has drawn from its rng, so steady is untouched. Extra lanes draw from their own rng.
type Transform = (lanes: Lane[], seed: number, rng: Rng) => Lane[];

const mainsOf = (lanes: Lane[]) => lanes.filter((l) => !l.sub);

// A session that starts, works without turns, and ends in the first slot after `life`.
const fastLane = (
  seed: number,
  rng: Rng,
  index: number,
  tag: string,
  projectKey: string,
  offset: number,
  life: number,
  period: number,
): Lane => ({
  index,
  sessionId: (cycle) => `mock-${seed}-${tag}-${cycle}`,
  vendor: rng.next() < 0.3 ? "codex" : "claude",
  projectKey,
  sub: false,
  parentIndex: -1,
  offset,
  turnLen: 0,
  toolRate: 0.35 + rng.next() * 0.35,
  period,
  life,
  endPos: life,
  endOff: 5,
  noTurns: true,
});

const TRANSFORMS: Record<ScenarioName, Transform> = {
  steady: (lanes) => lanes,
  burst: (lanes, seed) => {
    const mains = mainsOf(lanes).map((l) =>
      l.index === 0 ? { ...l, vendor: "claude" as const } : l,
    );
    for (let k = 0; k < 10; k++) {
      mains.push({
        index: mains.length,
        sessionId: (cycle) => `mock-${seed}-burst${k}-${cycle}`,
        vendor: "claude",
        projectKey: mains[0].projectKey,
        sub: true,
        parentIndex: 0,
        offset: 90,
        turnLen: 0,
        toolRate: 0.8,
        period: 120,
        life: 60,
        endPos: 59,
        endOff: 900,
        noTurns: true,
      });
    }
    return mains;
  },
  churn: (_lanes, seed, rng) => {
    // Six fast lanes, 20 s apart, so every 20 s boundary swaps one project in and one out. The
    // end lands at 5 ms, before the incoming start at 10 ms (C66).
    const out = PROJECTS.map((key, i) => fastLane(seed, rng, i, `c${i}`, key, 20 * i, 60, 120));
    // Two slow lanes idle longer than chunk 19's retire grace, so their halls retire and
    // return (C67).
    out.push(fastLane(seed, rng, 6, "pine", "/work/pine-sdk", 30, 60, 960));
    out.push(fastLane(seed, rng, 7, "delta", "/work/delta-ops", 60, 60, 670));
    return out;
  },
  overflow: (_lanes, seed, rng) => {
    const out: Lane[] = [];
    // One main lane every 15 s from 480 s until 40 exist, then the newest 32 end, newest first,
    // from 1,215 s, leaving 8 (C65).
    for (let j = 0; j < 40; j++) {
      const offset = 480 + 15 * j;
      const ends = j >= 8 ? 1215 + 15 * (39 - j) - offset : Infinity;
      out.push({
        index: j,
        sessionId: () => `mock-${seed}-o${j}`,
        vendor: rng.next() < 0.3 ? "codex" : "claude",
        projectKey: PROJECTS[0],
        sub: false,
        parentIndex: -1,
        offset,
        turnLen: 20 + rng.int(21),
        toolRate: 0.35 + rng.next() * 0.35,
        ...HOLD,
        life: ends,
        endPos: ends,
        endOff: 5,
      });
    }
    for (let j = 40; j < 42; j++) {
      out.push({
        index: j,
        sessionId: () => `mock-${seed}-o${j}`,
        vendor: "claude",
        projectKey: PROJECTS[1],
        sub: false,
        parentIndex: -1,
        offset: 1 + rng.int(30),
        turnLen: 20 + rng.int(21),
        toolRate: 0.35 + rng.next() * 0.35,
        ...HOLD,
      });
    }
    return out;
  },
  errors: (lanes) => {
    // Six main lanes see an error storm in [270 + 300n, 330 + 300n) s.
    const stormy = new Set(
      mainsOf(lanes)
        .slice(0, 6)
        .map((l) => l.index),
    );
    return lanes.map((l) =>
      stormy.has(l.index) ? { ...l, storm: { from: 270, period: 300, len: 60 } } : l,
    );
  },
  "codex-only": (lanes) => mainsOf(lanes).map((l) => ({ ...l, vendor: "codex" as const })),
  waiting: (lanes) => {
    // Three main lanes finish the first turn at or after slot 300 with waiting_user, then go
    // silent, so they still wait at 600 s and at 1,200 s.
    const quiet = new Set(
      mainsOf(lanes)
        .slice(0, 3)
        .map((l) => l.index),
    );
    return lanes.map((l) => {
      if (!quiet.has(l.index)) return l;
      let end = l.offset + l.turnLen - 1;
      while (end < 300) end += l.turnLen;
      return { ...l, quietAfter: end };
    });
  },
};

// The rng of a scenario's extra lanes: from the seed and the scenario name, apart from plan's.
function scenarioRng(seed: number, scenario: string): Rng {
  const codes = Array.from(scenario, (c) => c.charCodeAt(0));
  return createRng(Math.floor(hash01(seed, ...codes) * 4294967296));
}

function laneEvents(seed: number, lanes: Lane[], lane: Lane, slot: number): AgentEvent[] {
  if (slot < lane.offset || (lane.quietAfter !== undefined && slot > lane.quietAfter)) return [];
  const rel = slot - lane.offset;
  const cycle = Number.isFinite(lane.period) ? Math.floor(rel / lane.period) : 0;
  const pos = Number.isFinite(lane.period) ? rel - cycle * lane.period : rel;
  const active = pos < lane.life;
  const ending = pos === lane.endPos;
  if (!active && !ending) return [];
  const sessionId = lane.sessionId(cycle);
  const parent = lane.sub ? lanes[lane.parentIndex] : null;
  const draw = (k: number) => hash01(seed, lane.index, slot, k);
  const out: { off: number; make: (id: string, ts: string) => AgentEvent }[] = [];
  const add = (off: number, type: AgentEvent["type"], extra: Partial<AgentEvent> = {}) => {
    out.push({
      // A session's first slot starts it at 10 ms; nothing else may land at or before that.
      off: pos === 0 && type !== "session_start" ? Math.max(off, 11) : off,
      make: (id, ts) => ({
        id,
        vendor: lane.vendor,
        projectKey: lane.projectKey,
        sessionId,
        ...(parent ? { parentSessionId: parent.sessionId(0) } : {}),
        parentKnown: true,
        agentKind: lane.sub ? "sub" : "main",
        model: MODELS[lane.vendor],
        ts,
        type,
        provenance: { tokens: "real", status: "derived" },
        ...extra,
      }),
    });
  };
  const tools = TOOLS[lane.vendor];
  const turn = lane.noTurns ? 0 : Math.floor(pos / lane.turnLen);
  const inTurn = lane.noTurns ? pos : pos % lane.turnLen;
  const turnEnd = !lane.noTurns && inTurn === lane.turnLen - 1;
  const task = TASKS[Math.floor(hash01(seed, lane.index, turn, 99) * TASKS.length)];
  const storm = lane.storm;
  const since = storm ? slot - storm.from : -1;
  const stormy = storm !== undefined && since >= 0 && since % storm.period < storm.len;

  if (pos === 0) add(10, "session_start", { status: "idle" });
  if (stormy) {
    add(990, "error", { status: "error" });
  } else if (active) {
    // The first slot after a storm ends with one status event back to thinking.
    if (storm && since >= storm.len && since % storm.period === storm.len)
      add(20, "status", { status: "thinking" });
    if (!lane.noTurns && inTurn === 0)
      add(100, "turn_start", { status: "thinking", currentTask: task });
    const working = lane.noTurns ? true : inTurn >= 1 && inTurn <= lane.turnLen - 4;
    if (working && draw(1) < lane.toolRate) {
      const off = Math.floor(draw(2) * 400);
      const toolName = tools[Math.floor(draw(3) * tools.length)];
      add(off, "tool_call", { status: "tool", toolName, currentTask: task });
      add(off + 100 + Math.floor(draw(4) * 300), "tool_result", { status: "thinking", toolName });
    }
    if (pos > 0 && (turnEnd || pos % 5 === 0)) {
      add(500, "usage", {
        tokens: {
          in: 200 + Math.floor(draw(5) * 1800),
          out: 50 + Math.floor(draw(6) * 600),
          cacheRead: Math.floor(draw(7) * 4000),
          cacheWrite: Math.floor(draw(8) * 300),
        },
      });
    }
    if (turnEnd) add(800, "turn_end", { status: "waiting_user" });
  }
  if (ending) add(lane.endOff, "session_end");
  out.sort((a, b) => a.off - b.off);
  return out.map(({ off, make }, k) => {
    const ms = slot * SLOT_MS + off;
    return make(`mock-${seed}-${lane.index}-${slot}-${k}`, new Date(ANCHOR_MS + ms).toISOString());
  });
}

// The events with sim ms in [fromMs, toMs), ordered by ts, ties by id, so any split of a range
// joins to the whole in order (C33).
export function mockEvents(
  seed: number,
  scenario: string,
  fromMs: number,
  toMs: number,
): AgentEvent[] {
  if (!isScenario(scenario))
    throw new Error(`unknown scenario "${scenario}" (use ${scenarioList()})`);
  const lanes = TRANSFORMS[scenario](plan(seed), seed, scenarioRng(seed, scenario));
  const out: AgentEvent[] = [];
  for (let slot = Math.floor(fromMs / SLOT_MS); slot * SLOT_MS < toMs; slot++) {
    for (const lane of lanes) {
      for (const e of laneEvents(seed, lanes, lane, slot)) {
        const ms = Date.parse(e.ts) - ANCHOR_MS;
        if (ms >= fromMs && ms < toMs) out.push(e);
      }
    }
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
}

export interface MockSourceOptions {
  seed: number;
  scenario: string;
  // The only time source: sim ms is `clock.now() - ANCHOR_MS`.
  clock: SimClock;
  // Runs `fn` every TICK_MS and returns a canceller; tests pass a fake.
  schedule?: (fn: () => void, ms: number) => () => void;
  // Under freeze=1 only the catch-up is sent (C33).
  freeze?: boolean;
  generate?: typeof mockEvents;
  // Calls back with true while the tab is hidden; returns an unsubscribe. The clock is held
  // meanwhile (C50).
  visibility?: (onChange: (hidden: boolean) => void) => () => void;
}

const realSchedule = (fn: () => void, ms: number) => {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
};

export class MockSource implements Source {
  readonly name = "mock";
  readonly clock: SimClock;
  private readonly options: MockSourceOptions;
  private events: (events: unknown[]) => void = () => {};
  private statusCb: (status: SourceStatus, detail?: string) => void = () => {};
  // Bumped by stop(); every delivery checks it, so a late timer sends nothing (C34).
  private generation = 0;
  private running = false;
  private cancel: (() => void) | null = null;
  private unwatch: (() => void) | null = null;
  private last = CATCHUP_MS;
  private behind = false;

  constructor(options: MockSourceOptions) {
    this.options = options;
    this.clock = options.clock;
  }

  onEvents(callback: (events: unknown[]) => void): void {
    this.events = callback;
  }

  onStatus(callback: (status: SourceStatus, detail?: string) => void): void {
    this.statusCb = callback;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const generation = ++this.generation;
    const { seed, scenario, freeze } = this.options;
    const generate = this.options.generate ?? mockEvents;
    this.last = CATCHUP_MS;
    this.behind = false;
    this.unwatch = this.options.visibility?.((hidden) => this.clock.hold(hidden)) ?? null;
    this.statusCb("catching_up");
    try {
      const all = generate(seed, scenario, 0, CATCHUP_MS);
      for (let i = 0; i < all.length; i += MAX_BATCH) {
        if (generation !== this.generation) return;
        this.events(all.slice(i, i + MAX_BATCH));
      }
    } catch (error) {
      this.fail(generation, error, 0, CATCHUP_MS);
      return;
    }
    if (generation !== this.generation) return;
    this.statusCb("live");
    // A live callback may have stopped the source; scheduling now would leak the timer.
    if (generation !== this.generation) return;
    if (!freeze)
      this.cancel = (this.options.schedule ?? realSchedule)(() => this.tick(generation), TICK_MS);
  }

  // Delivers [last, now) in sim ms, at most MAX_TICK_SIM_MS per tick. Reports catching_up only
  // when more than one cap behind and live only when fully caught up, so steady ticks (even at
  // 60x) cause no status change (C59). Paused and caught up, a tick does nothing at all.
  private tick(generation: number): void {
    if (generation !== this.generation) return;
    const from = this.last;
    let to = from;
    try {
      const now = this.clock.now() - ANCHOR_MS;
      if (now <= from) return;
      to = Math.min(now, from + MAX_TICK_SIM_MS);
      if (now - from > MAX_TICK_SIM_MS && !this.behind) {
        this.behind = true;
        this.statusCb("catching_up");
        if (generation !== this.generation) return;
      }
      const { seed, scenario } = this.options;
      const batch = (this.options.generate ?? mockEvents)(seed, scenario, from, to);
      this.last = to;
      for (let i = 0; i < batch.length; i += MAX_BATCH) {
        if (generation !== this.generation) return;
        this.events(batch.slice(i, i + MAX_BATCH));
      }
      if (to === now && this.behind) {
        this.behind = false;
        if (generation === this.generation) this.statusCb("live");
      }
    } catch (error) {
      this.fail(generation, error, from, to);
    }
  }

  // One error status naming the scenario and sim range, then no more ticks (C58). Never the
  // error message: it could carry field values (D16).
  private fail(generation: number, error: unknown, from: number, to: number): void {
    if (generation !== this.generation) return;
    this.running = false;
    this.cancel?.();
    this.cancel = null;
    this.unwatch?.();
    this.unwatch = null;
    this.generation++;
    const name = error instanceof Error ? error.name : "Error";
    this.statusCb("error", `${this.options.scenario} failed over sim ${from}-${to} ms: ${name}`);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    this.cancel?.();
    this.cancel = null;
    this.unwatch?.();
    this.unwatch = null;
    this.statusCb("closed");
  }
}

// Node has no DOM lib here, so the document is reached through globalThis.
interface VisibilityDocument {
  visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

function watchVisibility(onChange: (hidden: boolean) => void): () => void {
  const doc = (globalThis as { document?: VisibilityDocument }).document;
  if (!doc) return () => {};
  const apply = () => onChange(doc.visibilityState === "hidden");
  doc.addEventListener("visibilitychange", apply);
  apply();
  return () => doc.removeEventListener("visibilitychange", apply);
}

// The app's mock: a fresh clock at the end of the catch-up, running in real time. Under freeze
// it starts paused and locked at speed 1 whatever `speed` says (C53).
export function createMockSource(options: {
  seed: number;
  scenario: string;
  freeze: boolean;
  speed?: Speed;
  realNow?: () => number;
}): MockSource {
  const { freeze, realNow } = options;
  const clock = createSimClock({
    realNow,
    startMs: ANCHOR_MS + CATCHUP_MS,
    speed: freeze ? 1 : (options.speed ?? 1),
    paused: freeze,
    locked: freeze,
  });
  return new MockSource({
    seed: options.seed,
    scenario: options.scenario,
    freeze,
    clock,
    visibility: freeze ? undefined : watchVisibility,
  });
}
