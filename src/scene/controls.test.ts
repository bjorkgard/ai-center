import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from "three";
import { expect, test, vi } from "vite-plus/test";
import {
  CAMPUS_BOUNDS,
  ELEVATION_RANGE,
  ORTHO_ZOOM,
  createCameraRig,
  perspectiveDistanceRange,
} from "./camera.ts";
import {
  DAMPING_SETTLE_MS,
  createCameraControls,
  stepCamera,
  wakeOnRigMotion,
} from "./controls.ts";
import { CALM_AFTER_MS, createRenderDriver } from "./loop/driver.ts";
import { createFakeEnv } from "./loop/fakeEnv.ts";

const W = 1280;
const H = 720;
const FRAME_MS = 1000 / 60;

class FakeDocument extends EventTarget {}

// The few DOM members MapControls touches, so the real controls run in the node test environment.
class FakeCanvas extends EventTarget {
  style: Record<string, string> = {};
  clientWidth = W;
  clientHeight = H;
  ownerDocument = new FakeDocument();
  getRootNode() {
    return this.ownerDocument;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: W, height: H };
  }
  setPointerCapture() {}
  releasePointerCapture() {}
}

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), props);
  target.dispatchEvent(event);
  return event;
}

function setup(options: { reduced?: boolean; perspective?: boolean } = {}) {
  const clock = { t: 0 };
  const rig = createCameraRig(
    { width: W, height: H },
    { now: () => clock.t, reducedMotion: () => options.reduced ?? false },
  );
  const canvas = new FakeCanvas();
  const onChange = vi.fn();
  const controls = createCameraControls(rig, canvas as unknown as HTMLElement, {
    reducedMotion: () => options.reduced ?? false,
    onChange,
  });
  if (options.perspective) {
    rig.toggle();
    controls.syncLimits();
  }
  const mouse = {
    down: (x: number, y: number, button = 0) =>
      fire(canvas, "pointerdown", {
        pointerId: 1,
        pointerType: "mouse",
        button,
        clientX: x,
        clientY: y,
      }),
    move: (x: number, y: number) =>
      fire(canvas.ownerDocument, "pointermove", {
        pointerId: 1,
        pointerType: "mouse",
        clientX: x,
        clientY: y,
      }),
    up: () => fire(canvas.ownerDocument, "pointerup", { pointerId: 1, pointerType: "mouse" }),
    wheel: (x: number, y: number, deltaY: number) =>
      fire(canvas, "wheel", { clientX: x, clientY: y, deltaY, deltaMode: 0, ctrlKey: false }),
  };
  return { rig, controls, canvas, mouse, onChange, clock };
}

// Where the ray through a screen position meets the ground.
function groundAt(rig: ReturnType<typeof createCameraRig>, x: number, y: number): Vector3 {
  rig.active.updateMatrixWorld(true);
  const ray = new Raycaster();
  ray.setFromCamera(new Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), rig.active);
  return ray.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), new Vector3())!;
}

for (const perspective of [false, true]) {
  const name = perspective ? "perspective" : "orthographic";

  test(`zoom to cursor keeps the ground point under the cursor fixed inside bounds (${name})`, () => {
    const { rig, mouse } = setup({ perspective });
    for (const [x, y] of [
      [1000, 150],
      [200, 600],
      [W / 2, H / 2],
    ]) {
      const before = groundAt(rig, x, y);
      mouse.wheel(x, y, -100);
      const after = groundAt(rig, x, y);
      expect(after.distanceTo(before)).toBeLessThan(1e-6);
    }
    expect(rig.framing.zoom).toBeGreaterThan(ORTHO_ZOOM.default);
  });

  test(`the camera cannot leave the bounds by panning or zooming (${name})`, () => {
    const { rig, controls, mouse } = setup({ perspective });
    mouse.down(640, 360);
    mouse.move(-6000, -6000);
    mouse.move(9000, 9000);
    mouse.move(-9000, 4000);
    mouse.up();
    for (let i = 0; i < 120; i++) controls.update(FRAME_MS);
    const t = rig.framing.target;
    expect(Math.abs(t.x)).toBeLessThanOrEqual(CAMPUS_BOUNDS.halfX + 1e-9);
    expect(Math.abs(t.z)).toBeLessThanOrEqual(CAMPUS_BOUNDS.halfZ + 1e-9);
    expect(t.y).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 60; i++) mouse.wheel(900, 200, -100);
    expect(rig.framing.zoom).toBeLessThanOrEqual(ORTHO_ZOOM.max + 1e-9);
    for (let i = 0; i < 160; i++) mouse.wheel(900, 200, 100);
    expect(rig.framing.zoom).toBeGreaterThanOrEqual(ORTHO_ZOOM.min - 1e-9);
    expect(Math.abs(t.x)).toBeLessThanOrEqual(CAMPUS_BOUNDS.halfX + 1e-9);
    expect(Math.abs(t.z)).toBeLessThanOrEqual(CAMPUS_BOUNDS.halfZ + 1e-9);
    if (perspective) {
      const range = perspectiveDistanceRange(H);
      const d = (rig.active as PerspectiveCamera).position.distanceTo(t);
      expect(d).toBeGreaterThanOrEqual(range.min - 1e-6);
      expect(d).toBeLessThanOrEqual(range.max + 1e-6);
    }
  });
}

test("left-drag pans along the ground and right-drag rotates, within the elevation range", () => {
  const { rig, controls, mouse } = setup();
  const before = rig.framing.target.clone();
  mouse.down(640, 360, 0);
  mouse.move(740, 360);
  mouse.up();
  for (let i = 0; i < 90; i++) controls.update(FRAME_MS);
  expect(rig.framing.target.distanceTo(before)).toBeGreaterThan(0.5);
  expect(rig.framing.target.y).toBe(0);

  const azimuth = rig.framing.azimuth;
  mouse.down(640, 360, 2);
  mouse.move(740, 360);
  mouse.up();
  expect(rig.framing.azimuth).not.toBeCloseTo(azimuth, 3);

  mouse.down(640, 360, 2);
  mouse.move(640, -5000);
  mouse.move(640, 9000);
  mouse.up();
  expect(rig.framing.elevation).toBeGreaterThanOrEqual(ELEVATION_RANGE.min - 1e-6);
  expect(rig.framing.elevation).toBeLessThanOrEqual(ELEVATION_RANGE.max + 1e-6);
});

test("the context menu is suppressed, so a right-drag does not open it", () => {
  const { canvas, mouse } = setup();
  mouse.down(640, 360, 2);
  expect(fire(canvas, "contextmenu").defaultPrevented).toBe(true);
});

test("pan eases to a stop over about 250 ms", () => {
  const { rig, controls, mouse } = setup();
  const start = rig.framing.target.clone();
  mouse.down(640, 360);
  mouse.move(740, 360);
  mouse.up();
  let at250 = 0;
  let lastMoving = 0;
  for (let frame = 1; frame <= 120; frame++) {
    if (controls.update(FRAME_MS)) lastMoving = frame;
    if (frame * FRAME_MS <= DAMPING_SETTLE_MS) at250 = rig.framing.target.distanceTo(start);
  }
  const total = rig.framing.target.distanceTo(start);
  // Still settling after the first frames, quiet well within two seconds.
  expect(lastMoving).toBeGreaterThan(5);
  expect(lastMoving).toBeLessThan(60);
  expect(at250).toBeGreaterThan(0.9 * total);
  expect(at250).toBeLessThan(total);
  // Settled: more frames move nothing.
  expect(controls.update(FRAME_MS)).toBe(false);
  expect(rig.framing.target.distanceTo(start)).toBeCloseTo(total, 6);
});

test("the damping is the same in real time at 30 and 60 fps", () => {
  const end = (frameMs: number) => {
    const { rig, controls, mouse } = setup();
    const start = rig.framing.target.clone();
    mouse.down(640, 360);
    mouse.move(740, 360);
    mouse.up();
    for (let t = 0; t < 250; t += frameMs) controls.update(frameMs);
    return rig.framing.target.distanceTo(start);
  };
  expect(end(1000 / 30)).toBeCloseTo(end(1000 / 60), 1);
});

test("under reduced motion there is no damping: motion stops with the pointer", () => {
  const { rig, controls, mouse } = setup({ reduced: true });
  const start = rig.framing.target.clone();
  mouse.down(640, 360);
  mouse.move(740, 360);
  mouse.up();
  const moved = rig.framing.target.distanceTo(start);
  expect(moved).toBeCloseTo(100 / ORTHO_ZOOM.default, 2);
  expect(controls.update(FRAME_MS)).toBe(false);
  expect(rig.framing.target.distanceTo(start)).toBeCloseTo(moved, 12);
});

// MapControls clears a pan residue itself when a pan starts, so these start the other kind of drag.
test("a new drag stops the damping left from the last one", () => {
  const panThenRotate = setup();
  panThenRotate.mouse.down(640, 360);
  panThenRotate.mouse.move(740, 360);
  panThenRotate.mouse.up();
  panThenRotate.controls.update(FRAME_MS);
  panThenRotate.mouse.down(300, 300, 2);
  const held = panThenRotate.rig.framing.target.clone();
  panThenRotate.controls.update(FRAME_MS);
  expect(panThenRotate.rig.framing.target.distanceTo(held)).toBe(0);

  const rotateThenPan = setup();
  rotateThenPan.mouse.down(640, 360, 2);
  rotateThenPan.mouse.move(740, 360);
  rotateThenPan.mouse.up();
  rotateThenPan.controls.update(FRAME_MS);
  rotateThenPan.mouse.down(300, 300, 0);
  const azimuth = rotateThenPan.rig.framing.azimuth;
  expect(rotateThenPan.controls.update(FRAME_MS)).toBe(false);
  expect(rotateThenPan.rig.framing.azimuth).toBe(azimuth);
});

test("a drag or the wheel cancels a glide in flight", () => {
  const { rig, mouse } = setup();
  rig.glideTo(new Vector3(8, 0, 0), 120);
  expect(rig.animating).toBe(true);
  mouse.down(640, 360);
  expect(rig.animating).toBe(false);
  mouse.up();
  rig.glideTo(new Vector3(-8, 0, 0), 120);
  mouse.wheel(640, 360, -100);
  expect(rig.animating).toBe(false);
});

test("controls changes are reported so the loop counts them as motion", () => {
  const { mouse, onChange } = setup();
  mouse.wheel(640, 360, -100);
  expect(onChange).toHaveBeenCalled();
});

test("damping still settling holds the 60 fps cap on the fake clock, then calm mode returns", () => {
  const fake = createFakeEnv();
  const { rig, controls, mouse } = setup();
  let lastMovedAt = 0;
  // The loop's own update path. The controls change signal is left unwired on purpose, so only
  // the value stepCamera returns can keep the driver out of calm mode.
  const driver = createRenderDriver({
    env: fake.env,
    render: () => {},
    update: (now, interval) => {
      const moved = stepCamera(rig, controls, now, interval);
      if (moved) lastMovedAt = now;
      return moved;
    },
    onFatal: () => {},
  });
  driver.start();
  const runFor = (ms: number, onFrame?: () => void) => {
    const end = fake.now + ms;
    while (fake.now + FRAME_MS <= end + 1e-6) {
      fake.step(FRAME_MS);
      onFrame?.();
    }
  };
  runFor(6000);
  expect(driver.state.mode).toBe("calm");

  // A drag that ends in damping.
  const releasedAt = fake.now;
  mouse.down(640, 360);
  mouse.move(900, 360);
  mouse.up();
  const capsWhileSettling: number[] = [];
  runFor(DAMPING_SETTLE_MS, () => capsWhileSettling.push(driver.state.capFps));
  // The first frame is paced from calm mode; its update is what leaves it.
  expect(capsWhileSettling.slice(2).every((cap) => cap === 60)).toBe(true);
  expect(driver.state.mode).toBe("active");

  // The damping tail settles, then five seconds of quiet pass before the cap drops to 30.
  runFor(2000);
  expect(lastMovedAt - releasedAt).toBeGreaterThanOrEqual(DAMPING_SETTLE_MS);
  expect(lastMovedAt - releasedAt).toBeLessThan(2000);
  runFor(lastMovedAt + CALM_AFTER_MS - 100 - fake.now);
  expect(driver.state).toEqual({ capFps: 60, mode: "active" });
  runFor(200 + FRAME_MS);
  expect(driver.state).toEqual({ capFps: 30, mode: "calm" });
});

test("a glide stops the damping left from a drag", () => {
  const { rig, controls, mouse } = setup();
  const off = wakeOnRigMotion(
    rig,
    () => controls,
    () => {},
  );
  mouse.down(640, 360);
  mouse.move(740, 360);
  mouse.up();
  controls.update(FRAME_MS);
  rig.nudge({ zoomFactor: 1.25 }, 250);
  const held = rig.framing.target.clone();
  expect(controls.update(FRAME_MS)).toBe(false);
  expect(rig.framing.target.distanceTo(held)).toBe(0);
  off();
});
