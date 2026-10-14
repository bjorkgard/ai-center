import { WebGLRenderer } from "three";
import type { WebglReason, WebglStatus } from "../app/store/ui.ts";
import { RENDER } from "./render.ts";

// Thrown by the WebGL2 pre-check and by the gl factory, so the boundary can tell
// WebGL failures from scene errors by class (E24, C23).
export class WebGLUnavailableError extends Error {
  override name = "WebGLUnavailableError";
}

export const RESTORE_TIMEOUT_MS = 10_000; // [estimated]

type CanvasFactory = () => Pick<HTMLCanvasElement, "getContext">;

export function hasWebgl2(create: CanvasFactory = () => document.createElement("canvas")): boolean {
  try {
    const gl = create().getContext("webgl2") as WebGL2RenderingContext | null;
    if (!gl) return false;
    // Hand the probe context back so it does not count against the context limit.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export function precheckWebgl(enabled: boolean, create?: CanvasFactory): void {
  if (!enabled) throw new WebGLUnavailableError("WebGL was turned off with webgl=0");
  if (!hasWebgl2(create)) throw new WebGLUnavailableError("This browser could not create WebGL2");
}

type RendererCtor = new (params: ConstructorParameters<typeof WebGLRenderer>[0]) => WebGLRenderer;

// R3F's `gl` factory: a failed `new WebGLRenderer(...)` becomes WebGLUnavailableError (E24).
export function createGlFactory(Ctor: RendererCtor = WebGLRenderer) {
  return (defaultProps: Record<string, unknown>): WebGLRenderer => {
    try {
      return new Ctor({ ...defaultProps, ...RENDER.renderer });
    } catch (err) {
      throw new WebGLUnavailableError(err instanceof Error ? err.message : String(err));
    }
  };
}

export const glFactory = createGlFactory();

export interface WebglChange {
  status: WebglStatus;
  reason?: WebglReason;
}

// Context lost -> restoring; no restore in 10 s -> unavailable (lost); any restore,
// late or not, -> ok (S-RW6, S-RW10, S-RW33). Returns the stop function for cleanup (E25).
export function watchContext(
  canvas: Pick<HTMLCanvasElement, "addEventListener" | "removeEventListener">,
  onChange: (change: WebglChange) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onLost = (event: Event) => {
    event.preventDefault(); // without this the browser never fires the restore event
    clearTimeout(timer);
    onChange({ status: "restoring" });
    timer = setTimeout(
      () => onChange({ status: "unavailable", reason: "lost" }),
      RESTORE_TIMEOUT_MS,
    );
  };
  const onRestored = () => {
    clearTimeout(timer);
    onChange({ status: "ok" });
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  return () => {
    clearTimeout(timer);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
  };
}
