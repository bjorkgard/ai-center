import { PerspectiveCamera, Vector3, type Camera } from "three";
import { SIGN } from "./hallLayout.ts";

// What the rule reads from the camera rig.
export interface SignRig {
  readonly active: Camera;
  project(point: Vector3, out?: { x: number; y: number }): { x: number; y: number };
}

// The letter measure (CEO W-RW24): the 2D distance in CSS px between the projected bottom-centre
// and top-centre of a capital letter in the project-name line, at the rig's current pose. The
// name line sits `baseline` above the panel's bottom edge and is `nameCap` tall; the point is
// taken at the panel's horizontal centre.
// It runs every frame, so it works in module scratch objects and allocates nothing.
const bottomPoint = new Vector3();
const topPoint = new Vector3();
const bottomScreen = { x: 0, y: 0 };
const topScreen = { x: 0, y: 0 };

export function letterMeasure(rig: SignRig, panelCentre: Vector3): number {
  bottomPoint.copy(panelCentre);
  bottomPoint.y += -SIGN.height / 2 + SIGN.baseline;
  topPoint.copy(bottomPoint);
  topPoint.y += SIGN.nameCap;
  rig.project(bottomPoint, bottomScreen);
  rig.project(topPoint, topScreen);
  return Math.hypot(bottomScreen.x - topScreen.x, bottomScreen.y - topScreen.y);
}

const scratch = new Vector3();

// A face points at the camera when its outward normal has a positive component towards it:
// the view direction for an orthographic camera, the eye position for a perspective one.
export function facesCamera(camera: Camera, panelCentre: Vector3, normal: Vector3): boolean {
  if (camera instanceof PerspectiveCamera) {
    return normal.dot(scratch.copy(camera.position).sub(panelCentre)) > 0;
  }
  return normal.dot(camera.getWorldDirection(scratch).negate()) > 0;
}

// The panel shows only while it faces the camera and its letter measures 12 CSS px or more
// (design D7).
export function signVisible(rig: SignRig, panelCentre: Vector3, normal: Vector3): boolean {
  return (
    facesCamera(rig.active, panelCentre, normal) &&
    letterMeasure(rig, panelCentre) >= SIGN.minLetterPx
  );
}

// Per-panel opacity that follows a target over `fadeMs` (200), driven by a clock the caller
// passes in so it is testable. A snap sets the value at once (frozen frames, reduced motion).
export class SignFader {
  private readonly value: number[];
  private readonly target: number[];
  private last = 0;

  constructor(count: number) {
    this.value = Array.from({ length: count }, () => 0);
    this.target = Array.from({ length: count }, () => 0);
  }

  opacity(slot: number): number {
    return this.value[slot] ?? 0;
  }

  get animating(): boolean {
    for (let i = 0; i < this.value.length; i++) {
      if (this.value[i] !== this.target[i]) return true;
    }
    return false;
  }

  setTarget(slot: number, visible: boolean, now: number, snap: boolean): void {
    const next = visible ? 1 : 0;
    if (this.target[slot] === next && !snap) return;
    if (!this.animating) this.last = now;
    this.target[slot] = next;
    if (snap) this.value[slot] = next;
  }

  // Moves every panel towards its target; true while any is still moving.
  step(now: number): boolean {
    const delta = Math.max(0, now - this.last) / SIGN.fadeMs;
    this.last = now;
    for (let i = 0; i < this.value.length; i++) {
      const diff = this.target[i] - this.value[i];
      this.value[i] =
        Math.abs(diff) <= delta ? this.target[i] : this.value[i] + Math.sign(diff) * delta;
    }
    return this.animating;
  }
}

// The fader the hall view drives, so the dev hook can read a panel's opacity.
let active: SignFader | null = null;

export function setActiveFader(fader: SignFader | null): void {
  active = fader;
}

export function signOpacity(slot: number): number | null {
  return active ? active.opacity(slot) : null;
}
