import type { Load } from "./scene.ts";
import type { SpikeViewName } from "./params.ts";
import { summarize, type Summary } from "./stats.ts";

export interface ViewSnapshot {
  halls: number;
  geometries: number;
  textures: number;
  programs: number;
  drawCalls: number;
  rackInstances: number;
  ledInstances: number;
  storeListeners: number;
  sharedMaterialDisposeEvents: number;
}

// The seam both views implement (PLAN eng record, section 1).
export interface SpikeView {
  frame(t: number): void;
  addHalls(n: number): Promise<void>;
  removeHalls(n: number): Promise<void>;
  snapshot(): ViewSnapshot;
}

// What the page needs on top of the seam: the canvas, for events and the GPU timer.
export interface SpikeViewHandle extends SpikeView {
  canvas: HTMLCanvasElement;
}

export type InterruptReason = "visibility" | "resize" | "contextlost";
export type InvalidReason =
  | InterruptReason
  | "churn-error"
  | "frame-error"
  | "webgl-unavailable"
  | "composer-init"
  | "coarse-timer";

export type BenchState = "idle" | "warmup" | "steady" | "churn" | "settle" | "done" | "invalid";
export type BenchEvent = "start" | "elapsed" | "churnDone" | "invalidate";

// Bench state machine as a transition table: one row per guard, one test per row.
export const TRANSITIONS: Record<BenchState, Partial<Record<BenchEvent, BenchState>>> = {
  idle: { start: "warmup", invalidate: "invalid" },
  warmup: { elapsed: "steady", invalidate: "invalid" },
  steady: { elapsed: "churn", invalidate: "invalid" },
  churn: { churnDone: "settle", invalidate: "invalid" },
  settle: { elapsed: "done", invalidate: "invalid" },
  done: {},
  invalid: {},
};

export function transition(state: BenchState, event: BenchEvent): BenchState | null {
  return TRANSITIONS[state][event] ?? null;
}

// Churn and bloom controls are locked for the whole pass (C12).
export function controlsDisabled(state: BenchState): boolean {
  return state === "warmup" || state === "steady" || state === "churn" || state === "settle";
}

export const COARSE_TIMER_MS = 0.1;

// A run that is not cross-origin isolated is refused whatever the step reads (E6).
export function isCoarseTimer(stepMs: number, crossOriginIsolated: boolean): boolean {
  return !crossOriginIsolated || stepMs > COARSE_TIMER_MS + 1e-9;
}

// Median gap between successive different readings of the clock: its real step.
export function measureTimerStep(now: () => number, changes = 50): number {
  const diffs: number[] = [];
  let last = now();
  while (diffs.length < changes) {
    const v = now();
    if (v !== last) {
      diffs.push(v - last);
      last = v;
    }
  }
  diffs.sort((a, b) => a - b);
  return diffs[diffs.length >> 1];
}

export interface RenderInfoLike {
  autoReset: boolean;
  render: { calls: number };
  reset(): void;
}

// With a composer, three resets renderer.info on every render() call, so one read
// sees only the last pass. autoReset off plus one reset per frame counts them all (E10).
export class DrawCallCounter {
  calls = 0;
  private info: RenderInfoLike;
  constructor(info: RenderInfoLike) {
    this.info = info;
    info.autoReset = false;
  }
  begin(): void {
    this.info.reset();
  }
  end(): void {
    this.calls = this.info.render.calls;
  }
}

export interface GpuTimer {
  begin(): void;
  end(): void;
  poll(onSample: (ms: number) => void, onDisjoint: () => void): void;
}

// Null when EXT_disjoint_timer_query_webgl2 is missing: the GPU column reads null, never 0.
export function createGpuTimer(gl: WebGL2RenderingContext): GpuTimer | null {
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null;
  if (!ext) return null;
  const RING = 8;
  const queries: WebGLQuery[] = [];
  const inFlight: boolean[] = [];
  for (let i = 0; i < RING; i++) {
    queries.push(gl.createQuery());
    inFlight.push(false);
  }
  let head = 0;
  let active = false;
  return {
    begin() {
      if (inFlight[head]) return;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, queries[head]);
      active = true;
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      inFlight[head] = true;
      head = (head + 1) % RING;
      active = false;
    },
    poll(onSample, onDisjoint) {
      for (let i = 0; i < RING; i++) {
        if (!inFlight[i] || !gl.getQueryParameter(queries[i], gl.QUERY_RESULT_AVAILABLE)) continue;
        inFlight[i] = false;
        if (gl.getParameter(ext.GPU_DISJOINT_EXT)) onDisjoint();
        else onSample(Number(gl.getQueryParameter(queries[i], gl.QUERY_RESULT)) / 1e6);
      }
    },
  };
}

export interface BenchEnv {
  now(): number;
  epochMs(): number;
  raf(cb: (t: number) => void): number;
  cancelRaf(id: number): void;
  listen(handler: (reason: InterruptReason, message: string) => void): () => void;
  timerStep(): number;
  crossOriginIsolated: boolean;
  heapBytes(): number | null;
}

type Listenable = Pick<EventTarget, "addEventListener" | "removeEventListener">;

// The globals browserEnv reads, injectable so tests can pass plain fakes.
export interface BrowserGlobals {
  window: Listenable &
    Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame"> & {
      crossOriginIsolated?: boolean;
    };
  document: Listenable & { hidden: boolean };
  performance: { now(): number; memory?: { usedJSHeapSize: number } };
}

export function browserEnv(
  canvas: Listenable,
  globals: BrowserGlobals = { window, document, performance },
): BenchEnv {
  const { window: win, document: doc, performance: perf } = globals;
  return {
    now: () => perf.now(),
    epochMs: () => Date.now(),
    raf: (cb) => win.requestAnimationFrame(cb),
    cancelRaf: (id) => win.cancelAnimationFrame(id),
    listen(handler) {
      const onVisibility = () => {
        if (doc.hidden) handler("visibility", "tab hidden");
      };
      const onBlur = () => handler("visibility", "window blurred");
      const onResize = () => handler("resize", "window resized");
      const onLost = () => handler("contextlost", "webglcontextlost");
      doc.addEventListener("visibilitychange", onVisibility);
      win.addEventListener("blur", onBlur);
      win.addEventListener("resize", onResize);
      canvas.addEventListener("webglcontextlost", onLost);
      return () => {
        doc.removeEventListener("visibilitychange", onVisibility);
        win.removeEventListener("blur", onBlur);
        win.removeEventListener("resize", onResize);
        canvas.removeEventListener("webglcontextlost", onLost);
      };
    },
    timerStep: () => measureTimerStep(() => perf.now()),
    crossOriginIsolated: win.crossOriginIsolated === true,
    heapBytes: () => perf.memory?.usedJSHeapSize ?? null,
  };
}

export function detectBrowser(ua: string): { name: string; version: string } {
  const firefox = /Firefox\/([\d.]+)/.exec(ua);
  if (firefox) return { name: "firefox", version: firefox[1] };
  const edge = /Edg\/([\d.]+)/.exec(ua);
  if (edge) return { name: "edge", version: edge[1] };
  const chrome = /Chrome\/([\d.]+)/.exec(ua);
  if (chrome) return { name: "chrome", version: chrome[1] };
  const safari = /Version\/([\d.]+).*Safari\//.exec(ua);
  if (safari) return { name: "safari", version: safari[1] };
  return { name: "unknown", version: "unknown" };
}

export interface BenchMeta {
  view: SpikeViewName;
  load: Load;
  bloom: 0 | 1;
  pass: 1 | 2 | 3;
  browser: { name: string; version: string };
  devicePixelRatio: number;
  canvas: { width: number; height: number };
  gpuRenderer: string | null;
  versions: { three: string; r3f: string; app: string };
}

export interface Baseline {
  geometries: boolean;
  textures: boolean;
  programs: boolean;
  storeListeners: boolean;
  sharedMaterialDisposeEvents: boolean;
  all: boolean;
}

export interface BenchResult extends BenchMeta {
  valid: boolean;
  reason: InvalidReason | null;
  message: string | null;
  invalidAtSec: number | null;
  startedAt: string;
  timer: { crossOriginIsolated: boolean; stepMs: number | null };
  stats: {
    steady: {
      cpu: Summary | null;
      interval: Summary | null;
      refreshIntervalMs: number | null;
      fps: number | null;
      gpu: Summary | null;
      gpuDisjointDropped: number | null;
    };
    churn: { cpu: Summary | null; longestIntervalMs: number | null; cycles: number };
  };
  counts: { before: ViewSnapshot | null; after: ViewSnapshot | null };
  baseline: Baseline | null;
  heap: { beforeChurn: number | null; afterSettle: number | null };
  samplesDropped: number;
}

export function compareBaseline(before: ViewSnapshot, after: ViewSnapshot): Baseline {
  const checks = {
    geometries: after.geometries === before.geometries,
    textures: after.textures === before.textures,
    programs: after.programs === before.programs,
    storeListeners: after.storeListeners === before.storeListeners,
    sharedMaterialDisposeEvents: after.sharedMaterialDisposeEvents === 0,
  };
  return { ...checks, all: Object.values(checks).every(Boolean) };
}

export interface BenchStatus {
  state: BenchState;
  text: string;
}

export interface BenchDurations {
  warmupMs: number;
  steadyMs: number;
  settleMs: number;
  churnCycles: number;
  churnHalls: number;
  churnStepTimeoutMs: number;
}

export const BENCH_DURATIONS: BenchDurations = {
  warmupMs: 5000,
  steadyMs: 20000,
  settleMs: 1000,
  churnCycles: 50,
  churnHalls: 6,
  churnStepTimeoutMs: 10000,
};

// 120 Hz for steady plus churn with headroom; typed arrays so the bench itself
// allocates nothing per frame (eng P-E1).
const SAMPLE_CAPACITY = 16384;

export interface BenchOptions {
  env: BenchEnv;
  view: SpikeView;
  meta: BenchMeta;
  gpuTimer?: GpuTimer | null;
  durations?: Partial<BenchDurations>;
  sampleCapacity?: number;
  onStatus?: (status: BenchStatus) => void;
}

export function bannerText(result: BenchResult): string {
  const at = (result.invalidAtSec ?? 0).toFixed(1);
  const base = `Pass invalid: ${result.reason} at ${at} s`;
  return result.message && (result.reason === "churn-error" || result.reason === "frame-error")
    ? `${base}: ${result.message}`
    : base;
}

export function initFailureText(reason: "webgl-unavailable" | "composer-init", message: string) {
  return reason === "webgl-unavailable"
    ? `WebGL2 unavailable: ${message}`
    : `Bloom composer failed to start: ${message}`;
}

export function resultFileName(result: BenchResult): string {
  return `${result.browser.name}-${result.view}-load${result.load}-bloom${result.bloom}-pass${result.pass}.json`;
}

export interface PublishSinks {
  setGlobal(result: BenchResult): void;
  log(json: string): void;
  warn(message: string): void;
  download(fileName: string, json: string): void;
}

// The JSON always reaches the console and window.__benchResult; a blocked
// download only costs the file (C12 "result output").
export function publishResult(result: BenchResult, sinks: PublishSinks): boolean {
  const json = JSON.stringify(result);
  sinks.setGlobal(result);
  sinks.log(json);
  try {
    sinks.download(resultFileName(result), json);
    return true;
  } catch (err) {
    sinks.warn(
      `download blocked (${err instanceof Error ? err.message : String(err)}); result stays in the console and window.__benchResult`,
    );
    return false;
  }
}

export class BenchRunner {
  state: BenchState = "idle";

  private env: BenchEnv;
  private view: SpikeView;
  private meta: BenchMeta;
  private gpu: GpuTimer | null;
  private d: BenchDurations;
  private capacity: number;
  private onStatus: ((status: BenchStatus) => void) | undefined;

  private steadyCpu: Float64Array;
  private steadyInterval: Float64Array;
  private steadyN = 0;
  private churnCpu: Float64Array;
  private churnN = 0;
  private gpuSamples: Float64Array;
  private gpuN = 0;
  private gpuDropped = 0;
  private samplesDropped = 0;
  private churnLongest = -1;
  private churnCycles = 0;

  private startNow = 0;
  private startEpoch = 0;
  private timerStep: number | null = null;
  private invalid: { reason: InvalidReason; message: string; atSec: number } | null = null;
  private before: ViewSnapshot | null = null;
  private after: ViewSnapshot | null = null;
  private heapBefore: number | null = null;
  private heapAfter: number | null = null;

  private prevT = -1;
  private phaseStart = -1;
  private stepStart = 0;
  private rafId = 0;
  private unlisten: (() => void) | null = null;
  private waiter: (() => void) | null = null;
  private abort!: (err: Error) => void;
  private aborted: Promise<never>;
  private resolveResult!: (r: BenchResult) => void;
  private result: Promise<BenchResult>;

  constructor(opts: BenchOptions) {
    this.env = opts.env;
    this.view = opts.view;
    this.meta = opts.meta;
    this.gpu = opts.gpuTimer ?? null;
    this.d = { ...BENCH_DURATIONS, ...opts.durations };
    this.capacity = opts.sampleCapacity ?? SAMPLE_CAPACITY;
    this.onStatus = opts.onStatus;
    this.steadyCpu = new Float64Array(this.capacity);
    this.steadyInterval = new Float64Array(this.capacity);
    this.churnCpu = new Float64Array(this.capacity);
    this.gpuSamples = new Float64Array(this.capacity);
    this.startNow = this.env.now();
    this.startEpoch = this.env.epochMs();
    this.aborted = new Promise<never>((_, reject) => {
      this.abort = reject;
    });
    this.aborted.catch(() => {});
    this.result = new Promise<BenchResult>((resolve) => {
      this.resolveResult = resolve;
    });
  }

  start(): Promise<BenchResult> {
    if (this.state !== "idle") return this.result;
    this.startNow = this.env.now();
    this.startEpoch = this.env.epochMs();
    this.timerStep = this.env.timerStep();
    if (isCoarseTimer(this.timerStep, this.env.crossOriginIsolated)) {
      this.invalidate(
        "coarse-timer",
        this.env.crossOriginIsolated
          ? `performance.now() steps ${this.timerStep} ms, coarser than ${COARSE_TIMER_MS} ms`
          : `page is not cross-origin isolated (performance.now() steps ${this.timerStep} ms)`,
      );
      return this.result;
    }
    this.go("start", -1);
    this.unlisten = this.env.listen((reason, message) => this.invalidate(reason, message));
    this.rafId = this.env.raf(this.onFrame);
    return this.result;
  }

  // Init failures (before start) and interruptions (during a pass) both end here.
  invalidate(reason: InvalidReason, message: string): void {
    const next = transition(this.state, "invalidate");
    if (next === null) return;
    this.state = next;
    this.invalid = { reason, message, atSec: (this.env.now() - this.startNow) / 1000 };
    this.teardown();
    this.abort(new Error(message));
    this.emitStatus();
    this.resolveResult(this.buildResult(false));
  }

  private go(event: BenchEvent, t: number): void {
    this.state = transition(this.state, event)!;
    this.phaseStart = t;
    this.emitStatus();
  }

  private emitStatus(): void {
    if (!this.onStatus) return;
    const text: Record<BenchState, string> = {
      idle: "Ready",
      warmup: "Warm-up",
      steady: "Steady",
      churn: "Churn",
      settle: "Settle",
      done: "Done",
      invalid: this.invalid ? bannerText(this.buildResult(false)) : "Invalid",
    };
    this.onStatus({ state: this.state, text: text[this.state] });
  }

  private teardown(): void {
    this.env.cancelRaf(this.rafId);
    this.unlisten?.();
    this.unlisten = null;
  }

  private onFrame = (t: number): void => {
    if (this.state === "done" || this.state === "invalid") return;
    const interval = this.prevT < 0 ? 0 : t - this.prevT;
    this.prevT = t;

    const cpuStart = this.env.now();
    try {
      this.gpu?.begin();
      this.view.frame(t);
      this.gpu?.end();
    } catch (err) {
      this.invalidate("frame-error", err instanceof Error ? err.message : String(err));
      return;
    }
    const cpu = this.env.now() - cpuStart;
    this.gpu?.poll(this.onGpuSample, this.onGpuDisjoint);

    switch (this.state) {
      case "warmup":
        if (this.phaseStart < 0) this.phaseStart = t;
        if (t - this.phaseStart >= this.d.warmupMs) this.go("elapsed", t);
        break;
      case "steady":
        if (this.steadyN < this.capacity) {
          this.steadyCpu[this.steadyN] = cpu;
          this.steadyInterval[this.steadyN++] = interval;
        } else this.samplesDropped++;
        if (t - this.phaseStart >= this.d.steadyMs) {
          this.before = this.view.snapshot();
          this.heapBefore = this.env.heapBytes();
          this.go("elapsed", t);
          this.stepStart = this.env.now();
          void this.runChurn();
        }
        break;
      case "churn":
        if (this.churnN < this.capacity) this.churnCpu[this.churnN++] = cpu;
        else this.samplesDropped++;
        if (interval > this.churnLongest) this.churnLongest = interval;
        if (this.waiter) {
          const resolve = this.waiter;
          this.waiter = null;
          resolve();
        }
        if (this.env.now() - this.stepStart > this.d.churnStepTimeoutMs) {
          this.invalidate("churn-error", "a churn step did not complete in time");
          return;
        }
        break;
      case "settle":
        if (t - this.phaseStart >= this.d.settleMs) {
          this.after = this.view.snapshot();
          this.heapAfter = this.env.heapBytes();
          this.go("elapsed", t);
          this.teardown();
          this.resolveResult(this.buildResult(true));
          return;
        }
        break;
    }
    this.rafId = this.env.raf(this.onFrame);
  };

  private onGpuSample = (ms: number): void => {
    if (this.state !== "steady") return;
    if (this.gpuN < this.capacity) this.gpuSamples[this.gpuN++] = ms;
    else this.samplesDropped++;
  };

  private onGpuDisjoint = (): void => {
    this.gpuDropped++;
  };

  private nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
  }

  private async step<T>(work: Promise<T>): Promise<T> {
    this.stepStart = this.env.now();
    return Promise.race([work, this.aborted]);
  }

  // addHalls resolves when the halls are in the scene, which under React can
  // take several frames; one frame is rendered with them before they go (E16).
  private async runChurn(): Promise<void> {
    try {
      for (let c = 0; c < this.d.churnCycles; c++) {
        await this.step(this.view.addHalls(this.d.churnHalls));
        await this.step(this.nextFrame());
        await this.step(this.view.removeHalls(this.d.churnHalls));
        this.churnCycles++;
      }
      if (this.state === "churn") this.go("churnDone", this.env.now());
    } catch (err) {
      this.invalidate("churn-error", err instanceof Error ? err.message : String(err));
    }
  }

  private buildResult(valid: boolean): BenchResult {
    const interval = summarize(this.steadyInterval, this.steadyN);
    const refresh = interval?.median ?? null;
    const timerStep = this.timerStep;
    return {
      ...this.meta,
      valid,
      reason: valid ? null : (this.invalid?.reason ?? null),
      message: valid ? null : (this.invalid?.message ?? null),
      invalidAtSec: valid ? null : (this.invalid?.atSec ?? null),
      startedAt: new Date(this.startEpoch).toISOString(),
      timer: { crossOriginIsolated: this.env.crossOriginIsolated, stepMs: timerStep },
      stats: {
        steady: {
          cpu: summarize(this.steadyCpu, this.steadyN),
          interval,
          refreshIntervalMs: refresh,
          fps: refresh ? 1000 / refresh : null,
          gpu: this.gpu ? summarize(this.gpuSamples, this.gpuN) : null,
          gpuDisjointDropped: this.gpu ? this.gpuDropped : null,
        },
        churn: {
          cpu: summarize(this.churnCpu, this.churnN),
          longestIntervalMs: this.churnLongest < 0 ? null : this.churnLongest,
          cycles: this.churnCycles,
        },
      },
      counts: { before: this.before, after: this.after },
      baseline:
        valid && this.before && this.after ? compareBaseline(this.before, this.after) : null,
      heap: { beforeChurn: this.heapBefore, afterSettle: this.heapAfter },
      samplesDropped: this.samplesDropped,
    };
  }
}
