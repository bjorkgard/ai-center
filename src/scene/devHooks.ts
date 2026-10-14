import { useStore } from "../app/store/index.ts";
import { allMaterials } from "./materials.ts";
import { simulateFrameInterval } from "./loop/monitor.ts";
import { guardDisposeEvents } from "./render.ts";
import { getSceneProbe } from "./stats.ts";

// window.__sceneDev, only with dev=1 (S-RW11): lets Playwright drive the frame
// monitor, read the stats and trigger the failure paths in any engine.
export function installSceneDev(
  extra: Pick<
    SceneDevHooks,
    "throwInScene" | "throwInFrame" | "throwInComposer" | "remountContent"
  >,
): () => void {
  // Counts from the moment the hooks install (E9); a survivor reads 0.
  const guard = guardDisposeEvents(allMaterials());
  const hooks: SceneDevHooks = {
    simulateFrameInterval,
    stats: () => getSceneProbe()?.read() ?? null,
    state: () => {
      const { webgl, quality, reducedMotion, sceneError } = useStore.getState();
      return { webgl, quality, reducedMotion, sceneError };
    },
    rigLights: () => getSceneProbe()?.lights() ?? {},
    camera: () => getSceneProbe()?.camera() ?? null,
    project: (point) => getSceneProbe()?.project(point) ?? null,
    materialDisposeEvents: () => guard.events(),
    // Positive control for the guard: disposes one real library instance on purpose.
    disposeSharedMaterial: () => allMaterials()[0].dispose(),
    ...extra,
  };
  window.__sceneDev = hooks;
  return () => {
    guard.release();
    if (window.__sceneDev === hooks) delete window.__sceneDev;
  };
}
