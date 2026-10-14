import type { QualityTier, WebglStatus } from "../app/store/index.ts";
import type { SceneStats } from "./stats.ts";

export interface HudInput {
  fps: number;
  frozen: boolean;
  stats: SceneStats | null;
  quality: QualityTier;
  webgl: WebglStatus;
}

// Label and value pairs for the dev perf HUD. Under freeze the counts stay and
// "frozen" replaces fps (S-RW32).
export function hudRows(input: HudInput): [string, string][] {
  const { stats } = input;
  const n = (value: number | undefined) => (value === undefined ? "-" : String(value));
  return [
    ["fps", input.frozen ? "frozen" : String(Math.round(input.fps))],
    ["scene calls", n(stats?.sceneCalls)],
    ["post calls", n(stats?.postCalls)],
    ["triangles", n(stats?.triangles)],
    ["geometries", n(stats?.geometries)],
    ["textures", n(stats?.textures)],
    ["programs", n(stats?.programs)],
    ["cap", stats ? `${stats.capFps} fps ${stats.mode}` : "-"],
    ["quality", input.quality],
    ["webgl", input.webgl],
    ["frame errors", n(stats?.frameErrors)],
    ["camera", stats?.projection ?? "-"],
  ];
}
