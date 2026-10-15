// The sim clock (CEO C47, E40, E41, E43). `now()` is source time in epoch ms, the time base of
// event `ts`, so every source and the derived metrics share one base. Node-runnable: the real
// clock is injected, nothing here reads a timer or the DOM.
export type Speed = 1 | 10 | 60;

export const SPEEDS: readonly Speed[] = [1, 10, 60];

export interface SimClock {
  now(): number;
  readonly speed: Speed;
  readonly paused: boolean;
  readonly locked: boolean;
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;
  // A hold stops now() like a pause, without being one: a hidden tab holds the clock and a user
  // pause stays in force when the tab returns (C50). Ignored by a clock that follows the wall.
  hold(on: boolean): void;
}

export interface SimClockOptions {
  // Monotonic real time in ms.
  realNow?: () => number;
  startMs: number;
  speed?: Speed;
  paused?: boolean;
  // A locked clock ignores play, pause and setSpeed, logging one line per call.
  locked?: boolean;
}

const isSpeed = (value: number): value is Speed => (SPEEDS as readonly number[]).includes(value);

export function createSimClock(options: SimClockOptions): SimClock {
  const realNow = options.realNow ?? (() => performance.now());
  const locked = options.locked ?? false;
  let speed: Speed = options.speed ?? 1;
  let paused = options.paused ?? false;
  let held = false;
  // Source time at the last rebase and the real time it happened.
  let base = options.startMs;
  let realBase = realNow();

  const now = () => (paused || held ? base : base + Math.max(0, realNow() - realBase) * speed);
  const rebase = () => {
    base = now();
    realBase = realNow();
  };
  const ignored = (call: string) => {
    console.warn(`[data] clock: locked, ${call} ignored`);
  };

  return {
    now,
    get speed() {
      return speed;
    },
    get paused() {
      return paused;
    },
    get locked() {
      return locked;
    },
    play() {
      if (locked) return ignored("play");
      if (!paused) return;
      // Paused, now() is already `base`: restart the real-time count from here.
      realBase = realNow();
      paused = false;
      console.info("[data] clock: playing");
    },
    pause() {
      if (locked) return ignored("pause");
      if (paused) return;
      rebase();
      paused = true;
      console.info("[data] clock: paused");
    },
    setSpeed(next) {
      if (locked) return ignored(`setSpeed(${next})`);
      if (!isSpeed(next)) {
        console.warn(`[data] clock: speed ${next} is not allowed (use 1, 10 or 60); unchanged`);
        return;
      }
      if (next === speed) return;
      rebase();
      console.info(`[data] clock: ${speed}x -> ${next}x`);
      speed = next;
    },
    hold(on) {
      if (on === held) return;
      rebase();
      held = on;
      realBase = realNow();
    },
  };
}

// The live source's clock: 1x, locked, the injected wall clock, never going back (C47).
export function createLiveClock(wallNow: () => number = () => Date.now()): SimClock {
  let latest = -Infinity;
  const ignored = (call: string) => {
    console.warn(`[data] clock: locked, ${call} ignored`);
  };
  return {
    now() {
      latest = Math.max(latest, wallNow());
      return latest;
    },
    speed: 1,
    paused: false,
    locked: true,
    play: () => ignored("play"),
    pause: () => ignored("pause"),
    setSpeed: (next) => ignored(`setSpeed(${next})`),
    hold: () => {},
  };
}
