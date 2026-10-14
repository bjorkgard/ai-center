import { MathUtils, OrthographicCamera, PerspectiveCamera, Vector3 } from "three";
import type { SafeArea } from "../app/store/ui.ts";
import { ease } from "./easing.ts";
import { SIGN } from "./hall/hallLayout.ts";
import { RENDER } from "./render.ts";

export type Projection = "orthographic" | "perspective";

// True isometric: 45 degrees around the vertical axis, then the elevation whose
// tangent is 1/sqrt(2), so the camera looks along (1, 1, 1) and all three axes
// foreshorten equally.
export const ISO_AZIMUTH = Math.PI / 4;
export const ISO_ELEVATION = Math.atan(1 / Math.SQRT2);

// Orthographic zoom is pixels per world unit. The controls and the rig clamp to these.
// The minimum lets the whole campus fit the smallest home area (1280x616 at a 1280x720 window), in perspective too.
export const ORTHO_ZOOM = { min: 6, default: 80, max: 240 } as const; // [estimated]
// The ortho zoom at which a hall sign's project-name capital measures 12 CSS px at the isometric
// pose: a vertical segment of `nameCap` units spans cos(elevation) of its length on screen.
// In perspective the effective zoom is zoomForDistance at the target distance (CEO W-RW17).
export const SEMANTIC_ZOOM = SIGN.minLetterPx / (SIGN.nameCap * Math.cos(ISO_ELEVATION));
export const PERSPECTIVE_FOV = 35; // degrees [estimated]
const ORTHO_DISTANCE = 100; // far from the scene so the ortho frustum never clips it

// The view never drops below the ground or looks straight down.
export const ELEVATION_RANGE = { min: (12 * Math.PI) / 180, max: (85 * Math.PI) / 180 } as const; // [estimated]

export const GLIDE_MS = 600; // design D20 scene duration
const RETARGET_MIN_MS = 250; // [estimated]
const HOME_MARGIN = 0.92; // [estimated]

const directionOf = (azimuth: number, elevation: number, out = new Vector3()) =>
  out.set(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  );

const halfFov = () => Math.tan((PERSPECTIVE_FOV * Math.PI) / 360);

// The ortho view shows height / zoom world units; a perspective camera at distance d
// shows 2 d tan(fov / 2) at the target. Equal heights keep the framing across a toggle.
export function distanceForZoom(zoom: number, viewportHeight: number): number {
  return viewportHeight / (zoom * 2 * halfFov());
}

export function zoomForDistance(distance: number, viewportHeight: number): number {
  return viewportHeight / (distance * 2 * halfFov());
}

export function clampZoom(zoom: number): number {
  return Math.min(ORTHO_ZOOM.max, Math.max(ORTHO_ZOOM.min, zoom));
}

// The perspective distance range that matches the ortho zoom range (S-RW26).
export function perspectiveDistanceRange(viewportHeight: number): { min: number; max: number } {
  return {
    min: distanceForZoom(ORTHO_ZOOM.max, viewportHeight),
    max: distanceForZoom(ORTHO_ZOOM.min, viewportHeight),
  };
}

export function clampDistance(distance: number, viewportHeight: number): number {
  const { min, max } = perspectiveDistanceRange(viewportHeight);
  return Math.min(max, Math.max(min, distance));
}

export interface Viewport {
  width: number;
  height: number;
}

// The camera target stays inside these half extents (world units, about the origin) and below
// maxY. The campus supplies them through `setCampus`, so this file imports no campus code.
export interface CampusBounds {
  halfX: number;
  halfZ: number;
  maxY: number;
}

// The ground box (and its height) that `home()` frames.
export interface HomeBox {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  maxY: number;
}

export interface CampusFrame {
  bounds: CampusBounds;
  home: HomeBox;
}

// What a rig frames until a campus is set: the box the look-dev, hall and racks views have
// always used.
const DEFAULT_CAMPUS: CampusFrame = {
  bounds: { halfX: 14, halfZ: 14, maxY: 3 },
  home: { minX: -14, maxX: 14, minZ: -14, maxZ: 14, maxY: 3 },
};

export interface Framing {
  target: Vector3;
  zoom: number;
  azimuth: number;
  elevation: number;
}

export type CameraListener = (camera: OrthographicCamera | PerspectiveCamera) => void;

// What a key step asks for, relative to the camera as it is drawn right now.
export interface Nudge {
  // Screen pixels: right and up, converted to ground units at the current zoom.
  pan?: { right: number; up: number };
  zoomFactor?: number;
  rotate?: number;
}

export interface CameraRig {
  readonly ortho: OrthographicCamera;
  readonly perspective: PerspectiveCamera;
  readonly active: OrthographicCamera | PerspectiveCamera;
  readonly projection: Projection;
  readonly framing: Framing;
  readonly animating: boolean;
  readonly viewport: Viewport;
  toggle(): void;
  setFraming(next: Partial<Framing>): void;
  setViewport(viewport: Viewport): void;
  // The store safeArea; a glide in flight retargets so its target ends inside the new rect.
  setSafeArea(area: SafeArea): void;
  // The rectangle `home()` and the startup pose fit the campus into: the canvas minus the top bar
  // and tab strip, with the other panels floating over it (decision H1). Glides keep the safeArea.
  setHomeArea(area: SafeArea): void;
  // Glides so `target` lands at the centre of the safeArea at `zoom`; instant under reduced motion.
  glideTo(target: Vector3, zoom: number, ms?: number): void;
  // The campus box set by `setCampus` framed in the home area at the isometric angle; `ms` 0 cuts.
  home(ms?: number): void;
  // The campus bounds and home box, read at call time. A zero-size or NaN extent keeps the
  // previous ones and warns on every such call (CEO W-RW32).
  setCampus(campus: CampusFrame): void;
  // Pulls a target inside the campus bounds, in place.
  clampTarget(target: Vector3): Vector3;
  nudge(change: Nudge, ms: number): void;
  cancelGlide(): void;
  // Advances a glide or nudge to `now` (ms); true while one is running.
  step(now: number): boolean;
  // The controls moved the active camera: read the angles and zoom back.
  adopt(angles: { azimuth: number; polar: number }): void;
  // Screen position in CSS pixels (y down) of a world point.
  // `out`, when given, receives the result so a per-frame caller allocates nothing.
  project(point: Vector3, out?: { x: number; y: number }): { x: number; y: number };
  // Fires when a glide or nudge starts, so the render loop wakes from calm mode.
  onMotion(listener: () => void): () => void;
  subscribe(listener: CameraListener): () => void;
}

export interface RigOptions {
  now?: () => number;
  reducedMotion?: () => boolean;
  warn?: (message: string) => void;
}

interface Pose {
  target: Vector3;
  zoom: number;
  azimuth: number;
  elevation: number;
}

interface Anim {
  from: Pose;
  to: Pose;
  // Set for glides: the point that must end at the safeArea centre, kept to retarget.
  goal: {
    target: Vector3;
    zoom: number;
    azimuth: number;
    elevation: number;
    // Which rectangle the target is centred in: the safeArea, or the home area for home().
    area: "safe" | "home";
  } | null;
  start: number;
  ms: number;
}

const finite = (...values: number[]) => values.every(Number.isFinite);

function validCampus({ bounds, home }: CampusFrame): boolean {
  return (
    finite(bounds.halfX, bounds.halfZ, bounds.maxY, home.minX, home.maxX, home.minZ, home.maxZ) &&
    finite(home.maxY) &&
    bounds.halfX > 0 &&
    bounds.halfZ > 0 &&
    bounds.maxY >= 0 &&
    home.maxX > home.minX &&
    home.maxZ > home.minZ &&
    home.maxY >= 0
  );
}

const clampElevation = (elevation: number) =>
  MathUtils.clamp(elevation, ELEVATION_RANGE.min, ELEVATION_RANGE.max);

const projectScratch = new Vector3();

export function createCameraRig(initial: Viewport, options: RigOptions = {}): CameraRig {
  const now = options.now ?? (() => performance.now());
  const reducedMotion = options.reducedMotion ?? (() => false);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const ortho = new OrthographicCamera(0, 0, 0, 0, RENDER.camera.near, RENDER.camera.far);
  const perspective = new PerspectiveCamera(
    PERSPECTIVE_FOV,
    1,
    RENDER.camera.near,
    RENDER.camera.far,
  );
  const framing: Framing = {
    target: new Vector3(0, 0, 0),
    zoom: ORTHO_ZOOM.default,
    azimuth: ISO_AZIMUTH,
    elevation: ISO_ELEVATION,
  };
  const listeners = new Set<CameraListener>();
  const motionListeners = new Set<() => void>();
  let viewport = initial;
  let safeArea: SafeArea = { x: 0, y: 0, width: initial.width, height: initial.height };
  let homeArea: SafeArea = safeArea;
  let warned = false;
  let campus: CampusFrame = DEFAULT_CAMPUS;
  let projection: Projection = "orthographic";
  let distance = distanceForZoom(framing.zoom, viewport.height);
  let anim: Anim | null = null;

  const active = () => (projection === "orthographic" ? ortho : perspective);
  const direction = new Vector3();

  const apply = () => {
    const { width, height } = viewport;
    directionOf(framing.azimuth, framing.elevation, direction);
    if (projection === "orthographic") {
      ortho.zoom = framing.zoom;
      ortho.left = width / -2;
      ortho.right = width / 2;
      ortho.top = height / 2;
      ortho.bottom = height / -2;
      ortho.position.copy(framing.target).addScaledVector(direction, ORTHO_DISTANCE);
      ortho.lookAt(framing.target);
      ortho.updateProjectionMatrix();
    } else {
      // The far plane reaches past the widest zoom-out and the whole campus, at any window size.
      const { halfX, halfZ, maxY } = campus.bounds;
      perspective.far = Math.max(
        RENDER.camera.far,
        perspectiveDistanceRange(height).max + 2 * Math.hypot(halfX, halfZ, maxY),
      );
      perspective.aspect = height > 0 ? width / height : 1;
      perspective.position.copy(framing.target).addScaledVector(direction, distance);
      perspective.lookAt(framing.target);
      perspective.updateProjectionMatrix();
    }
    active().updateMatrixWorld(true);
  };
  apply();

  const pose = (): Pose => ({
    target: framing.target.clone(),
    zoom: framing.zoom,
    azimuth: framing.azimuth,
    elevation: framing.elevation,
  });

  const applyPose = (p: Pose) => {
    framing.target.copy(p.target);
    framing.zoom = clampZoom(p.zoom);
    distance = distanceForZoom(framing.zoom, viewport.height);
    framing.azimuth = p.azimuth;
    framing.elevation = p.elevation;
    apply();
  };

  const clampTarget = (target: Vector3): Vector3 => {
    const { halfX, halfZ, maxY } = campus.bounds;
    target.x = MathUtils.clamp(target.x, -halfX, halfX);
    target.z = MathUtils.clamp(target.z, -halfZ, halfZ);
    target.y = MathUtils.clamp(target.y, 0, maxY);
    return target;
  };

  // A safeArea with no width or height falls back to the full canvas, with one warning (S-RW38).
  const safeRect = (): SafeArea => {
    if (safeArea.width > 0 && safeArea.height > 0) {
      warned = false;
      return safeArea;
    }
    if (!warned) {
      warned = true;
      warn("[camera] the safe area has no width or height; framing in the full canvas");
    }
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
  };

  // Screen right, screen up and the ground-plane forward of a camera at these angles.
  const axes = (azimuth: number, elevation: number) => {
    const forward = directionOf(azimuth, elevation).negate();
    const right = new Vector3(Math.cos(azimuth), 0, -Math.sin(azimuth));
    const up = new Vector3().crossVectors(right, forward);
    const ground = new Vector3(forward.x, 0, forward.z).normalize();
    return { forward, right, up, ground };
  };

  // The orbit target that puts `point` at the centre of the safeArea at this zoom. Exact for the
  // orthographic camera; the perspective camera corrects the estimate against its own projection.
  const orbitTargetFor = (
    point: Vector3,
    zoom: number,
    azimuth: number,
    elevation: number,
    rect: SafeArea = safeRect(),
  ) => {
    const wantX = rect.x + rect.width / 2;
    const wantY = rect.y + rect.height / 2;
    const { forward, right, up } = axes(azimuth, elevation);
    const s = 1 / zoom;
    const slide = (c: Vector3) => c.addScaledVector(forward, (point.y - c.y) / forward.y);
    const c = slide(
      point
        .clone()
        .addScaledVector(right, -(wantX - viewport.width / 2) * s)
        .addScaledVector(up, (wantY - viewport.height / 2) * s),
    );
    if (projection === "perspective") {
      const scratch = perspective.clone();
      scratch.aspect = viewport.width > 0 ? viewport.width / viewport.height : 1;
      scratch.updateProjectionMatrix();
      const away = distanceForZoom(zoom, viewport.height);
      for (let i = 0; i < 3; i++) {
        scratch.position.copy(c).addScaledVector(directionOf(azimuth, elevation), away);
        scratch.lookAt(c);
        scratch.updateMatrixWorld(true);
        const p = point.clone().project(scratch);
        const errX = ((p.x + 1) / 2) * viewport.width - wantX;
        const errY = ((1 - p.y) / 2) * viewport.height - wantY;
        slide(c.addScaledVector(right, errX * s).addScaledVector(up, -errY * s));
      }
    }
    return clampTarget(c);
  };

  // The home area, or the full canvas when it has no width or height.
  const homeRect = (): SafeArea =>
    homeArea.width > 0 && homeArea.height > 0
      ? homeArea
      : { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const areaOf = (area: "safe" | "home") => (area === "home" ? homeRect() : safeRect());

  const goalPose = (goal: NonNullable<Anim["goal"]>): Pose => {
    const zoom = clampZoom(goal.zoom);
    return {
      target: orbitTargetFor(goal.target, zoom, goal.azimuth, goal.elevation, areaOf(goal.area)),
      zoom,
      azimuth: goal.azimuth,
      elevation: goal.elevation,
    };
  };

  const wake = () => {
    for (const listener of motionListeners) listener();
  };

  const begin = (to: Pose, ms: number, goal: Anim["goal"]) => {
    to.target = clampTarget(to.target);
    to.zoom = clampZoom(to.zoom);
    to.elevation = clampElevation(to.elevation);
    if (ms <= 0 || reducedMotion()) {
      anim = null;
      applyPose(to);
    } else {
      anim = { from: pose(), to, goal, start: now(), ms };
    }
    wake();
  };

  // Restart a glide in flight from where the camera is, over the time left, towards the changed
  // rectangle it centres in (S-RW37).
  const retarget = (area: "safe" | "home") => {
    if (!anim?.goal || anim.goal.area !== area) return;
    const left = Math.max(anim.ms - (now() - anim.start), RETARGET_MIN_MS);
    anim = { from: pose(), to: goalPose(anim.goal), goal: anim.goal, start: now(), ms: left };
  };

  const glide = (goal: NonNullable<Anim["goal"]>, ms: number) => {
    goal.elevation = clampElevation(goal.elevation);
    begin(goalPose(goal), ms, goal);
  };

  // The eight corners of the home box: its ground rectangle at the ground and at its height.
  const homeCorners = () => {
    const { minX, maxX, minZ, maxZ, maxY } = campus.home;
    const corners: Vector3[] = [];
    for (const x of [minX, maxX]) {
      for (const z of [minZ, maxZ]) {
        for (const y of [0, maxY]) corners.push(new Vector3(x, y, z));
      }
    }
    return corners;
  };

  // The ground point that sits in the middle of the home box's extent on screen, so the box
  // fits tightly about the target the glide centres in the home area.
  const homeCentre = () => {
    const { right, up } = axes(ISO_AZIMUTH, ISO_ELEVATION);
    let minR = Infinity;
    let maxR = -Infinity;
    let minU = Infinity;
    let maxU = -Infinity;
    for (const corner of homeCorners()) {
      const r = corner.dot(right);
      const u = corner.dot(up);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
    }
    const midR = (minR + maxR) / 2;
    const midU = (minU + maxU) / 2;
    // The ground point (x, 0, z) with right . p = midR and up . p = midU.
    const det = right.x * up.z - right.z * up.x;
    return new Vector3(
      (midR * up.z - right.z * midU) / det,
      0,
      (right.x * midU - up.x * midR) / det,
    );
  };

  // Zoom that fits the home box, seen from the isometric angle, inside the home area.
  const homeZoom = (centre: Vector3) => {
    const rect = homeRect();
    const { right, up } = axes(ISO_AZIMUTH, ISO_ELEVATION);
    let halfW = 0;
    let halfH = 0;
    for (const corner of homeCorners()) {
      corner.sub(centre);
      halfW = Math.max(halfW, Math.abs(corner.dot(right)));
      halfH = Math.max(halfH, Math.abs(corner.dot(up)));
    }
    const fit = Math.min(rect.width / (2 * halfW), rect.height / (2 * halfH)) * HOME_MARGIN || 1;
    return projection === "perspective" ? perspectiveHomeZoom(fit, centre) : fit;
  };

  // The near corners of the box look bigger through a perspective lens, so shrink the orthographic
  // fit until the projected corners sit inside the margin of the home area.
  const perspectiveHomeZoom = (start: number, centre: Vector3) => {
    const rect = homeRect();
    const scratch = perspective.clone();
    scratch.aspect =
      viewport.width > 0 && viewport.height > 0 ? viewport.width / viewport.height : 1;
    scratch.updateProjectionMatrix();
    let zoom = start;
    for (let i = 0; i < 6; i++) {
      zoom = clampZoom(zoom);
      const c = orbitTargetFor(centre.clone(), zoom, ISO_AZIMUTH, ISO_ELEVATION, rect);
      scratch.position
        .copy(c)
        .addScaledVector(
          directionOf(ISO_AZIMUTH, ISO_ELEVATION),
          distanceForZoom(zoom, viewport.height),
        );
      scratch.lookAt(c);
      scratch.updateMatrixWorld(true);
      let dx = 0;
      let dy = 0;
      for (const corner of homeCorners()) {
        const p = corner.project(scratch);
        dx = Math.max(dx, Math.abs(((p.x + 1) / 2) * viewport.width - (rect.x + rect.width / 2)));
        dy = Math.max(dy, Math.abs(((1 - p.y) / 2) * viewport.height - (rect.y + rect.height / 2)));
      }
      const ratio = Math.min(
        (rect.width / 2 / dx) * HOME_MARGIN,
        (rect.height / 2 / dy) * HOME_MARGIN,
      );
      if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 1e-4) break;
      zoom *= ratio;
    }
    return zoom;
  };

  const shortestAngle = (from: number, to: number) =>
    from + MathUtils.euclideanModulo(to - from + Math.PI, 2 * Math.PI) - Math.PI;

  return {
    ortho,
    perspective,
    get active() {
      return active();
    },
    get projection() {
      return projection;
    },
    framing,
    get animating() {
      return anim !== null;
    },
    get viewport() {
      return viewport;
    },
    toggle() {
      anim = null;
      if (projection === "orthographic") {
        distance = clampDistance(distanceForZoom(framing.zoom, viewport.height), viewport.height);
        projection = "perspective";
      } else {
        framing.zoom = clampZoom(zoomForDistance(distance, viewport.height));
        projection = "orthographic";
      }
      apply();
      for (const listener of listeners) listener(active());
    },
    setFraming(next) {
      if (next.target) framing.target.copy(next.target);
      if (next.zoom !== undefined) {
        framing.zoom = clampZoom(next.zoom);
        distance = distanceForZoom(framing.zoom, viewport.height);
      }
      if (next.azimuth !== undefined) framing.azimuth = next.azimuth;
      if (next.elevation !== undefined) framing.elevation = next.elevation;
      apply();
    },
    setViewport(next) {
      viewport = next;
      apply();
    },
    setSafeArea(area) {
      safeArea = area;
      retarget("safe");
    },
    setHomeArea(area) {
      homeArea = area;
      retarget("home");
    },
    glideTo(target, zoom, ms = GLIDE_MS) {
      glide(
        {
          target: target.clone(),
          zoom,
          azimuth: framing.azimuth,
          elevation: framing.elevation,
          area: "safe",
        },
        ms,
      );
    },
    home(ms = GLIDE_MS) {
      const centre = homeCentre();
      glide(
        {
          target: centre,
          zoom: homeZoom(centre),
          azimuth: ISO_AZIMUTH,
          elevation: ISO_ELEVATION,
          area: "home",
        },
        ms,
      );
    },
    setCampus(next) {
      if (!validCampus(next)) {
        warn("[camera] the campus extent is empty or not a number; keeping the previous bounds");
        return;
      }
      campus = {
        bounds: { ...next.bounds },
        home: { ...next.home },
      };
    },
    clampTarget,
    nudge(change, ms) {
      const to = pose();
      if (change.pan) {
        const { right, ground } = axes(to.azimuth, to.elevation);
        // The ground foreshortens by sin(elevation) on screen, so "up" divides by it to move the
        // picture by the same number of pixels as "right" does.
        const unitsPerPixel = 1 / to.zoom;
        to.target
          .addScaledVector(right, change.pan.right * unitsPerPixel)
          .addScaledVector(ground, (change.pan.up * unitsPerPixel) / Math.sin(to.elevation));
      }
      if (change.zoomFactor) to.zoom *= change.zoomFactor;
      if (change.rotate) to.azimuth += change.rotate;
      begin(to, ms, null);
    },
    cancelGlide() {
      anim = null;
    },
    step(at) {
      if (!anim) return false;
      const t = Math.min(1, Math.max(0, (at - anim.start) / anim.ms));
      const e = ease(t);
      const { from, to } = anim;
      applyPose({
        target: from.target.clone().lerp(to.target, e),
        zoom: Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e),
        azimuth: from.azimuth + (shortestAngle(from.azimuth, to.azimuth) - from.azimuth) * e,
        elevation: from.elevation + (to.elevation - from.elevation) * e,
      });
      if (t >= 1) anim = null;
      return true;
    },
    adopt({ azimuth, polar }) {
      framing.azimuth = azimuth;
      framing.elevation = Math.PI / 2 - polar;
      if (projection === "orthographic") {
        framing.zoom = ortho.zoom;
      } else {
        distance = clampDistance(perspective.position.distanceTo(framing.target), viewport.height);
        framing.zoom = clampZoom(zoomForDistance(distance, viewport.height));
      }
    },
    project(point, out = { x: 0, y: 0 }) {
      const p = projectScratch.copy(point).project(active());
      out.x = ((p.x + 1) / 2) * viewport.width;
      out.y = ((1 - p.y) / 2) * viewport.height;
      return out;
    },
    onMotion(listener) {
      motionListeners.add(listener);
      return () => motionListeners.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
