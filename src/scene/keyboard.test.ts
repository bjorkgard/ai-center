import { Vector3 } from "three";
import { expect, test, vi } from "vite-plus/test";
import { createCameraRig, ORTHO_ZOOM } from "./camera.ts";
import {
  PAN_FRACTION,
  ROTATE_STEP,
  ZOOM_STEP,
  handleCameraKey,
  isTypingTarget,
  keyAction,
  nudgeFor,
  shouldHandle,
  type KeyDeps,
} from "./keyboard.ts";

const SAFE = { x: 0, y: 56, width: 904, height: 560 };

test("the key map: arrows pan, + = - zoom, Q and E rotate, 0 and Home go home, P switches", () => {
  expect(keyAction("ArrowLeft")).toEqual({ kind: "pan", right: -1, up: 0 });
  expect(keyAction("ArrowRight")).toEqual({ kind: "pan", right: 1, up: 0 });
  expect(keyAction("ArrowUp")).toEqual({ kind: "pan", right: 0, up: 1 });
  expect(keyAction("ArrowDown")).toEqual({ kind: "pan", right: 0, up: -1 });
  expect(keyAction("+")).toEqual({ kind: "zoom", factor: 1.25 });
  expect(keyAction("=")).toEqual({ kind: "zoom", factor: 1.25 });
  expect(keyAction("-")).toEqual({ kind: "zoom", factor: 1 / 1.25 });
  expect(keyAction("q")).toEqual({ kind: "rotate", angle: Math.PI / 4 });
  expect(keyAction("E")).toEqual({ kind: "rotate", angle: -Math.PI / 4 });
  expect(keyAction("0")).toEqual({ kind: "home" });
  expect(keyAction("Home")).toEqual({ kind: "home" });
  expect(keyAction("p")).toEqual({ kind: "projection" });
  expect(keyAction("P")).toEqual({ kind: "projection" });
  for (const other of ["a", "w", "Enter", " ", "Escape", "1", "Tab"]) {
    expect(keyAction(other)).toBeNull();
  }
});

const key = (over: Partial<Parameters<typeof shouldHandle>[0]> = {}) => ({
  key: "ArrowLeft",
  target: canvas,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...over,
});
const canvas = { tagName: "CANVAS" };

test("the focus gate: only keys aimed at the canvas, never typing in a field, never a shortcut", () => {
  expect(shouldHandle(key(), canvas)).toBe(true);
  expect(shouldHandle(key({ target: { tagName: "BUTTON" } }), canvas)).toBe(false);
  expect(shouldHandle(key({ target: null }), canvas)).toBe(false);
  for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) {
    const field = { tagName };
    expect(isTypingTarget(field)).toBe(true);
    expect(shouldHandle(key({ target: field }), field)).toBe(false);
  }
  const editable = { tagName: "DIV", isContentEditable: true };
  expect(shouldHandle(key({ target: editable }), editable)).toBe(false);
  expect(shouldHandle(key({ ctrlKey: true }), canvas)).toBe(false);
  expect(shouldHandle(key({ metaKey: true }), canvas)).toBe(false);
  expect(shouldHandle(key({ altKey: true }), canvas)).toBe(false);
});

test("step sizes: an arrow pans 10% of the shorter safeArea side, + zooms by x1.25, Q rotates 45 degrees", () => {
  expect(PAN_FRACTION).toBe(0.1);
  expect(ZOOM_STEP).toBe(1.25);
  expect(ROTATE_STEP).toBeCloseTo(Math.PI / 4, 12);
  expect(nudgeFor({ kind: "pan", right: 1, up: 0 }, SAFE)).toEqual({ pan: { right: 56, up: 0 } });
  expect(nudgeFor({ kind: "pan", right: 0, up: -1 }, SAFE)).toEqual({ pan: { right: 0, up: -56 } });
  const tall = { x: 0, y: 0, width: 300, height: 900 };
  expect(nudgeFor({ kind: "pan", right: -1, up: 0 }, tall)).toEqual({ pan: { right: -30, up: 0 } });
  expect(nudgeFor({ kind: "zoom", factor: 1.25 }, SAFE)).toEqual({ zoomFactor: 1.25 });
  expect(nudgeFor({ kind: "home" }, SAFE)).toBeNull();
});

function setup(reduced = false) {
  const clock = { t: 0 };
  const rig = createCameraRig(
    { width: 1280, height: 720 },
    { now: () => clock.t, reducedMotion: () => reduced },
  );
  rig.setSafeArea(SAFE);
  const deps: KeyDeps = { rig, safeArea: () => SAFE, stepMs: () => 250 };
  const press = (k: string) => handleCameraKey(keyAction(k)!, deps);
  const run = (to: number) => {
    clock.t = to;
    rig.step(to);
  };
  return { rig, press, run, clock };
}

test("one arrow press moves the picture by 10% of the shorter safeArea side on screen", () => {
  const { rig, press, run } = setup();
  const probe = new Vector3(0, 0, 0);
  const before = rig.project(probe);
  press("ArrowRight");
  run(250);
  const right = rig.project(probe);
  // The view moves right, so the picture moves left.
  expect(before.x - right.x).toBeCloseTo(0.1 * SAFE.height, 3);
  expect(right.y).toBeCloseTo(before.y, 3);
  press("ArrowUp");
  run(500);
  const up = rig.project(probe);
  expect(up.y - right.y).toBeCloseTo(0.1 * SAFE.height, 3);
});

test("one + press zooms by x1.25 over --dur-ui and - undoes it", () => {
  const { rig, press, run } = setup();
  const zoom = rig.framing.zoom;
  press("+");
  run(125);
  expect(rig.framing.zoom).toBeGreaterThan(zoom);
  expect(rig.framing.zoom).toBeLessThan(zoom * 1.25);
  run(250);
  expect(rig.framing.zoom).toBeCloseTo(zoom * 1.25, 6);
  press("-");
  run(500);
  expect(rig.framing.zoom).toBeCloseTo(zoom, 6);
  press("=");
  run(750);
  expect(rig.framing.zoom).toBeCloseTo(zoom * 1.25, 6);
});

test("Q and E rotate the view 45 degrees", () => {
  const { rig, press, run } = setup();
  const azimuth = rig.framing.azimuth;
  press("q");
  run(250);
  expect(rig.framing.azimuth - azimuth).toBeCloseTo(Math.PI / 4, 6);
  press("e");
  run(500);
  expect(rig.framing.azimuth).toBeCloseTo(azimuth, 6);
});

test("0 and Home glide home, P toggles the projection", () => {
  const { rig, press, run } = setup();
  rig.setFraming({ target: new Vector3(5, 0, 5), zoom: 200 });
  press("0");
  expect(rig.animating).toBe(true);
  run(600);
  // The campus centre sits at the centre of the safeArea.
  const centre = rig.project(new Vector3(0, 0, 0));
  expect(centre.x).toBeCloseTo(SAFE.x + SAFE.width / 2, 0);
  expect(centre.y).toBeCloseTo(SAFE.y + SAFE.height / 2, 0);
  expect(rig.framing.zoom).toBeLessThan(200);
  press("p");
  expect(rig.projection).toBe("perspective");
  press("P");
  expect(rig.projection).toBe("orthographic");
});

test("a held key restarts each step from the current animated position and nothing queues", () => {
  const { rig, press, run } = setup();
  const probe = new Vector3(0, 0, 0);
  const start = rig.project(probe).x;
  press("ArrowRight");
  run(30);
  const mid = rig.project(probe).x;
  expect(start - mid).toBeGreaterThan(0);
  press("ArrowRight");
  // The second step began at `mid`, so its end is one step beyond mid, not beyond the first end.
  run(30 + 250);
  const end = rig.project(probe).x;
  expect(mid - end).toBeCloseTo(0.1 * SAFE.height, 3);
  expect(rig.animating).toBe(false);
  // Nothing was left over: further time changes nothing.
  run(2000);
  expect(rig.project(probe).x).toBeCloseTo(end, 9);
});

test("under reduced motion a key step is an instant cut", () => {
  const { rig, press } = setup(true);
  const zoom = rig.framing.zoom;
  press("+");
  expect(rig.animating).toBe(false);
  expect(rig.framing.zoom).toBeCloseTo(zoom * 1.25, 6);
  const probe = new Vector3(0, 0, 0);
  const before = rig.project(probe).x;
  press("ArrowLeft");
  expect(rig.project(probe).x).toBeGreaterThan(before);
});

test("keys keep the camera inside the bounds and the zoom range", () => {
  const { rig, press } = setup(true);
  for (let i = 0; i < 200; i++) {
    for (const k of ["ArrowRight", "ArrowUp", "+", "q"]) press(k);
  }
  expect(Math.abs(rig.framing.target.x)).toBeLessThanOrEqual(14 + 1e-9);
  expect(Math.abs(rig.framing.target.z)).toBeLessThanOrEqual(14 + 1e-9);
  expect(rig.framing.zoom).toBe(ORTHO_ZOOM.max);
  for (let i = 0; i < 200; i++) press("-");
  expect(rig.framing.zoom).toBe(ORTHO_ZOOM.min);
});

test("a key press wakes the loop through the rig motion signal", () => {
  const { rig, press } = setup();
  const woke = vi.fn();
  rig.onMotion(woke);
  press("ArrowLeft");
  expect(woke).toHaveBeenCalledTimes(1);
});
