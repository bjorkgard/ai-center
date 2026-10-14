import type { DriverMode } from "./loop/driver.ts";
import type { Projection } from "./camera.ts";

// What the perf HUD and the dev hook read (S-RW4, S-RW32). Numbers are per frame
// except `frames` and `frameErrors`, which only count up.
export interface SceneStats {
  frames: number;
  sceneCalls: number;
  postCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  capFps: number;
  mode: DriverMode;
  frameErrors: number;
  projection: Projection;
  bloom: boolean;
  // The composer is bound with all its passes (bloom only says one is expected).
  composerReady: boolean;
  composerGen: number;
}

export interface CameraView {
  target: [number, number, number];
  zoom: number;
  azimuth: number;
  elevation: number;
  projection: Projection;
  animating: boolean;
}

export interface SceneProbe {
  read(): SceneStats;
  toggleProjection(): void;
  // Dev-menu glide test: flies out to a fixed spot, then back home (DR11).
  glideTest(): void;
  camera(): CameraView;
  // Screen position in CSS pixels of a world point.
  project(point: [number, number, number]): { x: number; y: number };
  // Lights in the scene by three.js type, e.g. { HemisphereLight: 1 }.
  lights(): Record<string, number>;
}

let probe: SceneProbe | null = null;

export function setSceneProbe(next: SceneProbe | null): void {
  probe = next;
}

export function getSceneProbe(): SceneProbe | null {
  return probe;
}
