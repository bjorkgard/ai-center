import { useCallback, useEffect, useState } from "react";
import { PerfHud } from "../scene/PerfHud.tsx";
import { SceneCanvas } from "../scene/SceneCanvas.tsx";
import { CardLayer } from "../scene/cards/CardLayer.tsx";
import { backdropFor } from "../scene/cards/select.ts";
import { loadParams } from "./params.ts";
import { watchReducedMotion } from "./reducedMotion.ts";
import { useStore } from "./store/index.ts";

export function App() {
  const [params] = useState(() => loadParams(window.location.search));
  const [ready, setReady] = useState(false);
  const safeArea = useStore((s) => s.safeArea);
  const backdrop = useStore((s) => backdropFor(s.webgl, s.sceneError));

  const onReady = useCallback((value: boolean) => {
    window.__sceneReady = value;
    setReady(value);
  }, []);

  useEffect(() => watchReducedMotion((value) => useStore.getState().setReducedMotion(value)), []);

  // Until 04b's layout shell measures the panels, the safe area is the whole viewport.
  useEffect(() => {
    const fill = () =>
      useStore
        .getState()
        .setSafeArea({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight });
    fill();
    window.addEventListener("resize", fill);
    return () => window.removeEventListener("resize", fill);
  }, []);

  return (
    <main
      className="relative h-full overflow-hidden bg-bg"
      data-scene-ready={ready ? "" : undefined}
    >
      <SceneCanvas params={params} onReady={onReady} />
      {backdrop && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 bg-bg ${backdrop === "dim" ? "opacity-60" : ""}`}
        />
      )}
      <div
        className="pointer-events-none absolute"
        style={{
          left: safeArea.x,
          top: safeArea.y,
          width: safeArea.width,
          height: safeArea.height,
        }}
      >
        <CardLayer />
        {params.dev && <PerfHud frozen={params.freeze} />}
      </div>
    </main>
  );
}
