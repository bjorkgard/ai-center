import { OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import { expect, test, vi } from "vite-plus/test";
import {
  ELEVATION_RANGE,
  ISO_AZIMUTH,
  ISO_ELEVATION,
  SEMANTIC_ZOOM,
  createCameraRig,
  zoomForDistance,
} from "../camera.ts";
import { SIGN, SIGN_CENTRE } from "./hallLayout.ts";
import { SignFader, letterMeasure, signVisible } from "./signVisibility.ts";

const size = { width: 1280, height: 720 };
const centre = new Vector3(...SIGN_CENTRE);
const NORMAL = new Vector3(0, 0, 1);

// The same two points the rule must use, projected here by the test itself.
function expectedMeasure(rig: ReturnType<typeof createCameraRig>) {
  const bottom = centre.clone().add(new Vector3(0, -SIGN.height / 2 + SIGN.baseline, 0));
  const top = bottom.clone().add(new Vector3(0, SIGN.nameCap, 0));
  const a = rig.project(bottom);
  const b = rig.project(top);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function expectedFacing(rig: ReturnType<typeof createCameraRig>) {
  const camera = rig.active;
  if (camera instanceof PerspectiveCamera) {
    return NORMAL.dot(camera.position.clone().sub(centre)) > 0;
  }
  return NORMAL.dot(camera.getWorldDirection(new Vector3()).negate()) > 0;
}

test("sweep: visibility is facing and a 12 px measure, in both projections", () => {
  const elevations = [
    ELEVATION_RANGE.min,
    ISO_ELEVATION,
    (ELEVATION_RANGE.min + ELEVATION_RANGE.max) / 2,
    ELEVATION_RANGE.max,
  ];
  let shown = 0;
  let hidden = 0;
  for (const projection of ["orthographic", "perspective"] as const) {
    for (const zoom of [20, SEMANTIC_ZOOM, 80, 160]) {
      for (const elevation of elevations) {
        for (let step = 0; step < 8; step++) {
          const rig = createCameraRig(size);
          rig.setFraming({
            target: new Vector3(0, 1, 0),
            zoom,
            azimuth: (step * Math.PI) / 4,
            elevation,
          });
          if (projection === "perspective") rig.toggle();
          const measure = expectedMeasure(rig);
          const want = expectedFacing(rig) && measure >= SIGN.minLetterPx;
          const label = `${projection} zoom ${zoom} elev ${elevation.toFixed(2)} az ${step * 45}`;
          expect(letterMeasure(rig, centre), label).toBeCloseTo(measure, 9);
          expect(signVisible(rig, centre, NORMAL), label).toBe(want);
          if (want) shown++;
          else hidden++;
        }
      }
    }
  }
  // The sweep covers both outcomes.
  expect(shown).toBeGreaterThan(10);
  expect(hidden).toBeGreaterThan(10);
});

test("a panel seen from behind is hidden at any zoom", () => {
  const rig = createCameraRig(size);
  rig.setFraming({ target: new Vector3(0, 1, 0), zoom: 200, azimuth: Math.PI * 1.25 });
  expect(signVisible(rig, centre, NORMAL)).toBe(false);
});

test("SEMANTIC_ZOOM puts the letter at 12 px at the isometric pose (ortho)", () => {
  const rig = createCameraRig(size);
  rig.setFraming({
    target: new Vector3(0, 1, 0),
    zoom: SEMANTIC_ZOOM,
    azimuth: ISO_AZIMUTH,
    elevation: ISO_ELEVATION,
  });
  expect(letterMeasure(rig, centre)).toBeCloseTo(SIGN.minLetterPx, 1);
});

test("in perspective the effective zoom is zoomForDistance at the target distance", () => {
  const rig = createCameraRig(size);
  rig.setFraming({ target: new Vector3(0, 1, 0), zoom: SEMANTIC_ZOOM });
  rig.toggle();
  const distance = rig.perspective.position.distanceTo(rig.framing.target);
  expect(zoomForDistance(distance, size.height)).toBeCloseTo(SEMANTIC_ZOOM, 6);
  // Near the iso pose the perspective measure is close to the orthographic 12 px.
  expect(Math.abs(letterMeasure(rig, centre) - SIGN.minLetterPx)).toBeLessThan(3);
});

test("the camera type the sweep builds is the real rig", () => {
  const rig = createCameraRig(size);
  expect(rig.ortho).toBeInstanceOf(OrthographicCamera);
});

test("the fader moves one panel from 1 to 0 over 200 ms and back", () => {
  const fader = new SignFader(3);
  fader.setTarget(0, true, 0, true);
  expect(fader.opacity(0)).toBe(1);
  fader.setTarget(0, false, 1000, false);
  fader.step(1000);
  expect(fader.opacity(0)).toBe(1);
  fader.step(1100);
  expect(fader.opacity(0)).toBeCloseTo(0.5, 6);
  expect(fader.step(1200)).toBe(false);
  expect(fader.opacity(0)).toBe(0);
  fader.setTarget(0, true, 1300, false);
  fader.step(1400);
  expect(fader.opacity(0)).toBeCloseTo(0.5, 6);
  // Other slots are untouched, and a snap skips the fade.
  expect(fader.opacity(1)).toBe(0);
  fader.setTarget(0, false, 1500, true);
  expect(fader.opacity(0)).toBe(0);
});

test("the visibility path allocates no Vector3 and reuses its scratch objects", () => {
  const rig = createCameraRig(size);
  rig.setFraming({ target: new Vector3(0, 1, 0), zoom: 80 });
  const clone = vi.spyOn(Vector3.prototype, "clone");
  const seen: { points: unknown[]; outs: unknown[] } = { points: [], outs: [] };
  const spy = {
    active: rig.active,
    project: (p: Vector3, out?: { x: number; y: number }) => {
      seen.points.push(p);
      seen.outs.push(out);
      return rig.project(p, out);
    },
  };
  for (let i = 0; i < 3; i++) signVisible(spy, centre, NORMAL);
  expect(clone).not.toHaveBeenCalled();
  // Two projected points and two outputs, the same objects on every call.
  expect(new Set(seen.points).size).toBe(2);
  expect(new Set(seen.outs).size).toBe(2);
  expect(seen.outs.every((o) => o !== undefined)).toBe(true);
  clone.mockRestore();
});

test("project(point, out) writes into out, and project(point) still returns a fresh object", () => {
  const rig = createCameraRig(size);
  const out = { x: 0, y: 0 };
  expect(rig.project(new Vector3(1, 0, 0), out)).toBe(out);
  const a = rig.project(new Vector3(1, 0, 0));
  expect(a).not.toBe(out);
  expect(a).toEqual(out);
});

test("the fader's per-frame calls create no closures (no Array.prototype.some)", () => {
  const fader = new SignFader(12);
  const some = vi.spyOn(Array.prototype, "some");
  fader.setTarget(0, true, 0, false);
  fader.step(10);
  expect(fader.animating).toBe(true);
  fader.setTarget(0, false, 20, false);
  fader.step(30);
  expect(some).not.toHaveBeenCalled();
  some.mockRestore();
});

test("the sign fade lasts 200 ms (design D7), pinned apart from the dev hook", () => {
  expect(SIGN.fadeMs).toBe(200);
});

test("the fader reports its own fade start and end: 200 ms apart for a full fade, on its own clock", () => {
  const fader = new SignFader(2);
  fader.setTarget(0, true, 1000, true);
  expect(fader.timing(0)).toEqual({ start: null, end: null });
  fader.setTarget(0, false, 5000, false);
  expect(fader.timing(0)).toEqual({ start: 5000, end: null });
  // Frames far apart: the end is still the fade's own, not the late frame's time.
  fader.step(5100);
  expect(fader.timing(0).end).toBeNull();
  fader.step(5600);
  const { start, end } = fader.timing(0);
  expect(start).toBe(5000);
  expect(end).toBeCloseTo(5200, 6);
  expect(fader.opacity(0)).toBe(0);
});

test("a panel that starts a fade while another is mid-fade measures its own 200 ms", () => {
  const fader = new SignFader(2);
  fader.setTarget(0, true, 1000, false);
  fader.step(1100);
  expect(fader.opacity(0)).toBeCloseTo(0.5, 6);
  // Slot 1 starts 80 ms after the last step; its first step is 20 ms into its own fade.
  fader.setTarget(1, true, 1180, false);
  fader.step(1200);
  expect(fader.opacity(1)).toBeCloseTo(0.1, 6);
  expect(fader.opacity(0)).toBe(1);
  fader.step(1380);
  expect(fader.opacity(1)).toBe(1);
  expect(fader.timing(1).end).toBeCloseTo(1380, 6);
});

test("a snap clears the slot's fade timing, so signFade never reports a previous fade", () => {
  const fader = new SignFader(1);
  fader.setTarget(0, true, 1000, false);
  fader.step(1300);
  expect(fader.timing(0).start).toBe(1000);
  expect(fader.timing(0).end).not.toBeNull();
  fader.setTarget(0, false, 2000, true);
  expect(fader.opacity(0)).toBe(0);
  expect(fader.timing(0)).toEqual({ start: null, end: null });
});

test("a panel that reverses mid-fade carries only the time since the reversal towards its new target", () => {
  const fader = new SignFader(1);
  fader.setTarget(0, true, 0, true);
  fader.setTarget(0, false, 0, false);
  fader.step(50);
  expect(fader.opacity(0)).toBeCloseTo(0.75, 6);
  fader.setTarget(0, true, 150, false);
  // The 100 ms before the reversal still fade out: 0.75 - 0.5 = 0.25, then 10 ms back up.
  fader.step(160);
  expect(fader.opacity(0)).toBeCloseTo(0.3, 6);
});
