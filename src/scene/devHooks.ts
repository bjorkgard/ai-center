import { useStore } from "../app/store/index.ts";
import { simulateFrameInterval } from "./loop/monitor.ts";
import { getSceneProbe } from "./stats.ts";

// window.__sceneDev, only with dev=1 (S-RW11): lets Playwright drive the frame
// monitor, read the stats and trigger the failure paths in any engine.
export function installSceneDev(
  extra: Pick<SceneDevHooks, "throwInScene" | "throwInFrame" | "throwInComposer">,
): () => void {
  const hooks: SceneDevHooks = {
    simulateFrameInterval,
    stats: () => getSceneProbe()?.read() ?? null,
    state: () => {
      const { webgl, quality, reducedMotion, sceneError } = useStore.getState();
      return { webgl, quality, reducedMotion, sceneError };
    },
    ...extra,
  };
  window.__sceneDev = hooks;
  return () => {
    if (window.__sceneDev === hooks) delete window.__sceneDev;
  };
}
