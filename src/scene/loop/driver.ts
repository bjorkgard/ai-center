type Listenable = {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
};

// The scheduler and the event targets, injectable so tests drive a fake clock (C16).
export interface DriverEnv {
  raf(cb: (t: number) => void): number;
  caf(id: number): void;
  now(): number;
  doc: Listenable & { hidden: boolean };
  win: Listenable;
}

export function browserDriverEnv(): DriverEnv {
  return {
    raf: (cb) => window.requestAnimationFrame(cb),
    caf: (id) => window.cancelAnimationFrame(id),
    now: () => performance.now(),
    doc: document,
    win: window,
  };
}

export type DriverMode = "active" | "calm" | "hidden" | "frozen";

export interface DriverState {
  capFps: number;
  mode: DriverMode;
}

export interface DriverOptions {
  // Called with scene time in seconds and the real interval since the last render in ms.
  render(sceneSeconds: number, intervalMs: number): void;
  // Runs before each render with the time and the interval since the last render, in ms.
  // True means the camera is moving, damping included: that counts as input, so calm mode
  // waits and a frozen frame draws again (CEO S-RW16, S-RW21).
  update?(nowMs: number, intervalMs: number): boolean;
  onFatal(message: string): void;
  calm?: boolean;
  freeze?: boolean;
  env?: DriverEnv;
  // Monitor feed: delivered interval and the cap interval in force, both in ms.
  onFrame?(intervalMs: number, capIntervalMs: number): void;
  onPause?(paused: boolean): void;
  onDiscontinuity?(): void;
}

export const ACTIVE_FPS = 60;
export const CALM_FPS = 30;
export const CALM_AFTER_MS = 5000;
export const PACING_TOLERANCE_MS = 2; // [estimated]
export const MAX_SCENE_STEP_S = 0.1;
export const FATAL_AFTER = 3;

export interface RenderDriver {
  start(): () => void;
  invalidateFrozen(): void;
  notifyInput(): void;
  notifyCameraMotion(): void;
  readonly state: DriverState;
  readonly errorCount: number;
}

export function createRenderDriver(options: DriverOptions): RenderDriver {
  const env = options.env ?? browserDriverEnv();
  const calmEnabled = options.calm ?? true;
  const freeze = options.freeze ?? false;
  const state: DriverState = { capFps: ACTIVE_FPS, mode: "active" };
  const logged = new Set<string>();

  let rafId = 0;
  let running = false;
  let lastTick = 0;
  let lastRender = 0;
  let lastActivity = 0;
  let acc = 0;
  let sceneSeconds = 0;
  let hasRendered = false;
  let frozenPending = true;
  let paused = false;
  let errorCount = 0;
  let consecutiveErrors = 0;
  let stopFn: (() => void) | null = null;

  const setPaused = (value: boolean) => {
    if (value === paused) return;
    paused = value;
    options.onPause?.(value);
  };

  const discontinuity = () => {
    const now = env.now();
    lastTick = now;
    lastRender = now;
    acc = 0;
    options.onDiscontinuity?.();
  };

  const renderFrame = (now: number, capMs: number) => {
    const interval = hasRendered ? now - lastRender : 0;
    if (hasRendered && !freeze) {
      sceneSeconds += Math.min(interval / 1000, MAX_SCENE_STEP_S);
    }
    lastRender = now;
    try {
      if (options.update?.(now, interval)) {
        lastActivity = now;
        frozenPending = true;
      }
      options.render(sceneSeconds, interval);
      consecutiveErrors = 0;
    } catch (err) {
      errorCount++;
      consecutiveErrors++;
      if (freeze) frozenPending = true;
      const message = err instanceof Error ? err.message : String(err);
      if (!logged.has(message)) {
        logged.add(message);
        console.error(`[scene] frame error at ${now.toFixed(1)} ms: ${message}`);
      }
      if (consecutiveErrors >= FATAL_AFTER) {
        stopFn?.();
        options.onFatal(message);
        return;
      }
    }
    if (hasRendered && !freeze) options.onFrame?.(interval, capMs);
    hasRendered = true;
  };

  const tick = () => {
    rafId = env.raf(tick);
    const now = env.now();
    const dt = now - lastTick;
    lastTick = now;

    if (env.doc.hidden) {
      state.mode = "hidden";
      setPaused(true);
      return;
    }
    if (freeze) {
      state.mode = "frozen";
      setPaused(true);
      if (frozenPending) {
        frozenPending = false;
        renderFrame(now, 1000 / ACTIVE_FPS);
      }
      return;
    }

    const calm = calmEnabled && now - lastActivity >= CALM_AFTER_MS;
    const fps = calm ? CALM_FPS : ACTIVE_FPS;
    const capMs = 1000 / fps;
    state.capFps = fps;
    state.mode = calm ? "calm" : "active";
    setPaused(false);

    // Deadline accumulation: carry the remainder so 75/90/144 Hz average the cap.
    acc += dt;
    if (acc < capMs - PACING_TOLERANCE_MS) return;
    acc -= capMs;
    if (acc > capMs) acc = 0;
    renderFrame(now, capMs);
  };

  const onVisibility = () => {
    if (!env.doc.hidden) discontinuity();
  };
  const onResize = () => discontinuity();
  const markActivity = () => {
    lastActivity = env.now();
  };

  return {
    start() {
      if (stopFn) return stopFn;
      running = true;
      const now = env.now();
      lastTick = now;
      lastRender = now;
      lastActivity = now;
      acc = 0;
      sceneSeconds = 0;
      hasRendered = false;
      frozenPending = true;
      consecutiveErrors = 0;
      env.doc.addEventListener("visibilitychange", onVisibility);
      env.win.addEventListener("resize", onResize);
      rafId = env.raf(tick);
      const stop = () => {
        if (!running) return;
        running = false;
        env.caf(rafId);
        env.doc.removeEventListener("visibilitychange", onVisibility);
        env.win.removeEventListener("resize", onResize);
        stopFn = null;
      };
      stopFn = stop;
      return stop;
    },
    invalidateFrozen() {
      frozenPending = true;
    },
    notifyInput: markActivity,
    notifyCameraMotion: markActivity,
    state,
    get errorCount() {
      return errorCount;
    },
  };
}
