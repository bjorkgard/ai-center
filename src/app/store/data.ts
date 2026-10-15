import type { StateCreator } from "zustand";
import { applyBatch, emptyData, validate, type DataState } from "../../data/reduce.ts";
import type { AgentEvent, Source, SourceStatus } from "../../data/schema.ts";

export type SourceState = SourceStatus | "idle";

export interface SourceInfo {
  name: string | null;
  status: SourceState;
  detail?: string;
}

export type ApplyFn = (state: DataState, events: AgentEvent[]) => DataState;

export interface DataActions {
  // Stops any previous source, clears the slice, then starts this one (eng E30).
  connect(source: Source): void;
  disconnect(): void;
  // Validates, applies and commits one batch with a single set(). `apply` is the test seam
  // for a reducer that throws.
  ingest(source: string, raw: unknown[], apply?: ApplyFn): void;
}

export type DataSlice = DataState & { source: SourceInfo } & DataActions;

const IDLE: SourceInfo = { name: null, status: "idle" };

export function initialData(): DataState & { source: SourceInfo } {
  return { ...emptyData(), source: IDLE };
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

function detach(): void {
  const previous = active;
  active = null;
  tokens++;
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

  return {
    ...initialData(),
    connect: (source) => {
      detach();
      setWarnClock(clock);
      set({ ...emptyData(), source: { name: source.name, status: "idle" } });
      const token = tokens;
      active = { source, token };
      source.onEvents((raw) => {
        if (token === tokens) get().ingest(source.name, raw);
      });
      source.onStatus((status, detail) => {
        if (token === tokens) setStatus(source.name, status, detail);
      });
      source.start();
    },
    disconnect: () => {
      detach();
      set({ ...emptyData(), source: IDLE });
    },
    ingest: (name, raw, apply = applyBatch) => {
      if (raw.length === 0) return;
      const start = performance.now();
      const state = get();
      const { events, rejects } = validate(raw);
      let next: DataState;
      try {
        next = apply(state, events);
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
      set({
        ...next,
        dataHealth: {
          ...next.dataHealth,
          invalid,
          batches: next.dataHealth.batches + 1,
          lastBatchSize: raw.length,
          lastApplyMs: performance.now() - start,
        },
      });
    },
  };
};
