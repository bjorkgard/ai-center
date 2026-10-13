import { useEffect, useState } from "react";
import { useStore } from "../app/store/index.ts";
import { hudRows } from "./hud.ts";
import { getSceneProbe, type SceneStats } from "./stats.ts";

const SAMPLE_MS = 250;
const BUTTON =
  "mt-2 w-full rounded-control border border-white/12 px-2 py-1 text-caption text-text-2 hover:text-text";

// Dev perf HUD (S-RW4, DR11): top-right of the safe area, 8 px inset, Geist Mono 12 px
// with tabular numerals, solid fill, no blur. It reads the probe on a timer, not per frame.
// Under the rows, a collapsible Camera section (open at first) holds the glide test, the
// projection toggle and the right-panel toggle.
export function PerfHud({ frozen }: { frozen: boolean }) {
  const quality = useStore((s) => s.quality);
  const webgl = useStore((s) => s.webgl);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);
  const [cameraOpen, setCameraOpen] = useState(true);
  const [view, setView] = useState<{ stats: SceneStats | null; fps: number }>({
    stats: null,
    fps: 0,
  });

  useEffect(() => {
    let last = { frames: 0, at: performance.now() };
    const id = setInterval(() => {
      const stats = getSceneProbe()?.read() ?? null;
      const now = performance.now();
      const frames = stats?.frames ?? 0;
      const fps = frames >= last.frames ? ((frames - last.frames) * 1000) / (now - last.at) : 0;
      last = { frames, at: now };
      setView({ stats, fps });
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, []);

  const rows = hudRows({ ...view, frozen, quality, webgl });
  const other = view.stats?.projection === "perspective" ? "orthographic" : "perspective";
  return (
    <div
      data-testid="perf-hud"
      className="pointer-events-auto absolute top-2 right-2 rounded-control border border-white/12 bg-bg p-2 font-mono text-caption text-text tabular-nums"
    >
      <dl className="m-0 grid grid-cols-[auto_auto] gap-x-3">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-text-2">{label}</dt>
            <dd className="m-0 text-right" data-hud={label}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <section data-testid="dev-camera" className="mt-2 border-t border-white/12 pt-2">
        <button
          type="button"
          aria-expanded={cameraOpen}
          aria-controls="dev-camera-body"
          className="flex w-full items-center justify-between text-caption text-text-2 hover:text-text"
          onClick={() => setCameraOpen(!cameraOpen)}
        >
          Camera
          <span aria-hidden="true">{cameraOpen ? "-" : "+"}</span>
        </button>
        {cameraOpen && (
          <div id="dev-camera-body">
            <button type="button" className={BUTTON} onClick={() => getSceneProbe()?.glideTest()}>
              Glide test
            </button>
            <button
              type="button"
              className={BUTTON}
              onClick={() => getSceneProbe()?.toggleProjection()}
            >
              Switch to {other}
            </button>
            <button
              type="button"
              aria-pressed={rightPanelOpen}
              className={BUTTON}
              onClick={() => useStore.getState().setRightPanelOpen(!rightPanelOpen)}
            >
              {rightPanelOpen ? "Hide" : "Show"} right panel
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
