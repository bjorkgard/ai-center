import { useCallback, useEffect, useState } from "react";
import { PerfHud } from "../scene/PerfHud.tsx";
import { SceneCanvas } from "../scene/SceneCanvas.tsx";
import { CardLayer } from "../scene/cards/CardLayer.tsx";
import { backdropFor } from "../scene/cards/select.ts";
import { Loader } from "../ui/Loader.tsx";
import { Shell } from "../ui/Shell.tsx";
import { ToastHost } from "../ui/ToastHost.tsx";
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

  // The look-dev view is the bare vignette: no shell, HUD, loader or toasts (CEO C17).
  const lookdev = params.view === "lookdev";

  useEffect(() => watchReducedMotion((value) => useStore.getState().setReducedMotion(value)), []);

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
      {!lookdev && <Loader ready={ready} />}
      {!lookdev && <Shell />}
      <div
        data-testid="safe-area"
        className="pointer-events-none absolute"
        style={{
          left: safeArea.x,
          top: safeArea.y,
          width: safeArea.width,
          height: safeArea.height,
        }}
      >
        <CardLayer />
        {params.dev && !lookdev && <PerfHud frozen={params.freeze} />}
      </div>
      {!lookdev && <ToastHost />}
    </main>
  );
}
