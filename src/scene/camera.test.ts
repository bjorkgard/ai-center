import { expect, test, vi } from "vite-plus/test";
import { Vector3 } from "three";
import {
  ISO_ELEVATION,
  ORTHO_ZOOM,
  PERSPECTIVE_FOV,
  clampDistance,
  clampZoom,
  createCameraRig,
  distanceForZoom,
  perspectiveDistanceRange,
  zoomForDistance,
} from "./camera.ts";

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
  const rig = createCameraRig(size);
  const order: string[] = [];
  rig.setGlideCanceller(() => order.push("cancel"));
  rig.subscribe((camera) => order.push(camera.type));
  rig.toggle();
  expect(order).toEqual(["cancel", "PerspectiveCamera"]);
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
