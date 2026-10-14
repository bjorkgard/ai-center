import { useStore } from "../app/store/index.ts";
import { allMaterials } from "./materials.ts";
import { simulateFrameInterval } from "./loop/monitor.ts";
import { setRoofCut } from "./hall/roof.ts";
import { signOpacity } from "./hall/signVisibility.ts";
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
    setRoofCut,
    // Forces a quality tier: medium and low turn bloom off, which scales the glow (WD4).
    setQuality: (tier) => {
      if (tier !== "high" && tier !== "medium" && tier !== "low") {
        console.warn(
          `[dev] setQuality: "tier" must be high, medium or low, got ${String(tier)}; ignoring it`,
        );
        return;
      }
      useStore.getState().setQuality(tier);
    },
    // Current opacity (0-1) of a hall's sign panel, or null outside the hall views.
    signOpacity: (slot) => {
      if (!Number.isInteger(slot) || slot < 0 || slot > 11) {
        console.warn(`[dev] signOpacity: "slot" must be a whole number 0-11, got ${String(slot)}`);
        return null;
      }
      return signOpacity(slot);
    },
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
