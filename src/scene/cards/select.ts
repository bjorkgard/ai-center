import type { WebglReason, WebglStatus } from "../../app/store/ui.ts";

export type CardKind = "webgl-start" | "webgl-lost" | "scene-error";

// One card at a time (DR5): unavailable beats scene error beats restoring (no card).
export function selectCard(
  webgl: WebglStatus,
  reason: WebglReason | null,
  sceneError: { message: string } | null,
): CardKind | null {
  if (webgl === "unavailable") return reason === "lost" ? "webgl-lost" : "webgl-start";
  if (sceneError) return "scene-error";
  return null;
}

export type Backdrop = "solid" | "dim" | null;

// What covers the 3D area (DR1): --color-bg while not drawing, a 60% veil over the
// last frame after a scene error.
export function backdropFor(webgl: WebglStatus, sceneError: { message: string } | null): Backdrop {
  if (webgl !== "ok") return "solid";
  return sceneError ? "dim" : null;
}
