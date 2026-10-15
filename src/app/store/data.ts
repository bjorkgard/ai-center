import type { StateCreator } from "zustand";
import { createLiveClock, type SimClock, type Speed } from "../../data/clock.ts";
import {
  advance,
  applyBatch,
  emptyData,
  validate,
  type ApplyOptions,
  type DataState,
} from "../../data/reduce.ts";
import type { AgentEvent, Source, SourceStatus } from "../../data/schema.ts";

export type SourceState = SourceStatus | "idle";

export interface SourceInfo {
  name: string | null;
  status: SourceState;
  detail?: string;
}

export type ApplyFn = (state: DataState, events: AgentEvent[], options?: ApplyOptions) => DataState;

// The inference tick (eng review A3): real ms between calls of advanceTo(clock.now()).
const ADVANCE_EVERY_MS = 1000;

// The store's view of the source clock (CEO C48). `speed`, `paused` and `locked` are only ever
// read back from the clock's getters, so they cannot drift from it.
export interface ClockInfo {
  clock: SimClock | null;
  speed: Speed;
  paused: boolean;
  locked: boolean;
  // Counts every connect and disconnect; scene halls are torn down when it changes (UC1).
  sourceEpoch: number;
}

export interface DataActions {
  // Stops any previous source, clears the slice, then starts this one (eng E30).
  connect(source: Source): void;
  disconnect(): void;
  // Drive the source clock (G18); no-ops while there is none or it is locked.
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;
  // Validates, applies and commits one batch with a single set(). `apply` is the test seam
  // for a reducer that throws.
  // `deliveredThrough` is the source's watermark (see Source.onEvents).
  ingest(source: string, raw: unknown[], apply?: ApplyFn, deliveredThrough?: number): void;
  // Moves the derived state (session ends, inlet lag, buckets, eviction) to source time
  // `nowMs`; a no-op while the clock is paused, when `nowMs` is not later than the last call
  // and while the source catches up; commits only when something changed (CEO C77, E51).
  advanceTo(nowMs: number): void;
}

export type DataSlice = DataState & { source: SourceInfo } & ClockInfo & DataActions;

const IDLE: SourceInfo = { name: null, status: "idle" };

const NO_CLOCK = { clock: null, speed: 1, paused: false, locked: true } as const;

const mirror = (clock: SimClock): Pick<ClockInfo, "clock" | "speed" | "paused" | "locked"> => ({
  clock,
  speed: clock.speed,
  paused: clock.paused,
  locked: clock.locked,
});

export function initialData(): DataState & { source: SourceInfo } & ClockInfo {
  return { ...emptyData(), source: IDLE, ...NO_CLOCK, sourceEpoch: 0 };
}

// One warning per source and issue path per minute; the clock is injectable (eng review).
const WARN_EVERY_MS = 60_000;
type Clock = () => number;
let clock: Clock = () => performance.now();
let lastWarn = new Map<string, number>();

// Test helper: swap the limiter's clock and reset it.
export function setWarnClock(next: Clock = () => performance.now()): void {
  clock = next;
  lastWarn = new Map();
}

// The one live connection; callbacks of an older one are ignored.
let active: { source: Source; token: number } | null = null;
let tokens = 0;
// The source time of the last advance, null until the first of a connection, and the interval
// that makes the next ones.
let lastAdvance: number | null = null;
// The greatest `deliveredThrough` the source has reported, null while it has reported none.
let watermark: number | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

function detach(): void {
  const previous = active;
  active = null;
  tokens++;
  lastAdvance = null;
  watermark = null;
  if (ticker !== null) clearInterval(ticker);
  ticker = null;
  previous?.source.stop();
}

export const createDataSlice: StateCreator<DataSlice, [], [], DataSlice> = (set, get) => {
  const setStatus = (name: string, status: SourceStatus, detail?: string) => {
    const current = get().source;
    // A failed batch leaves the status at error until the next connect() (eng E33).
    if (current.status === "error" || current.status === status) return;
    console.info(`[data] ${name}: ${current.status} -> ${status}`);
    set({ source: { name, status, detail } });
  };

  // Where derived values may advance to: the clock, held back to what the source has delivered.
  const target = (clock: SimClock) =>
    watermark === null ? clock.now() : Math.min(clock.now(), watermark);

  // Runs a clock action and commits the mirror only when something in it changed.
  const act = (run: (clock: SimClock) => void) => {
    const { clock, speed, paused, locked } = get();
    if (!clock) return;
    run(clock);
    if (clock.speed !== speed || clock.paused !== paused || clock.locked !== locked)
      set(mirror(clock));
  };

  return {
    ...initialData(),
    connect: (source) => {
      detach();
      setWarnClock(clock);
      set({
        ...emptyData(),
        source: { name: source.name, status: "idle" },
        ...mirror(source.clock ?? createLiveClock()),
        sourceEpoch: get().sourceEpoch + 1,
      });
      const token = tokens;
      active = { source, token };
      source.onEvents((raw, through) => {
        if (token === tokens) get().ingest(source.name, raw, undefined, through);
      });
      source.onStatus((status, detail) => {
        if (token === tokens) setStatus(source.name, status, detail);
      });
      ticker = setInterval(() => {
        const current = get().clock;
        if (current) get().advanceTo(target(current));
      }, ADVANCE_EVERY_MS);
      source.start();
    },
    disconnect: () => {
      detach();
      set({ ...emptyData(), source: IDLE, ...NO_CLOCK, sourceEpoch: get().sourceEpoch + 1 });
    },
    play: () => act((clock) => clock.play()),
    pause: () => act((clock) => clock.pause()),
    setSpeed: (speed) => act((clock) => clock.setSpeed(speed)),
    advanceTo: (nowMs) => {
      const state = get();
      if (!state.clock || state.clock.paused) return;
      if (state.source.status === "catching_up") return;
      if (lastAdvance !== null && nowMs <= lastAdvance) return;
      lastAdvance = nowMs;
      const next = advance(state, nowMs);
      if (next !== state) set(next);
    },
    ingest: (name, raw, apply = applyBatch, deliveredThrough) => {
      if (deliveredThrough !== undefined)
        watermark = Math.max(watermark ?? -Infinity, deliveredThrough);
      if (raw.length === 0) {
        // A watermark alone can free time to advance to.
        const { clock } = get();
        if (deliveredThrough !== undefined && clock) get().advanceTo(target(clock));
        return;
      }
      const start = performance.now();
      const state = get();
      const { events, rejects } = validate(raw);
      const now = state.clock?.now();
      let next: DataState;
      try {
        next = apply(state, events, { now, mark: lastAdvance ?? undefined });
      } catch (error) {
        const detail = `batch of ${raw.length} failed at event ${events[0]?.id ?? "-"}`;
        console.error(
          `[data] ${name}: ${detail}: ${error instanceof Error ? error.name : "Error"}`,
        );
        const failed = { ...state.dataHealth, failedBatches: state.dataHealth.failedBatches + 1 };
        if (state.source.status === "error") {
          set({ dataHealth: failed });
        } else {
          console.info(`[data] ${name}: ${state.source.status} -> error`);
          set({ dataHealth: failed, source: { name, status: "error", detail } });
        }
        return;
      }
      const invalid = { ...next.dataHealth.invalid };
      for (const r of rejects) {
        const key = `${name}:${r.path}`;
        invalid[key] = (invalid[key] ?? 0) + 1;
        const at = clock();
        const prev = lastWarn.get(key);
        if (prev === undefined || at - prev >= WARN_EVERY_MS) {
          lastWarn.set(key, at);
          console.warn(
            `[data] ${name}: dropped event ${r.id ?? "(no id)"}: invalid at "${r.path}" (${r.code})`,
          );
        }
      }
      next = {
        ...next,
        dataHealth: {
          ...next.dataHealth,
          invalid,
          batches: next.dataHealth.batches + 1,
          lastBatchSize: raw.length,
          lastApplyMs: performance.now() - start,
        },
      };
      // The batch and the advance it calls for commit together (CEO C77).
      const to = state.clock ? target(state.clock) : undefined;
      if (
        state.clock &&
        !state.clock.paused &&
        state.source.status !== "catching_up" &&
        to !== undefined &&
        (lastAdvance === null || to > lastAdvance)
      ) {
        lastAdvance = to;
        next = advance(next, to);
      }
      set(next);
    },
  };
};
