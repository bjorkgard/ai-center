import { useStore } from "../../app/store/index.ts";

export const WINDOW_MS = 500;
export const DEGRADE_RATIO = 1.33; // [estimated]
export const DEGRADE_AFTER_MS = 2000;
export const RECOVER_RATIO = 1.08; // [estimated]
export const RECOVER_AFTER_MS = 10_000;
export const SKIP_FRAMES = 5;
const MIN_WINDOW_MS = WINDOW_MS / 2;
const RING = 256;

let simulated: number | null = null;

// Test and e2e hook: replaces the real delivered intervals while non-null (S-RW34).
export function simulateFrameInterval(ms: number | null): void {
  simulated = ms;
}

export interface FrameMonitorOptions {
  log?: (line: string) => void;
}

export interface FrameMonitor {
  feed(intervalMs: number, capIntervalMs: number): void;
  discontinuity(): void;
  setPaused(paused: boolean): void;
  stop(): void;
}

export function createFrameMonitor(options: FrameMonitorOptions = {}): FrameMonitor {
  const log = options.log ?? ((line: string) => console.info(line));
  // Typed ring buffers; nothing is allocated per frame.
  const real = new Float64Array(RING);
  const value = new Float64Array(RING);
  const cap = new Float64Array(RING);
  let head = 0;
  let count = 0;
  let sumReal = 0;
  let sumValue = 0;
  let sumCap = 0;
  let skip = SKIP_FRAMES;
  let paused = false;
  let stopped = false;
  let degraded = false;
  let streakMs = 0;

  const clearWindow = () => {
    head = 0;
    count = 0;
    sumReal = 0;
    sumValue = 0;
    sumCap = 0;
    streakMs = 0;
  };

  const changeTier = (from: "high" | "medium", to: "high" | "medium", line: string) => {
    const store = useStore.getState();
    if (store.quality !== from) return;
    store.setQuality(to);
    log(line);
  };

  return {
    feed(intervalMs, capIntervalMs) {
      if (stopped || paused) return;
      if (skip > 0) {
        skip--;
        return;
      }
      const v = simulated ?? intervalMs;
      if (count === RING) {
        const tail = (head + RING - count) % RING;
        sumReal -= real[tail];
        sumValue -= value[tail];
        sumCap -= cap[tail];
        count--;
      }
      real[head] = intervalMs;
      value[head] = v;
      cap[head] = capIntervalMs;
      head = (head + 1) % RING;
      count++;
      sumReal += intervalMs;
      sumValue += v;
      sumCap += capIntervalMs;
      while (count > 1 && sumReal > WINDOW_MS) {
        const tail = (head + RING - count) % RING;
        sumReal -= real[tail];
        sumValue -= value[tail];
        sumCap -= cap[tail];
        count--;
      }
      if (sumReal < MIN_WINDOW_MS) return;

      const ratio = sumValue / sumCap;
      if (!degraded) {
        streakMs = ratio > DEGRADE_RATIO ? streakMs + intervalMs : 0;
        if (streakMs >= DEGRADE_AFTER_MS) {
          const mean = sumValue / count;
          degraded = true;
          changeTier(
            "high",
            "medium",
            `[scene] quality normal -> degraded (mean ${mean.toFixed(1)} ms over 2 s)`,
          );
          clearWindow();
        }
      } else {
        streakMs = ratio < RECOVER_RATIO ? streakMs + intervalMs : 0;
        if (streakMs >= RECOVER_AFTER_MS) {
          const mean = sumValue / count;
          degraded = false;
          changeTier(
            "medium",
            "high",
            `[scene] quality degraded -> normal (mean ${mean.toFixed(1)} ms over 10 s)`,
          );
          clearWindow();
        }
      }
    },
    discontinuity() {
      skip = SKIP_FRAMES;
      clearWindow();
    },
    setPaused(value) {
      if (value === paused) return;
      paused = value;
      if (!value) {
        skip = SKIP_FRAMES;
        clearWindow();
      }
    },
    stop() {
      stopped = true;
    },
  };
}
