import { expect, test, vi } from "vite-plus/test";
import { Vector3 } from "three";
import {
  ISO_AZIMUTH,
  ISO_ELEVATION,
  ORTHO_ZOOM,
  PERSPECTIVE_FOV,
  SEMANTIC_ZOOM,
  clampDistance,
  clampZoom,
  createCameraRig,
  distanceForZoom,
  perspectiveDistanceRange,
  zoomForDistance,
} from "./camera.ts";
import { FIXTURE_CAMPUS } from "./cameraFixture.ts";
import { CAMPUS_EXTENT, HOME_HEIGHT, campusBounds, campusHome } from "./campus/layout.ts";

const size = { width: 1280, height: 720 };

test("the default camera sits on the true isometric diagonal", () => {
  const rig = createCameraRig(size);
  const dir = rig.active.position.clone().sub(rig.framing.target).normalize();
  const s = 1 / Math.sqrt(3);
  expect(dir.x).toBeCloseTo(s, 6);
  expect(dir.y).toBeCloseTo(s, 6);
  expect(dir.z).toBeCloseTo(s, 6);
  expect(ISO_ELEVATION).toBeCloseTo(Math.atan(1 / Math.SQRT2), 9);
  expect(rig.projection).toBe("orthographic");
});

test("zoom and distance convert both ways at the same visible height", () => {
  const d = distanceForZoom(40, 720);
  expect(zoomForDistance(d, 720)).toBeCloseTo(40, 9);
  const visible = 2 * d * Math.tan((PERSPECTIVE_FOV * Math.PI) / 360);
  expect(visible).toBeCloseTo(720 / 40, 9);
});

test("the perspective distance range matches the ortho zoom range", () => {
  const range = perspectiveDistanceRange(720);
  expect(range.min).toBeCloseTo(distanceForZoom(ORTHO_ZOOM.max, 720), 9);
  expect(range.max).toBeCloseTo(distanceForZoom(ORTHO_ZOOM.min, 720), 9);
  expect(clampZoom(1e6)).toBe(ORTHO_ZOOM.max);
  expect(clampZoom(0)).toBe(ORTHO_ZOOM.min);
  expect(clampDistance(1e6, 720)).toBeCloseTo(range.max, 9);
  expect(clampDistance(0, 720)).toBeCloseTo(range.min, 9);
});

test("toggling keeps the framing: same screen position and size for a point at the target", () => {
  const rig = createCameraRig(size);
  const project = (p: Vector3) => p.clone().project(rig.active);
  // A point one unit right of the target in screen space, on the target plane.
  const right = new Vector3().setFromMatrixColumn(rig.active.matrixWorld, 0);
  const a = new Vector3(0, 0, 0).add(right);
  rig.active.updateMatrixWorld(true);
  const orthoAt = project(a);
  const orthoCentre = project(new Vector3(0, 0, 0));
  rig.toggle();
  expect(rig.projection).toBe("perspective");
  rig.active.updateMatrixWorld(true);
  const persAt = project(a);
  const persCentre = project(new Vector3(0, 0, 0));
  expect(persCentre.x).toBeCloseTo(orthoCentre.x, 6);
  expect(persCentre.y).toBeCloseTo(orthoCentre.y, 6);
  expect(persAt.x).toBeCloseTo(orthoAt.x, 3);
  expect(persAt.y).toBeCloseTo(orthoAt.y, 3);
});

test("toggling twice returns the same zoom", () => {
  const rig = createCameraRig(size);
  const zoom = rig.framing.zoom;
  rig.toggle();
  rig.toggle();
  expect(rig.projection).toBe("orthographic");
  expect(rig.framing.zoom).toBeCloseTo(zoom, 9);
});

test("a toggle cancels a glide in flight before switching and notifies listeners", () => {
  let clock = 0;
  const rig = createCameraRig(size, { now: () => clock });
  rig.glideTo(new Vector3(5, 0, 0), 120);
  expect(rig.animating).toBe(true);
  const order: string[] = [];
  rig.subscribe((camera) => order.push(`${camera.type} animating=${rig.animating}`));
  rig.toggle();
  expect(order).toEqual(["PerspectiveCamera animating=false"]);
  clock = 1000;
  expect(rig.step(clock)).toBe(false);
});

test("perspective distance stays inside the matching range after a toggle at the zoom limits", () => {
  const rig = createCameraRig(size);
  rig.setFraming({ zoom: ORTHO_ZOOM.max * 10 });
  expect(rig.framing.zoom).toBe(ORTHO_ZOOM.max);
  rig.toggle();
  const distance = rig.active.position.distanceTo(rig.framing.target);
  expect(distance).toBeCloseTo(perspectiveDistanceRange(720).min, 6);
});

test("resizing updates the active camera frustum", () => {
  const rig = createCameraRig(size);
  const update = vi.spyOn(rig.active, "updateProjectionMatrix");
  rig.setViewport({ width: 800, height: 600 });
  expect(update).toHaveBeenCalled();
});

// A glide to `point` ends with `point` at the centre of the safeArea (CEO S-RW37/38 live here).
function rigAt(
  options: {
    safe?: { x: number; y: number; width: number; height: number };
    reduced?: boolean;
  } = {},
) {
  const clock = { t: 0 };
  const warn = vi.fn();
  const rig = createCameraRig(size, {
    now: () => clock.t,
    reducedMotion: () => options.reduced ?? false,
    warn,
  });
  rig.setCampus(FIXTURE_CAMPUS);
  if (options.safe) {
    rig.setSafeArea(options.safe);
    rig.setHomeArea(options.safe);
  }
  const run = (to: number) => {
    clock.t = to;
    return rig.step(to);
  };
  return { rig, clock, run, warn };
}

const centreOf = (r: { x: number; y: number; width: number; height: number }) => ({
  x: r.x + r.width / 2,
  y: r.y + r.height / 2,
});
const SAFE = { x: 0, y: 56, width: 904, height: 560 };

test("glideTo takes about 600 ms with the D20 easing and ends on the target", () => {
  const { rig, run } = rigAt();
  const from = rig.framing.target.clone();
  rig.glideTo(new Vector3(6, 0, -4), 120);
  expect(rig.animating).toBe(true);
  expect(run(60)).toBe(true);
  const early = rig.framing.target.distanceTo(from);
  // Ease-out: well past a linear 10% of the way after 10% of the time.
  expect(early).toBeGreaterThan(0.25 * from.distanceTo(new Vector3(6, 0, -4)));
  expect(run(599)).toBe(true);
  expect(rig.animating).toBe(true);
  expect(run(600)).toBe(true);
  expect(rig.animating).toBe(false);
  expect(rig.framing.zoom).toBeCloseTo(120, 6);
  expect(run(700)).toBe(false);
});

test("a glide ends with its target at the centre of the safeArea, in ortho and perspective", () => {
  for (const toggle of [false, true]) {
    const { rig, run } = rigAt({ safe: SAFE });
    if (toggle) rig.toggle();
    const target = new Vector3(5, 0, -3);
    rig.glideTo(target, 110);
    run(600);
    const at = rig.project(target);
    const centre = centreOf(SAFE);
    expect(at.x).toBeCloseTo(centre.x, 0);
    expect(at.y).toBeCloseTo(centre.y, 0);
  }
});

test("opening the right panel during a glide still ends with the target inside the new safeArea", () => {
  const { rig, clock, run } = rigAt({ safe: { x: 0, y: 56, width: 1280, height: 560 } });
  const target = new Vector3(6, 0, 2);
  rig.glideTo(target, 120);
  run(200);
  expect(rig.animating).toBe(true);
  rig.setSafeArea(SAFE);
  for (let t = 200; t <= 1400; t += 16) run(t);
  expect(clock.t).toBeGreaterThan(1000);
  expect(rig.animating).toBe(false);
  const at = rig.project(target);
  expect(at.x).toBeGreaterThan(SAFE.x);
  expect(at.x).toBeLessThan(SAFE.x + SAFE.width);
  expect(at.x).toBeCloseTo(centreOf(SAFE).x, 0);
  expect(at.y).toBeCloseTo(centreOf(SAFE).y, 0);
});

test("a safeArea change after the glide ended does not move the camera", () => {
  const { rig, run } = rigAt();
  rig.glideTo(new Vector3(3, 0, 3), 100);
  run(600);
  const settled = rig.framing.target.clone();
  rig.setSafeArea(SAFE);
  expect(rig.animating).toBe(false);
  expect(rig.framing.target.distanceTo(settled)).toBe(0);
});

test("an empty safeArea falls back to the full canvas with one console warning", () => {
  const { rig, run, warn } = rigAt({ safe: { x: 0, y: 0, width: 0, height: 0 } });
  const target = new Vector3(4, 0, 4);
  rig.glideTo(target, 100);
  run(600);
  rig.glideTo(new Vector3(-4, 0, 4), 100);
  run(1200);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain("safe area");
  const at = rig.project(new Vector3(-4, 0, 4));
  expect(at.x).toBeCloseTo(size.width / 2, 0);
  expect(at.y).toBeCloseTo(size.height / 2, 0);
});

test("under reduced motion a glide is an instant cut", () => {
  const { rig } = rigAt({ reduced: true, safe: SAFE });
  const target = new Vector3(5, 0, 5);
  rig.glideTo(target, 130);
  expect(rig.animating).toBe(false);
  expect(rig.framing.zoom).toBeCloseTo(130, 6);
  expect(rig.project(target).x).toBeCloseTo(centreOf(SAFE).x, 0);
});

// The safeArea the shell measures at the smallest supported window, 1280x720 (docs/PLAN.md:497).
const SAFE_1280 = { x: 0, y: 192, width: 1280, height: 352 };

for (const projection of ["orthographic", "perspective"] as const) {
  test(`home frames all eight campus corners inside the safeArea at 1280x720 (${projection})`, () => {
    const { rig, run } = rigAt({ safe: SAFE_1280 });
    if (projection === "perspective") rig.toggle();
    rig.setFraming({ azimuth: 1, elevation: 0.8, target: new Vector3(7, 0, 7), zoom: 200 });
    rig.home();
    run(600);
    expect(rig.framing.azimuth).toBeCloseTo(ISO_AZIMUTH, 6);
    expect(rig.framing.elevation).toBeCloseTo(ISO_ELEVATION, 6);
    expect(rig.framing.zoom).toBeGreaterThan(ORTHO_ZOOM.min);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (const y of [0, FIXTURE_CAMPUS.bounds.maxY]) {
          const p = rig.project(
            new Vector3(sx * FIXTURE_CAMPUS.bounds.halfX, y, sz * FIXTURE_CAMPUS.bounds.halfZ),
          );
          expect(p.x).toBeGreaterThan(SAFE_1280.x + 8);
          expect(p.x).toBeLessThan(SAFE_1280.x + SAFE_1280.width - 8);
          expect(p.y).toBeGreaterThan(SAFE_1280.y + 8);
          expect(p.y).toBeLessThan(SAFE_1280.y + SAFE_1280.height - 8);
        }
      }
    }
  });
}

// A narrow safeArea makes the width the binding side, where each corner's own projection counts.
const SAFE_NARROW = { x: 300, y: 0, width: 500, height: 720 };

for (const projection of ["orthographic", "perspective"] as const) {
  test(`home keeps all eight campus corners inside the margin of a narrow safeArea (${projection})`, () => {
    const { rig, run } = rigAt({ safe: SAFE_NARROW });
    if (projection === "perspective") rig.toggle();
    rig.home();
    run(600);
    const slack = (1 - 0.92) / 2;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (const y of [0, FIXTURE_CAMPUS.bounds.maxY]) {
          const p = rig.project(
            new Vector3(sx * FIXTURE_CAMPUS.bounds.halfX, y, sz * FIXTURE_CAMPUS.bounds.halfZ),
          );
          expect(p.x).toBeGreaterThanOrEqual(SAFE_NARROW.x + SAFE_NARROW.width * slack - 0.5);
          expect(p.x).toBeLessThanOrEqual(SAFE_NARROW.x + SAFE_NARROW.width * (1 - slack) + 0.5);
          expect(p.y).toBeGreaterThanOrEqual(SAFE_NARROW.y + SAFE_NARROW.height * slack - 0.5);
          expect(p.y).toBeLessThanOrEqual(SAFE_NARROW.y + SAFE_NARROW.height * (1 - slack) + 0.5);
        }
      }
    }
  });
}

test("cancelGlide stops the glide where it is", () => {
  const { rig, run } = rigAt();
  rig.glideTo(new Vector3(8, 0, 0), 150);
  run(200);
  const mid = rig.framing.target.clone();
  rig.cancelGlide();
  expect(rig.animating).toBe(false);
  expect(run(600)).toBe(false);
  expect(rig.framing.target.distanceTo(mid)).toBe(0);
});

test("a glide and a nudge announce themselves so the loop leaves calm mode", () => {
  const { rig } = rigAt();
  const woke = vi.fn();
  rig.onMotion(woke);
  rig.glideTo(new Vector3(1, 0, 1), 90);
  rig.nudge({ zoomFactor: 1.25 }, 250);
  expect(woke).toHaveBeenCalledTimes(2);
});

test("a nudge never leaves the campus bounds or the zoom range", () => {
  const { rig, run } = rigAt({ reduced: true });
  for (let i = 0; i < 80; i++) rig.nudge({ pan: { right: 400, up: 400 }, zoomFactor: 1.25 }, 250);
  expect(Math.abs(rig.framing.target.x)).toBeLessThanOrEqual(FIXTURE_CAMPUS.bounds.halfX + 1e-9);
  expect(Math.abs(rig.framing.target.z)).toBeLessThanOrEqual(FIXTURE_CAMPUS.bounds.halfZ + 1e-9);
  expect(rig.framing.zoom).toBe(ORTHO_ZOOM.max);
  expect(run(10)).toBe(false);
});

test("SEMANTIC_ZOOM is inside the zoom range and the 12 px letter zoom at the isometric pose", () => {
  expect(SEMANTIC_ZOOM).toBeGreaterThanOrEqual(ORTHO_ZOOM.min);
  expect(SEMANTIC_ZOOM).toBeLessThanOrEqual(ORTHO_ZOOM.max);
  // A vertical 0.28-unit capital projects to 0.28 x cos(elevation) x zoom pixels.
  expect(0.28 * Math.cos(ISO_ELEVATION) * SEMANTIC_ZOOM).toBeCloseTo(12, 6);
});

test("setCampus bounds are read at call time by clampTarget and by a glide", () => {
  const { rig, run } = rigAt({ reduced: true });
  rig.setCampus({
    bounds: { halfX: 40, halfZ: 30, maxY: 3 },
    home: { minX: -40, maxX: 40, minZ: -30, maxZ: 30, maxY: 3 },
  });
  const clamped = rig.clampTarget(new Vector3(100, 9, -100));
  expect([clamped.x, clamped.y, clamped.z]).toEqual([40, 3, -30]);
  rig.glideTo(new Vector3(35, 0, 25), 100);
  run(600);
  expect(rig.framing.target.x).toBeCloseTo(35, 3);
  expect(rig.framing.target.z).toBeCloseTo(25, 3);
  rig.setCampus(FIXTURE_CAMPUS);
  expect(rig.clampTarget(new Vector3(35, 0, 25)).x).toBe(14);
});

test("a zero-size or NaN campus keeps the previous bounds and warns once per call", () => {
  const { rig, warn } = rigAt({ reduced: true });
  const bad = [
    { bounds: { halfX: 0, halfZ: 14, maxY: 3 }, home: FIXTURE_CAMPUS.home },
    { bounds: { halfX: Number.NaN, halfZ: 14, maxY: 3 }, home: FIXTURE_CAMPUS.home },
    { bounds: FIXTURE_CAMPUS.bounds, home: { minX: 5, maxX: 5, minZ: -1, maxZ: 1, maxY: 3 } },
    { bounds: FIXTURE_CAMPUS.bounds, home: { ...FIXTURE_CAMPUS.home, maxZ: Number.NaN } },
  ];
  bad.forEach((campus, i) => {
    rig.setCampus(campus);
    expect(warn).toHaveBeenCalledTimes(i + 1);
    expect(String(warn.mock.calls[i][0])).toContain("[camera]");
    expect(rig.clampTarget(new Vector3(99, 0, 99)).x).toBe(14);
  });
});

const layoutCampus = (placed: number) => ({
  bounds: campusBounds(),
  home: campusHome(placed),
});

// The home area at each supported window (decision H1): the canvas minus the 56 px top bar and
// the 48 px tab strip.
const SAFE_AREAS = {
  "1280x720": {
    size: { width: 1280, height: 720 },
    safe: { x: 0, y: 56, width: 1280, height: 616 },
  },
  "1920x1080": {
    size: { width: 1920, height: 1080 },
    safe: { x: 0, y: 56, width: 1920, height: 968 },
  },
} as const;

for (const [name, { size: viewport, safe }] of Object.entries(SAFE_AREAS)) {
  for (const projection of ["orthographic", "perspective"] as const) {
    test(`home frames the placed halls, plant, power and gate inside the safeArea at ${name} (${projection})`, () => {
      const clock = { t: 0 };
      const rig = createCameraRig(viewport, { now: () => clock.t });
      rig.setCampus(layoutCampus(2));
      rig.setSafeArea(safe);
      rig.setHomeArea(safe);
      if (projection === "perspective") rig.toggle();
      rig.home(0);
      expect(rig.animating).toBe(false);
      expect(rig.framing.zoom).toBeGreaterThan(ORTHO_ZOOM.min);
      const box = campusHome(2);
      for (const x of [box.minX, box.maxX]) {
        for (const z of [box.minZ, box.maxZ]) {
          for (const y of [0, box.maxY]) {
            const p = rig.project(new Vector3(x, y, z));
            expect(p.x, `${x},${y},${z}`).toBeGreaterThan(safe.x);
            expect(p.x).toBeLessThan(safe.x + safe.width);
            expect(p.y).toBeGreaterThan(safe.y);
            expect(p.y).toBeLessThan(safe.y + safe.height);
          }
        }
      }
    });
  }
}

test("the whole campus fits the smallest home area above the minimum zoom, so a home fit is never clamped", () => {
  const rig = createCameraRig(SAFE_AREAS["1280x720"].size);
  rig.setHomeArea({ x: 0, y: 56, width: 1280, height: 616 });
  rig.setCampus({
    bounds: campusBounds(),
    home: { ...CAMPUS_EXTENT, maxY: HOME_HEIGHT },
  });
  rig.home(0);
  expect(rig.framing.zoom).toBeGreaterThan(ORTHO_ZOOM.min);
  rig.toggle();
  rig.home(0);
  expect(rig.framing.zoom).toBeGreaterThan(ORTHO_ZOOM.min);
});

for (const [name, { size: viewport, safe }] of Object.entries(SAFE_AREAS)) {
  test(`placing a third hall widens the next home() at ${name}, and does not move the camera until then`, () => {
    const rig = createCameraRig(viewport, { reducedMotion: () => true });
    rig.setSafeArea(safe);
    rig.setHomeArea(safe);
    rig.setCampus(layoutCampus(2));
    rig.home(0);
    const two = { zoom: rig.framing.zoom, target: rig.framing.target.clone() };
    rig.setCampus(layoutCampus(3));
    expect(rig.framing.zoom).toBe(two.zoom);
    expect(rig.framing.target.distanceTo(two.target)).toBe(0);
    rig.home(0);
    expect(rig.framing.zoom).toBeLessThan(two.zoom);
    // The widened frame still fits: the third hall's far corner is inside the safeArea.
    const hall = campusHome(3);
    const p = rig.project(new Vector3(hall.maxX, 0, hall.minZ));
    expect(p.x).toBeLessThan(safe.x + safe.width);
    expect(p.y).toBeGreaterThan(safe.y);
  });
}

test("home with no campus set frames the default box, as before", () => {
  const rig = createCameraRig(size, { reducedMotion: () => true });
  rig.home();
  expect(rig.framing.zoom).toBeGreaterThan(ORTHO_ZOOM.min);
  expect(rig.framing.azimuth).toBeCloseTo(ISO_AZIMUTH, 9);
});

// Decision H1: home and the startup view fit the canvas minus the top bar and tab strip; the
// panels float over the campus. A glide to an object still uses the safeArea.
const HOME_AREA = { x: 0, y: 56, width: 1280, height: 616 };

for (const projection of ["orthographic", "perspective"] as const) {
  test(`home fits the placed campus into the home area, not the safeArea (${projection})`, () => {
    const rig = createCameraRig(size, { reducedMotion: () => true });
    rig.setCampus({ bounds: campusBounds(), home: campusHome(2) });
    rig.setSafeArea(SAFE);
    rig.setHomeArea(HOME_AREA);
    if (projection === "perspective") rig.toggle();
    rig.home(0);
    const box = campusHome(2);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const x of [box.minX, box.maxX]) {
      for (const z of [box.minZ, box.maxZ]) {
        for (const y of [0, box.maxY]) {
          const p = rig.project(new Vector3(x, y, z));
          xs.push(p.x);
          ys.push(p.y);
          expect(p.y).toBeGreaterThan(HOME_AREA.y);
          expect(p.y).toBeLessThan(HOME_AREA.y + HOME_AREA.height);
        }
      }
    }
    // Centred across the 1280 px home area (640), not the 904 px safeArea (452).
    expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2 - 640)).toBeLessThan(40);
    if (projection === "orthographic") {
      // Taller than the 560 px safeArea, which a fit into the safeArea (92% of it) cannot be.
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(SAFE.height);
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(
        HOME_AREA.y + HOME_AREA.height / 2,
        0,
      );
    }
  });
}

test("a glide still centres its target in the safeArea while home uses the home area", () => {
  const { rig, run } = rigAt({ safe: SAFE });
  rig.setHomeArea(HOME_AREA);
  const target = new Vector3(5, 0, -3);
  rig.glideTo(target, 110);
  run(600);
  expect(rig.project(target).y).toBeCloseTo(centreOf(SAFE).y, 0);
});

test("the perspective far plane stays beyond the campus at the tallest window and the widest zoom-out", () => {
  const rig = createCameraRig({ width: 2560, height: 1440 });
  rig.setCampus({ bounds: campusBounds(), home: campusHome(2) });
  rig.toggle();
  rig.setFraming({ zoom: ORTHO_ZOOM.min, target: new Vector3(0, 0, 0) });
  const camera = rig.active;
  const { halfX, halfZ } = campusBounds();
  let farthest = 0;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      farthest = Math.max(
        farthest,
        camera.position.distanceTo(new Vector3(sx * halfX, 0, sz * halfZ)),
      );
    }
  }
  expect(rig.projection).toBe("perspective");
  expect((camera as import("three").PerspectiveCamera).far).toBeGreaterThan(farthest);
});
