import { createRng, hash01 } from "../sim/rng.ts";
import { MAX_BATCH, type AgentEvent, type Source, type SourceStatus } from "./schema.ts";

// The seeded mock (CEO C33, C37). Everything is a pure function of (seed, scenario, sim ms):
// no Date.now(), no timers, so a range can be cut anywhere and the pieces join exactly.

// Sim time 0 is this instant; an event's ts is the anchor plus its sim ms.
export const ANCHOR_MS = Date.UTC(2026, 0, 1, 9, 0, 0);
export const CATCHUP_MS = 10 * 60_000;
export const TICK_MS = 250;
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
}

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
    });
  }
  return lanes;
}

function laneEvents(seed: number, lanes: Lane[], lane: Lane, slot: number): AgentEvent[] {
  let pos: number;
  let cycle = 0;
  let last: boolean;
  if (lane.sub) {
    if (slot < lane.offset) return [];
    cycle = Math.floor((slot - lane.offset) / SUB_PERIOD);
    pos = (slot - lane.offset) % SUB_PERIOD;
    if (pos >= SUB_LIFE) return [];
    last = pos === SUB_LIFE - 1;
  } else {
    if (slot < lane.offset) return [];
    pos = slot - lane.offset;
    last = false;
  }
  const sessionId = lane.sessionId(cycle);
  const parent = lane.sub ? lanes[lane.parentIndex] : null;
  const draw = (k: number) => hash01(seed, lane.index, slot, k);
  const out: { off: number; make: (id: string, ts: string) => AgentEvent }[] = [];
  const add = (off: number, type: AgentEvent["type"], extra: Partial<AgentEvent> = {}) => {
    out.push({
      off,
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
  const turn = lane.sub ? 0 : Math.floor(pos / lane.turnLen);
  const inTurn = lane.sub ? pos : pos % lane.turnLen;
  const turnEnd = !lane.sub && inTurn === lane.turnLen - 1;
  const task = TASKS[Math.floor(hash01(seed, lane.index, turn, 99) * TASKS.length)];

  if (pos === 0) add(10, "session_start", { status: "idle" });
  if (!lane.sub && inTurn === 0) add(100, "turn_start", { status: "thinking", currentTask: task });
  const working = lane.sub ? true : inTurn >= 1 && inTurn <= lane.turnLen - 4;
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
  if (last) add(900, "session_end");
  out.sort((a, b) => a.off - b.off);
  return out.map(({ off, make }, k) => {
    const ms = slot * SLOT_MS + off;
    return make(`mock-${seed}-${lane.index}-${slot}-${k}`, new Date(ANCHOR_MS + ms).toISOString());
  });
}

// The events with sim ms in [fromMs, toMs), in generator order: by one-second slot, then lane,
// then time (C33).
export function mockEvents(
  seed: number,
  scenario: string,
  fromMs: number,
  toMs: number,
): AgentEvent[] {
  if (scenario !== "steady") throw new Error(`unknown scenario "${scenario}" (only steady)`);
  const lanes = plan(seed);
  const out: AgentEvent[] = [];
  for (let slot = Math.floor(fromMs / SLOT_MS); slot * SLOT_MS < toMs; slot++) {
    for (const lane of lanes) {
      for (const e of laneEvents(seed, lanes, lane, slot)) {
        const ms = Date.parse(e.ts) - ANCHOR_MS;
        if (ms >= fromMs && ms < toMs) out.push(e);
      }
    }
  }
  return out;
}

export interface MockSourceOptions {
  seed: number;
  scenario: string;
  // The sim clock in ms; the real one starts at CATCHUP_MS.
  now: () => number;
  // Runs `fn` every TICK_MS and returns a canceller; tests pass a fake.
  schedule?: (fn: () => void, ms: number) => () => void;
  // Under freeze=1 only the catch-up is sent (C33).
  freeze?: boolean;
  generate?: typeof mockEvents;
}

const realSchedule = (fn: () => void, ms: number) => {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
};

export class MockSource implements Source {
  readonly name = "mock";
  private readonly options: MockSourceOptions;
  private events: (events: unknown[]) => void = () => {};
  private statusCb: (status: SourceStatus, detail?: string) => void = () => {};
  // Bumped by stop(); every delivery checks it, so a late timer sends nothing (C34).
  private generation = 0;
  private running = false;
  private cancel: (() => void) | null = null;
  private last = CATCHUP_MS;

  constructor(options: MockSourceOptions) {
    this.options = options;
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
    this.statusCb("catching_up");
    const all = generate(seed, scenario, 0, CATCHUP_MS);
    for (let i = 0; i < all.length; i += MAX_BATCH) {
      if (generation !== this.generation) return;
      this.events(all.slice(i, i + MAX_BATCH));
    }
    if (generation !== this.generation) return;
    this.statusCb("live");
    if (!freeze)
      this.cancel = (this.options.schedule ?? realSchedule)(() => this.tick(generation), TICK_MS);
  }

  private tick(generation: number): void {
    if (generation !== this.generation) return;
    const now = this.options.now();
    if (now <= this.last) return;
    const { seed, scenario } = this.options;
    const batch = (this.options.generate ?? mockEvents)(seed, scenario, this.last, now);
    this.last = now;
    for (let i = 0; i < batch.length; i += MAX_BATCH) {
      if (generation !== this.generation) return;
      this.events(batch.slice(i, i + MAX_BATCH));
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.generation++;
    this.cancel?.();
    this.cancel = null;
    this.statusCb("closed");
  }
}

// The app's mock: the sim clock starts at the end of the catch-up and runs in real time.
export function createMockSource(options: {
  seed: number;
  scenario: string;
  freeze: boolean;
}): MockSource {
  const t0 = performance.now();
  return new MockSource({ ...options, now: () => CATCHUP_MS + (performance.now() - t0) });
}
