import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import { RENDER } from "./render.ts";

export type Projection = "orthographic" | "perspective";

// True isometric: 45 degrees around the vertical axis, then the elevation whose
// tangent is 1/sqrt(2), so the camera looks along (1, 1, 1) and all three axes
// foreshorten equally.
export const ISO_AZIMUTH = Math.PI / 4;
export const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);

// Orthographic zoom is pixels per world unit. Chunk 05's controls clamp to these.
export const ORTHO_ZOOM = { min: 20, default: 80, max: 240 } as const; // [estimated]
export const PERSPECTIVE_FOV = 35; // degrees [estimated]
const ORTHO_DISTANCE = 100; // far from the scene so the ortho frustum never clips it

const ISO_DIRECTION = new Vector3(
  Math.cos(ISO_ELEVATION) * Math.sin(ISO_AZIMUTH),
  Math.sin(ISO_ELEVATION),
  Math.cos(ISO_ELEVATION) * Math.cos(ISO_AZIMUTH),
);

const halfFov = () => Math.tan((PERSPECTIVE_FOV * Math.PI) / 360);

// The ortho view shows height / zoom world units; a perspective camera at distance d
// shows 2 d tan(fov / 2) at the target. Equal heights keep the framing across a toggle.
export function distanceForZoom(zoom: number, viewportHeight: number): number {
  return viewportHeight / (zoom * 2 * halfFov());
}

export function zoomForDistance(distance: number, viewportHeight: number): number {
  return viewportHeight / (distance * 2 * halfFov());
}

export function clampZoom(zoom: number): number {
  return Math.min(ORTHO_ZOOM.max, Math.max(ORTHO_ZOOM.min, zoom));
}

// The perspective distance range that matches the ortho zoom range (S-RW26).
export function perspectiveDistanceRange(viewportHeight: number): { min: number; max: number } {
  return {
    min: distanceForZoom(ORTHO_ZOOM.max, viewportHeight),
    max: distanceForZoom(ORTHO_ZOOM.min, viewportHeight),
  };
}

export function clampDistance(distance: number, viewportHeight: number): number {
  const { min, max } = perspectiveDistanceRange(viewportHeight);
  return Math.min(max, Math.max(min, distance));
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Framing {
  target: Vector3;
  zoom: number;
}

export type CameraListener = (camera: OrthographicCamera | PerspectiveCamera) => void;

export interface CameraRig {
  readonly ortho: OrthographicCamera;
  readonly perspective: PerspectiveCamera;
  readonly active: OrthographicCamera | PerspectiveCamera;
  readonly projection: Projection;
  readonly framing: Framing;
  toggle(): void;
  setFraming(next: Partial<Framing>): void;
  setViewport(viewport: Viewport): void;
  // Chunk 05 registers its glide here; a toggle calls it first (S-RW39).
  setGlideCanceller(cancel: (() => void) | null): void;
  subscribe(listener: CameraListener): () => void;
}

export function createCameraRig(initial: Viewport): CameraRig {
  const ortho = new OrthographicCamera(0, 0, 0, 0, RENDER.camera.near, RENDER.camera.far);
  const perspective = new PerspectiveCamera(
    PERSPECTIVE_FOV,
    1,
    RENDER.camera.near,
    RENDER.camera.far,
  );
  const framing: Framing = { target: new Vector3(0, 0, 0), zoom: ORTHO_ZOOM.default };
  const listeners = new Set<CameraListener>();
  let viewport = initial;
  let projection: Projection = "orthographic";
  let distance = distanceForZoom(framing.zoom, viewport.height);
  let cancelGlide: (() => void) | null = null;

  const active = () => (projection === "orthographic" ? ortho : perspective);

  const apply = () => {
    const { width, height } = viewport;
    if (projection === "orthographic") {
      ortho.zoom = framing.zoom;
      ortho.left = width / -2;
      ortho.right = width / 2;
      ortho.top = height / 2;
      ortho.bottom = height / -2;
      ortho.position.copy(framing.target).addScaledVector(ISO_DIRECTION, ORTHO_DISTANCE);
      ortho.lookAt(framing.target);
      ortho.updateProjectionMatrix();
    } else {
      perspective.aspect = height > 0 ? width / height : 1;
      perspective.position.copy(framing.target).addScaledVector(ISO_DIRECTION, distance);
      perspective.lookAt(framing.target);
      perspective.updateProjectionMatrix();
    }
    active().updateMatrixWorld(true);
  };
  apply();

  return {
    ortho,
    perspective,
    get active() {
      return active();
    },
    get projection() {
      return projection;
    },
    framing,
    toggle() {
      cancelGlide?.();
      if (projection === "orthographic") {
        distance = clampDistance(distanceForZoom(framing.zoom, viewport.height), viewport.height);
        projection = "perspective";
      } else {
        framing.zoom = clampZoom(zoomForDistance(distance, viewport.height));
        projection = "orthographic";
      }
      apply();
      for (const listener of listeners) listener(active());
    },
    setFraming(next) {
      if (next.target) framing.target.copy(next.target);
      if (next.zoom !== undefined) {
        framing.zoom = clampZoom(next.zoom);
        distance = distanceForZoom(framing.zoom, viewport.height);
      }
      apply();
    },
    setViewport(next) {
      viewport = next;
      apply();
    },
    setGlideCanceller(cancel) {
      cancelGlide = cancel;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
