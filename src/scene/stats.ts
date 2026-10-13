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
  composerGen: number;
}

export interface SceneProbe {
  read(): SceneStats;
  toggleProjection(): void;
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
