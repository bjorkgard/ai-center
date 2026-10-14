import { useCallback, useEffect, useState } from "react";
import { PerfHud } from "../scene/PerfHud.tsx";
import { SceneCanvas } from "../scene/SceneCanvas.tsx";
import { signAtlasReady } from "../scene/hall/signAtlas.ts";
import { CardLayer } from "../scene/cards/CardLayer.tsx";
import { backdropFor } from "../scene/cards/select.ts";
import { Loader } from "../ui/Loader.tsx";
import { Shell } from "../ui/Shell.tsx";
import { ToastHost } from "../ui/ToastHost.tsx";
import { loadParams } from "./params.ts";
import { watchReducedMotion } from "./reducedMotion.ts";
import { useStore } from "./store/index.ts";

// Four small cyan corners framing the safe area while the canvas has keyboard focus. They show
// on :focus-visible only (the rule is in index.css), instead of the D21 ring round the viewport.
function FocusBrackets() {
  const corner = "absolute size-4 border-cyan";
  return (
    <div
      aria-hidden="true"
      data-testid="focus-brackets"
      className="focus-brackets absolute inset-0"
    >
      <span className={`${corner} top-1 left-1 border-t-2 border-l-2`} />
      <span className={`${corner} top-1 right-1 border-t-2 border-r-2`} />
      <span className={`${corner} bottom-1 left-1 border-b-2 border-l-2`} />
      <span className={`${corner} right-1 bottom-1 border-r-2 border-b-2`} />
    </div>
  );
}

export function App() {
  const [params] = useState(() => loadParams(window.location.search));
  const [frame, setFrame] = useState(false);
  const [atlas, setAtlas] = useState(false);
  const safeArea = useStore((s) => s.safeArea);
  const backdrop = useStore((s) => backdropFor(s.webgl, s.sceneError));

  // Ready is the first frame and the sign atlas (its font loaded or given up on), so shots and
  // baselines always capture one font (CEO W-RW29). The WebGL card path never gets a frame.
  const ready = frame && atlas;
  useEffect(() => {
    window.__sceneReady = ready;
  }, [ready]);
  useEffect(() => {
    let live = true;
    void signAtlasReady().then(() => live && setAtlas(true));
    return () => {
      live = false;
    };
  }, []);
  const onReady = useCallback((value: boolean) => setFrame(value), []);

  // The look-dev view is the bare vignette: no shell, HUD, loader or toasts (CEO C17).
  const lookdev = params.view === "lookdev";

  useEffect(() => watchReducedMotion((value) => useStore.getState().setReducedMotion(value)), []);

  const stage = (
    <>
      <SceneCanvas params={params} onReady={onReady} />
      {backdrop && (
        <div
          aria-hidden="true"
          className={`pointer-events-none absolute inset-0 bg-bg ${backdrop === "dim" ? "opacity-60" : ""}`}
        />
      )}
      {!lookdev && <Loader ready={ready} />}
    </>
  );

  return (
    <main
      className="relative h-full overflow-hidden bg-bg"
      data-scene-ready={ready ? "" : undefined}
    >
      {lookdev ? stage : <Shell stage={stage} />}
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
        {!lookdev && <FocusBrackets />}
        {params.dev && !lookdev && <PerfHud frozen={params.freeze} />}
      </div>
      {!lookdev && <ToastHost />}
    </main>
  );
}
