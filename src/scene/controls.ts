import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import {
  ELEVATION_RANGE,
  ORTHO_ZOOM,
  clampTarget,
  perspectiveDistanceRange,
  type CameraRig,
} from "./camera.ts";

// Pan and rotate ease to a stop over about 250 ms (CEO C20). The decay is exponential in real
// time, so 95% of the motion is done after three time constants at any frame rate.
export const DAMPING_SETTLE_MS = 250; // [estimated]
const TAU_MS = DAMPING_SETTLE_MS / 3;
const MAX_DT_MS = 100;

export interface ControlsDeps {
  reducedMotion(): boolean;
  // The camera moved because of the controls (drag, wheel or settling damping).
  onChange(): void;
}

export interface CameraControls {
  // One frame of the controls; true while the camera moved, including damping still settling.
  update(dtMs: number): boolean;
  stopDamping(): void;
  setReducedMotion(reduced: boolean): void;
  // Re-reads the active camera and the viewport after a projection toggle or a resize.
  syncLimits(): void;
  dispose(): void;
}

// OrbitControls keeps its damping residue in these; there is no public way to drop it.
interface DampingResidue {
  _sphericalDelta: { set(a: number, b: number, c: number): void };
  _panOffset: { set(a: number, b: number, c: number): void };
}

// three's MapControls on the rig: left-drag pans, right-drag rotates, the wheel zooms to the
// cursor. After every change the target is clamped to the campus and the rig reads the angles
// and zoom back, so the rig stays the one source of the framing.
export function createCameraControls(
  rig: CameraRig,
  domElement: HTMLElement,
  deps: ControlsDeps,
): CameraControls {
  const controls = new MapControls(rig.active, domElement);
  controls.target = rig.framing.target;
  controls.zoomToCursor = true;
  controls.minZoom = ORTHO_ZOOM.min;
  controls.maxZoom = ORTHO_ZOOM.max;
  controls.minPolarAngle = Math.PI / 2 - ELEVATION_RANGE.max;
  controls.maxPolarAngle = Math.PI / 2 - ELEVATION_RANGE.min;
  controls.enableDamping = !deps.reducedMotion();
  controls.dampingFactor = 1 - Math.exp(-16.7 / TAU_MS);

  const stopDamping = () => {
    const residue = controls as unknown as DampingResidue;
    residue._sphericalDelta.set(0, 0, 0);
    residue._panOffset.set(0, 0, 0);
  };

  const syncLimits = () => {
    controls.object = rig.active;
    if (rig.projection === "perspective") {
      const range = perspectiveDistanceRange(rig.viewport.height);
      controls.minDistance = range.min;
      controls.maxDistance = range.max;
    } else {
      controls.minDistance = 0;
      controls.maxDistance = Infinity;
    }
  };
  syncLimits();

  // Keep the camera on the same offset from the target when the target is pushed back inside,
  // then let the rig read the angles and zoom back. Also runs after frames that moved less than
  // the change threshold, so a slow damping tail cannot creep past the bounds.
  const enforce = () => {
    const before = controls.target.clone();
    clampTarget(controls.target);
    controls.object.position.add(controls.target.clone().sub(before));
    controls.object.updateMatrixWorld(true);
    rig.adopt({ azimuth: controls.getAzimuthalAngle(), polar: controls.getPolarAngle() });
  };
  const onChange = () => {
    enforce();
    deps.onChange();
  };
  const onStart = () => {
    rig.cancelGlide();
    stopDamping();
  };
  controls.addEventListener("change", onChange);
  controls.addEventListener("start", onStart);

  return {
    update(dtMs) {
      controls.dampingFactor = 1 - Math.exp(-Math.min(MAX_DT_MS, Math.max(1, dtMs)) / TAU_MS);
      const changed = controls.update();
      if (!changed) enforce();
      return changed;
    },
    stopDamping,
    setReducedMotion(reduced) {
      controls.enableDamping = !reduced;
      if (reduced) stopDamping();
    },
    syncLimits,
    dispose() {
      controls.removeEventListener("change", onChange);
      controls.removeEventListener("start", onStart);
      controls.dispose();
    },
  };
}

type ControlsSource = () => CameraControls | null | undefined;

// One loop update: advance a glide or key step, then the controls. True while either moved, so
// damping still settling keeps the 60 fps cap (CEO C20).
export function stepCamera(
  rig: CameraRig,
  controls: CameraControls | null | undefined,
  now: number,
  interval: number,
): boolean {
  const animated = rig.step(now);
  const moved = controls?.update(interval) ?? false;
  return animated || moved;
}

// A glide or key step wakes the loop and drops any damping left from a drag.
export function wakeOnRigMotion(
  rig: CameraRig,
  controls: ControlsSource,
  wake: () => void,
): () => void {
  return rig.onMotion(() => {
    controls()?.stopDamping();
    wake();
  });
}
