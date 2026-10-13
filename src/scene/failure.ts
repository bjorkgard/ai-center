import { transitionSceneError, transitionWebgl } from "./transitions.ts";
import { WebGLUnavailableError } from "./webgl.ts";

export function classifyError(error: unknown): "webgl" | "scene" {
  return error instanceof WebGLUnavailableError ? "webgl" : "scene";
}

// The outer boundary's report: WebGL failures show the WebGL card, anything else
// the scene-error card (C23). Both land in the store; cards render from it.
export function reportSceneFailure(error: unknown): void {
  if (classifyError(error) === "webgl") {
    const message = error instanceof Error ? error.message : String(error);
    transitionWebgl("unavailable", "start", message);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    transitionSceneError(message, "component error");
  }
}

// The inner boundary's report: the canvas stays mounted, so the driver stops (no more
// frames) and the last frame stays visible under the scene-error card's overlay.
export function reportContentFailure(error: unknown, stopDriver: () => void): void {
  stopDriver();
  const message = error instanceof Error ? error.message : String(error);
  transitionSceneError(message, "component error");
}
