import type { SafeArea } from "../app/store/ui.ts";
import type { CameraRig, Nudge } from "./camera.ts";

// Step sizes (design-review DR13) [estimated].
export const PAN_FRACTION = 0.1; // of the safeArea's shorter side
export const ZOOM_STEP = 1.25;
export const ROTATE_STEP = Math.PI / 4;

export type KeyAction =
  | { kind: "pan"; right: -1 | 0 | 1; up: -1 | 0 | 1 }
  | { kind: "zoom"; factor: number }
  | { kind: "rotate"; angle: number }
  | { kind: "home" }
  | { kind: "projection" };

// The camera key map (CEO C19): arrows pan, + and - zoom, Q and E rotate, 0 and Home go
// home, P switches projection. `=` is the unshifted `+` key.
export function keyAction(key: string): KeyAction | null {
  switch (key) {
    case "ArrowLeft":
      return { kind: "pan", right: -1, up: 0 };
    case "ArrowRight":
      return { kind: "pan", right: 1, up: 0 };
    case "ArrowUp":
      return { kind: "pan", right: 0, up: 1 };
    case "ArrowDown":
      return { kind: "pan", right: 0, up: -1 };
    case "+":
    case "=":
      return { kind: "zoom", factor: ZOOM_STEP };
    case "-":
      return { kind: "zoom", factor: 1 / ZOOM_STEP };
    case "q":
    case "Q":
      return { kind: "rotate", angle: ROTATE_STEP };
    case "e":
    case "E":
      return { kind: "rotate", angle: -ROTATE_STEP };
    case "0":
    case "Home":
      return { kind: "home" };
    case "p":
    case "P":
      return { kind: "projection" };
    default:
      return null;
  }
}

export interface KeyEventLike {
  key: string;
  target: unknown;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function isTypingTarget(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return !!el && (TYPING_TAGS.has(el.tagName ?? "") || el.isContentEditable === true);
}

// The focus gate: only a key aimed at the canvas itself, never one typed into a field and
// never a browser shortcut such as Ctrl+= or Cmd+0.
export function shouldHandle(event: KeyEventLike, canvas: unknown): boolean {
  if (event.target !== canvas || isTypingTarget(event.target)) return false;
  return !(event.ctrlKey || event.metaKey || event.altKey);
}

// What one press asks of the rig: a pan is a fraction of the safeArea's shorter side in screen
// pixels, the rig turns it into ground units at the current zoom.
export function nudgeFor(action: KeyAction, safeArea: SafeArea): Nudge | null {
  switch (action.kind) {
    case "pan": {
      const px = PAN_FRACTION * Math.min(safeArea.width, safeArea.height);
      return { pan: { right: action.right * px, up: action.up * px } };
    }
    case "zoom":
      return { zoomFactor: action.factor };
    case "rotate":
      return { rotate: action.angle };
    default:
      return null;
  }
}

export interface KeyDeps {
  rig: CameraRig;
  safeArea(): SafeArea;
  // The --dur-ui step duration in ms; the rig makes it instant under reduced motion.
  stepMs(): number;
}

export function handleCameraKey(action: KeyAction, deps: KeyDeps): void {
  const { rig } = deps;
  if (action.kind === "home") rig.home();
  else if (action.kind === "projection") rig.toggle();
  else {
    const area = deps.safeArea();
    const usable = area.width > 0 && area.height > 0 ? area : { ...area, ...rig.viewport };
    const nudge = nudgeFor(action, usable);
    if (nudge) rig.nudge(nudge, deps.stepMs());
  }
}

export const CANVAS_LABEL = "3D campus view";

// Makes the canvas a focusable application (CEO C19, DR12, DR15) and listens on it, so only a
// focused canvas gets the keys. `helpId` is the hidden text that describes them. Returns the
// detach function, which also undoes the attributes.
export function attachCameraKeys(canvas: HTMLElement, deps: KeyDeps, helpId: string): () => void {
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "application");
  canvas.setAttribute("aria-label", CANVAS_LABEL);
  canvas.setAttribute("aria-describedby", helpId);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!shouldHandle(event, canvas)) return;
    const action = keyAction(event.key);
    if (!action) return;
    event.preventDefault();
    handleCameraKey(action, deps);
  };
  canvas.addEventListener("keydown", onKeyDown);
  return () => {
    canvas.removeEventListener("keydown", onKeyDown);
    for (const name of ["tabindex", "role", "aria-label", "aria-describedby"]) {
      canvas.removeAttribute(name);
    }
  };
}
