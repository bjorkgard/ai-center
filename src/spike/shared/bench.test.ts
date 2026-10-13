import { expect, test, vi } from "vite-plus/test";
import {
  BenchRunner,
  DrawCallCounter,
  TRANSITIONS,
  bannerText,
  controlsDisabled,
  detectBrowser,
  initFailureText,
  isCoarseTimer,
  measureTimerStep,
  publishResult,
  resultFileName,
  transition,
  type BenchEnv,
  type BenchMeta,
  type BenchResult,
  type BenchState,
  type GpuTimer,
  type InterruptReason,
  type SpikeView,
  type ViewSnapshot,
} from "./bench.ts";

const meta: BenchMeta = {
  view: "spike-r3f",
  load: 4,
  bloom: 1,
  pass: 2,
  browser: { name: "chrome", version: "156.0" },
  devicePixelRatio: 2,
  canvas: { width: 2560, height: 1440 },
  gpuRenderer: null,
  versions: { three: "0.186.1", r3f: "9.8.1", app: "0.2.1" },
};

const durations = { warmupMs: 48, steadyMs: 160, settleMs: 32, churnCycles: 3 };

function makeHarness(init: { timerStep?: number; heap?: number | null } = {}) {
  let t = 0;
  let nowMs = 0;
  let callback: ((t: number) => void) | null = null;
  const handlers = new Set<(reason: InterruptReason, message: string) => void>();
  const env: BenchEnv = {
    now: () => nowMs,
    epochMs: () => 1_800_000_000_000 + nowMs,
    raf: (cb) => {
      callback = cb;
      return 1;
    },
    cancelRaf: () => {
      callback = null;
    },
    listen: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    timerStep: () => init.timerStep ?? 0.02,
    crossOriginIsolated: true,
    heapBytes: () => (init.heap === undefined ? 1_000_000 : init.heap),
  };
  return {
    env,
    get scheduled() {
      return callback !== null;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    step(dt: number) {
      t += dt;
      nowMs = t;
      const cb = callback;
      callback = null;
      cb?.(t);
    },
    emit(reason: InterruptReason, message: string) {
      for (const h of [...handlers]) h(reason, message);
    },
  };
}
type Harness = ReturnType<typeof makeHarness>;

function makeView(
  h: Harness,
  opts: {
    cpu?: number;
    addFrames?: number;
    failAdd?: boolean;
    disposeEvents?: number;
    leak?: number;
  } = {},
) {
  let halls = 12;
  let leaked = 0;
  let waiting = -1;
  let waitingFor = 0;
  let waitingResolve: (() => void) | null = null;
  let drawCalls = 0;
  const framesAt: number[] = [];
  const removeLog: number[] = [];
  const view: SpikeView = {
    frame() {
      framesAt.push(halls);
      drawCalls = halls * 3;
      h.advance(opts.cpu ?? 4);
      if (waiting >= 0 && ++waiting >= waitingFor) {
        halls += 6;
        waiting = -1;
        waitingResolve?.();
      }
    },
    addHalls(n) {
      if (opts.failAdd) return Promise.reject(new Error("boom"));
      if (!opts.addFrames) {
        halls += n;
        return Promise.resolve();
      }
      waiting = 0;
      waitingFor = opts.addFrames;
      return new Promise<void>((resolve) => {
        waitingResolve = resolve;
      });
    },
    removeHalls(n) {
      removeLog.push(framesAt.filter((x) => x === 18).length);
      halls -= n;
      leaked = opts.leak ?? 0;
      return Promise.resolve();
    },
    snapshot(): ViewSnapshot {
      return {
        halls,
        geometries: halls * 3 + leaked,
        textures: 0,
        programs: 4,
        drawCalls,
        rackInstances: halls * 64,
        ledInstances: halls * 1024,
        storeListeners: halls,
        sharedMaterialDisposeEvents: opts.disposeEvents ?? 0,
      };
    },
  };
  return { view, framesAt, removeLog };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

async function drive(
  h: Harness,
  runner: BenchRunner,
  dt: (frame: number, state: BenchState) => number = () => 16,
  max = 400,
): Promise<void> {
  for (let i = 0; i < max && runner.state !== "done" && runner.state !== "invalid"; i++) {
    h.step(dt(i, runner.state));
    await flush();
  }
}

async function runPass(
  init: Parameters<typeof makeHarness>[0] = {},
  viewOpts: Parameters<typeof makeView>[1] = {},
  extra: Partial<ConstructorParameters<typeof BenchRunner>[0]> = {},
) {
  const h = makeHarness(init);
  const v = makeView(h, viewOpts);
  const runner = new BenchRunner({ env: h.env, view: v.view, meta, durations, ...extra });
  const result = runner.start();
  await drive(h, runner);
  return { h, v, runner, result: await result };
}

test("one valid pass walks warm-up, steady, churn, settle and writes the result record", async () => {
  const states: BenchState[] = [];
  const { result, v } = await runPass(
    {},
    { cpu: 4 },
    {
      onStatus: (s) => states.push(s.state),
    },
  );
  expect(result.valid).toBe(true);
  expect(result.reason).toBeNull();
  expect(states).toEqual(["warmup", "steady", "churn", "settle", "done"]);
  expect(result).toMatchObject({
    view: "spike-r3f",
    load: 4,
    bloom: 1,
    pass: 2,
    browser: { name: "chrome", version: "156.0" },
    devicePixelRatio: 2,
    canvas: { width: 2560, height: 1440 },
    gpuRenderer: null,
    versions: { three: "0.186.1", r3f: "9.8.1", app: "0.2.1" },
    timer: { crossOriginIsolated: true, stepMs: 0.02 },
  });
  expect(result.startedAt).toBe(new Date(1_800_000_000_000).toISOString());
  expect(result.stats.steady.cpu).toMatchObject({ n: 10, median: 4, p95: 4, p99: 4 });
  expect(result.stats.steady.interval).toMatchObject({ median: 16 });
  expect(result.stats.steady.refreshIntervalMs).toBe(16);
  expect(result.stats.steady.fps).toBeCloseTo(62.5, 1);
  expect(result.stats.churn.cycles).toBe(3);
  expect(result.counts.before?.halls).toBe(12);
  expect(result.counts.after?.halls).toBe(12);
  expect(result.counts.before?.drawCalls).toBe(36);
  expect(result.counts.after?.drawCalls).toBe(36);
  expect(result.baseline).toEqual({
    geometries: true,
    textures: true,
    programs: true,
    storeListeners: true,
    sharedMaterialDisposeEvents: true,
    all: true,
  });
  expect(v.removeLog).toHaveLength(3);
});

test("every transition table row moves to its next state; the rest are refused", () => {
  const rows: [BenchState, Parameters<typeof transition>[1], BenchState][] = [
    ["idle", "start", "warmup"],
    ["idle", "invalidate", "invalid"],
    ["warmup", "elapsed", "steady"],
    ["warmup", "invalidate", "invalid"],
    ["steady", "elapsed", "churn"],
    ["steady", "invalidate", "invalid"],
    ["churn", "churnDone", "settle"],
    ["churn", "invalidate", "invalid"],
    ["settle", "elapsed", "done"],
    ["settle", "invalidate", "invalid"],
  ];
  for (const [from, event, to] of rows) expect(transition(from, event)).toBe(to);
  expect(rows).toHaveLength(
    Object.values(TRANSITIONS).reduce((n, r) => n + Object.keys(r).length, 0),
  );
  expect(transition("warmup", "churnDone")).toBeNull();
  expect(transition("done", "start")).toBeNull();
  expect(transition("invalid", "elapsed")).toBeNull();
});

test("tab hidden, window blurred, resize and context loss each stop the pass as invalid", async () => {
  const cases: [InterruptReason, string][] = [
    ["visibility", "tab hidden"],
    ["visibility", "window blurred"],
    ["resize", "window resized"],
    ["contextlost", "webglcontextlost"],
  ];
  for (const [reason, message] of cases) {
    const h = makeHarness();
    const v = makeView(h);
    const runner = new BenchRunner({ env: h.env, view: v.view, meta, durations });
    const done = runner.start();
    for (let i = 0; i < 8; i++) h.step(16);
    h.emit(reason, message);
    const result = await done;
    expect(result.valid).toBe(false);
    expect(result.reason).toBe(reason);
    expect(result.message).toBe(message);
    expect(result.invalidAtSec).toBeCloseTo(0.132, 3);
    expect(runner.state).toBe("invalid");
    expect(h.scheduled).toBe(false);
  }
});

test("an interruption during churn stops the churn loop", async () => {
  const h = makeHarness();
  const v = makeView(h, { addFrames: 100000 });
  const runner = new BenchRunner({ env: h.env, view: v.view, meta, durations });
  const done = runner.start();
  await drive(h, runner, () => 16, 30);
  expect(runner.state).toBe("churn");
  h.emit("resize", "window resized");
  const result = await done;
  await flush();
  expect(result.valid).toBe(false);
  expect(result.reason).toBe("resize");
  expect(v.removeLog).toHaveLength(0);
});

test("a hall that throws during churn (rejected addHalls) is a ChurnError", async () => {
  const { result } = await runPass({}, { failAdd: true });
  expect(result.valid).toBe(false);
  expect(result.reason).toBe("churn-error");
  expect(result.message).toBe("boom");
  expect(result.invalidAtSec).toBeGreaterThan(0);
});

test("an error boundary can invalidate a pass from outside the loop", async () => {
  const h = makeHarness();
  const v = makeView(h);
  const runner = new BenchRunner({ env: h.env, view: v.view, meta, durations });
  const done = runner.start();
  for (let i = 0; i < 4; i++) h.step(16);
  runner.invalidate("churn-error", "Hall 14 threw");
  expect(await done).toMatchObject({
    valid: false,
    reason: "churn-error",
    message: "Hall 14 threw",
  });
  runner.invalidate("resize", "late");
  expect((await done).reason).toBe("churn-error");
});

test("WebGL2 or composer init failure writes valid:false before any frame", async () => {
  for (const reason of ["webgl-unavailable", "composer-init"] as const) {
    const h = makeHarness();
    const v = makeView(h);
    const runner = new BenchRunner({ env: h.env, view: v.view, meta, durations });
    runner.invalidate(reason, "no context");
    const result = await runner.start();
    expect(result).toMatchObject({ valid: false, reason, message: "no context" });
    expect(result.stats.steady.cpu).toBeNull();
    expect(h.scheduled).toBe(false);
    expect(v.framesAt).toHaveLength(0);
  }
  expect(initFailureText("webgl-unavailable", "no context")).toBe("WebGL2 unavailable: no context");
  expect(initFailureText("composer-init", "bad shader")).toContain("bad shader");
});

test("a missing GPU timer reads null; disjoint samples are dropped and counted", async () => {
  const none = await runPass();
  expect(none.result.stats.steady.gpu).toBeNull();
  expect(none.result.stats.steady.gpuDisjointDropped).toBeNull();

  let calls = 0;
  const gpuTimer: GpuTimer = {
    begin() {},
    end() {},
    poll(onSample, onDisjoint) {
      if (++calls % 5 === 0) onDisjoint();
      else onSample(2);
    },
  };
  const some = await runPass({}, {}, { gpuTimer });
  expect(some.result.stats.steady.gpu).toMatchObject({ median: 2 });
  expect(some.result.stats.steady.gpuDisjointDropped).toBeGreaterThan(0);
});

test("a missing JS heap reads null, never 0", async () => {
  const none = await runPass({ heap: null });
  expect(none.result.heap).toEqual({ beforeChurn: null, afterSettle: null });
  const some = await runPass({ heap: 5_000_000 });
  expect(some.result.heap).toEqual({ beforeChurn: 5_000_000, afterSettle: 5_000_000 });
});

test("a timer step coarser than 0.1 ms makes the pass invalid with coarse-timer (E6)", async () => {
  const coarse = await runPass({ timerStep: 1 });
  expect(coarse.result).toMatchObject({
    valid: false,
    reason: "coarse-timer",
    timer: { crossOriginIsolated: true, stepMs: 1 },
  });
  expect(coarse.v.framesAt).toHaveLength(0);
  expect(coarse.h.scheduled).toBe(false);
  const fine = await runPass({ timerStep: 0.1 });
  expect(fine.result.valid).toBe(true);
  expect(isCoarseTimer(0.1)).toBe(false);
  expect(isCoarseTimer(0.1 + 1e-12)).toBe(false);
  expect(isCoarseTimer(0.5)).toBe(true);
  expect(isCoarseTimer(1)).toBe(true);
});

test("measureTimerStep finds the smallest step of a quantised clock", () => {
  for (const step of [0.1, 1, 0.02]) {
    let x = 0;
    const now = () => Math.floor((x += step / 7) / step) * step;
    expect(measureTimerStep(now, 20)).toBeCloseTo(step, 6);
  }
});

test("shared material dispose events and leaked counts fail the baseline check (E9, RW3)", async () => {
  const disposed = await runPass({}, { disposeEvents: 2 });
  expect(disposed.result.valid).toBe(true);
  expect(disposed.result.baseline).toMatchObject({
    sharedMaterialDisposeEvents: false,
    all: false,
  });
  const leaked = await runPass({}, { leak: 3 });
  expect(leaked.result.baseline).toMatchObject({ geometries: false, all: false });
});

test("the churn hitch is the longest wall-clock rAF interval, not CPU time (E15)", async () => {
  let churnFrames = 0;
  const { result } = await runPass({}, { cpu: 4 }, {});
  expect(result.stats.churn.longestIntervalMs).toBe(16);
  const h = makeHarness();
  const v = makeView(h, { cpu: 4 });
  const runner = new BenchRunner({ env: h.env, view: v.view, meta, durations });
  const done = runner.start();
  await drive(h, runner, (_i, state) => (state === "churn" && ++churnFrames === 3 ? 70 : 16));
  const stalled = await done;
  expect(stalled.stats.churn.longestIntervalMs).toBe(70);
  expect(stalled.stats.churn.cpu?.max).toBe(4);
});

test("churn waits for addHalls to resolve, renders one frame, then removes (E16, RW8)", async () => {
  const { v, result } = await runPass({}, { addFrames: 3 });
  expect(result.valid).toBe(true);
  expect(v.removeLog).toHaveLength(3);
  let previous = 0;
  for (const framesWithAddedHalls of v.removeLog) {
    expect(framesWithAddedHalls).toBeGreaterThan(previous);
    previous = framesWithAddedHalls;
  }
  expect(v.framesAt.filter((x) => x === 18).length).toBeGreaterThanOrEqual(3);
});

test("sample storage is sized up front; overflow is counted, not grown", async () => {
  const { result } = await runPass({}, {}, { sampleCapacity: 4 });
  expect(result.valid).toBe(true);
  expect(result.samplesDropped).toBeGreaterThan(0);
  expect(result.stats.steady.cpu?.n).toBe(4);
});

test("controls are disabled for the whole pass and enabled otherwise", () => {
  const disabled: BenchState[] = ["warmup", "steady", "churn", "settle"];
  const enabled: BenchState[] = ["idle", "done", "invalid"];
  for (const s of disabled) expect(controlsDisabled(s)).toBe(true);
  for (const s of enabled) expect(controlsDisabled(s)).toBe(false);
});

test("DrawCallCounter sums every pass of a frame with autoReset off (E10)", () => {
  const info = {
    autoReset: true,
    render: { calls: 0 },
    reset() {
      this.render.calls = 0;
    },
  };
  const counter = new DrawCallCounter(info);
  expect(info.autoReset).toBe(false);
  counter.begin();
  info.render.calls += 5;
  info.render.calls += 7;
  counter.end();
  expect(counter.calls).toBe(12);
  counter.begin();
  info.render.calls += 5;
  info.render.calls += 7;
  counter.end();
  expect(counter.calls).toBe(12);
});

test("the banner and file name follow the result record", () => {
  const result = { valid: false, reason: "resize", invalidAtSec: 4.25 } as BenchResult;
  expect(bannerText(result)).toBe("Pass invalid: resize at 4.3 s");
  const ok = { ...meta, valid: true } as unknown as BenchResult;
  expect(resultFileName(ok)).toBe("chrome-spike-r3f-load4-bloom1-pass2.json");
});

test("detectBrowser names Chrome, Firefox and Safari from the user agent", () => {
  expect(
    detectBrowser(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    ),
  ).toEqual({ name: "chrome", version: "156.0.0.0" });
  expect(
    detectBrowser(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0",
    ),
  ).toEqual({ name: "firefox", version: "157.0" });
  expect(
    detectBrowser(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15",
    ),
  ).toEqual({ name: "safari", version: "27.2" });
  expect(detectBrowser("curl/8")).toEqual({ name: "unknown", version: "unknown" });
});

test("a blocked download leaves the JSON in the console and on window.__benchResult", () => {
  const result = { ...meta, valid: true } as unknown as BenchResult;
  const sinks = {
    setGlobal: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    download: vi.fn(() => {
      throw new Error("blocked");
    }),
  };
  expect(publishResult(result, sinks)).toBe(false);
  expect(sinks.setGlobal).toHaveBeenCalledWith(result);
  expect(sinks.log).toHaveBeenCalledWith(JSON.stringify(result));
  expect(sinks.warn).toHaveBeenCalled();
  const ok = { ...sinks, download: vi.fn(), warn: vi.fn() };
  expect(publishResult(result, ok)).toBe(true);
  expect(ok.download).toHaveBeenCalledWith(
    expect.stringContaining(".json"),
    JSON.stringify(result),
  );
  expect(ok.warn).not.toHaveBeenCalled();
});
