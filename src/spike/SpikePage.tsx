import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  BenchRunner,
  browserEnv,
  createGpuTimer,
  controlsDisabled,
  detectBrowser,
  initFailureText,
  publishResult,
  type BenchMeta,
  type BenchResult,
  type BenchStatus,
  type InvalidReason,
  type SpikeView,
  type SpikeViewHandle,
  type ViewSnapshot,
} from "./shared/bench.ts";
import { createFakeStore, startTicking, type FakeStore } from "./shared/fakeStore.ts";
import type { SpikeParams } from "./shared/params.ts";
import { ComposerInitError } from "./shared/render.ts";
import { R3FView, type R3FErrorKind } from "./r3f/View.tsx";
import { createVanillaView, type VanillaView } from "./vanilla/view.ts";

declare global {
  interface Window {
    __spikeSnapshot?: () => ViewSnapshot;
    __benchResult?: BenchResult;
  }
}

type ErrorKind = R3FErrorKind;

const INERT_VIEW: SpikeView = {
  frame() {},
  addHalls: () => Promise.resolve(),
  removeHalls: () => Promise.resolve(),
  snapshot() {
    throw new Error("no view was created");
  },
};

const CHURN_CYCLES = 50;
const CHURN_HALLS = 6;

function probeWebGL2(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return 'getContext("webgl2") returned null';
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function gpuRendererOf(canvas: HTMLCanvasElement): string | null {
  const gl = canvas.getContext("webgl2");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  return gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null;
}

function download(fileName: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function publish(result: BenchResult): void {
  publishResult(result, {
    setGlobal: (r) => {
      window.__benchResult = r;
    },
    log: (json) => console.log(json),
    warn: (message) => console.warn(message),
    download,
  });
}

// Interactive free-run: one rAF loop, plus the manual churn button.
class FreeRun {
  private view: SpikeView;
  private id = 0;
  private waiter: (() => void) | null = null;
  constructor(view: SpikeView) {
    this.view = view;
  }
  start() {
    const tick = (t: number) => {
      this.view.frame(t);
      const waiter = this.waiter;
      this.waiter = null;
      waiter?.();
      this.id = requestAnimationFrame(tick);
    };
    this.id = requestAnimationFrame(tick);
  }
  stop() {
    cancelAnimationFrame(this.id);
  }
  async churn() {
    for (let i = 0; i < CHURN_CYCLES; i++) {
      await this.view.addHalls(CHURN_HALLS);
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      await this.view.removeHalls(CHURN_HALLS);
    }
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function VanillaHost(props: {
  load: SpikeParams["load"];
  bloom: boolean;
  store: FakeStore;
  onReady: (view: SpikeViewHandle) => void;
  onError: (kind: ErrorKind, error: Error) => void;
}) {
  const { load, store } = props;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<VanillaView | null>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    let created: VanillaView;
    try {
      created = createVanillaView(host.current!, { load, bloom: latest.current.bloom, store });
    } catch (err) {
      latest.current.onError(err instanceof ComposerInitError ? "composer" : "init", toError(err));
      return;
    }
    view.current = created;
    latest.current.onReady(created);
    return () => {
      created.dispose();
      view.current = null;
    };
  }, [load, store]);

  useEffect(() => {
    try {
      view.current?.setBloom(props.bloom);
    } catch (err) {
      latest.current.onError("composer", toError(err));
    }
  }, [props.bloom]);

  return <div ref={host} className="absolute inset-0" />;
}

export function SpikePage({ params }: { params: SpikeParams }) {
  const { load, view: viewName, bench, freeze, seed } = params;
  const store = useMemo(() => createFakeStore({ seed, load }), [seed, load]);
  const [bloom, setBloom] = useState(params.bloom === 1);
  const [status, setStatus] = useState<BenchStatus>({ state: "idle", text: "Starting" });
  const [error, setError] = useState<string | null>(null);
  const [churning, setChurning] = useState(false);
  const [noWebGL] = useState(probeWebGL2);
  const runner = useRef<BenchRunner | null>(null);
  const freeRun = useRef<FreeRun | null>(null);
  const stopTicking = useRef<(() => void) | null>(null);
  const generation = useRef(0);

  const buildMeta = useCallback(
    (canvas: HTMLCanvasElement | null): BenchMeta => ({
      view: viewName,
      load,
      bloom: params.bloom,
      pass: params.pass,
      browser: detectBrowser(navigator.userAgent),
      devicePixelRatio: window.devicePixelRatio,
      canvas: { width: canvas?.width ?? 0, height: canvas?.height ?? 0 },
      gpuRenderer: canvas ? gpuRendererOf(canvas) : null,
      versions: { three: __THREE_VERSION__, r3f: __R3F_VERSION__, app: __APP_VERSION__ },
    }),
    [viewName, load, params.bloom, params.pass],
  );

  // An init failure writes valid:false when a bench pass was requested.
  const publishInitFailure = useCallback(
    (reason: InvalidReason, message: string) => {
      if (!bench) return;
      const failed = new BenchRunner({
        env: browserEnv(document.createElement("canvas")),
        view: INERT_VIEW,
        meta: buildMeta(null),
      });
      failed.invalidate(reason, message);
      void failed.start().then((result) => {
        setStatus({ state: "invalid", text: `Pass invalid: ${reason}` });
        publish(result);
      });
    },
    [bench, buildMeta],
  );

  const failInit = useCallback(
    (reason: InvalidReason, message: string) => {
      setError(
        reason === "webgl-unavailable" || reason === "composer-init"
          ? initFailureText(reason, message)
          : message,
      );
      publishInitFailure(reason, message);
    },
    [publishInitFailure],
  );

  const handleError = useCallback(
    (kind: ErrorKind, err: Error) => {
      const reason: InvalidReason =
        kind === "churn"
          ? "churn-error"
          : kind === "composer"
            ? "composer-init"
            : "webgl-unavailable";
      if (runner.current) runner.current.invalidate(reason, err.message);
      else failInit(reason, err.message);
    },
    [failInit],
  );

  const handleReady = useCallback(
    (view: SpikeViewHandle) => {
      stopTicking.current?.();
      freeRun.current?.stop();
      const mine = ++generation.current;
      window.__spikeSnapshot = () => view.snapshot();
      if (freeze) {
        view.frame(0);
        setStatus({ state: "idle", text: "Frozen frame" });
        return;
      }
      stopTicking.current = startTicking(store, 10);
      if (bench) {
        const gl = view.canvas.getContext("webgl2");
        const next = new BenchRunner({
          env: browserEnv(view.canvas),
          view,
          meta: buildMeta(view.canvas),
          gpuTimer: gl ? createGpuTimer(gl) : null,
          onStatus: (s) => {
            if (mine === generation.current) setStatus(s);
          },
        });
        runner.current = next;
        void next.start().then((result) => {
          if (mine !== generation.current) return;
          publish(result);
          stopTicking.current?.();
        });
      } else {
        freeRun.current = new FreeRun(view);
        freeRun.current.start();
        setStatus({ state: "idle", text: "Running" });
      }
    },
    [freeze, bench, store, buildMeta],
  );

  useEffect(() => {
    if (noWebGL !== null) publishInitFailure("webgl-unavailable", noWebGL);
  }, [noWebGL, publishInitFailure]);

  useEffect(
    () => () => {
      stopTicking.current?.();
      freeRun.current?.stop();
    },
    [],
  );

  const shownError =
    error ?? (noWebGL !== null ? initFailureText("webgl-unavailable", noWebGL) : null);
  const locked = controlsDisabled(status.state) || churning;
  const runChurn = async () => {
    setChurning(true);
    try {
      await freeRun.current?.churn();
    } catch (err) {
      setError(toError(err).message);
    } finally {
      setChurning(false);
    }
  };

  return (
    <main className="relative h-full overflow-hidden bg-bg">
      {noWebGL === null &&
        (viewName === "spike-r3f" ? (
          <R3FView
            load={load}
            bloom={bloom}
            store={store}
            onReady={handleReady}
            onError={handleError}
          />
        ) : (
          <VanillaHost
            load={load}
            bloom={bloom}
            store={store}
            onReady={handleReady}
            onError={handleError}
          />
        ))}
      <div className="absolute top-4 left-4 flex flex-col gap-2 rounded-panel border border-glass-border bg-glass p-3 font-mono text-label text-text">
        <div>
          {viewName} · load {load}x · bloom {bloom ? "on" : "off"}
          {bench ? " · bench" : ""}
        </div>
        <div aria-live="polite" data-testid="spike-status">
          {status.text}
        </div>
        {shownError && (
          <div role="alert" className="text-error">
            {shownError}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded-control border border-glass-border px-2 py-1 disabled:opacity-40"
            disabled={locked || freeze || bench}
            onClick={runChurn}
          >
            Churn {CHURN_CYCLES} x {CHURN_HALLS} halls
          </button>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={bloom}
              disabled={locked}
              onChange={(e) => setBloom(e.target.checked)}
            />
            Bloom
          </label>
        </div>
      </div>
    </main>
  );
}
