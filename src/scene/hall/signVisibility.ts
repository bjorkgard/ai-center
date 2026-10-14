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
  // The clock of each panel's latest step (or fade start), so a fade measures its own 200 ms.
  private readonly last: number[];
  // The fader's own clock (the `now` it was given) at the start of each panel's latest fade and at
  // its end; the end is null while the fade runs. A dev hook reads them (see `signFadeTiming`).
  private readonly started: (number | null)[];
  private readonly ended: (number | null)[];

  constructor(count: number) {
    this.value = Array.from({ length: count }, () => 0);
    this.target = Array.from({ length: count }, () => 0);
    this.last = Array.from({ length: count }, () => 0);
    this.started = Array.from({ length: count }, () => null);
    this.ended = Array.from({ length: count }, () => null);
  }

  timing(slot: number): { start: number | null; end: number | null } {
    return { start: this.started[slot] ?? null, end: this.ended[slot] ?? null };
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
    // Mid-fade: the time up to now still belongs to the old target.
    if (this.value[slot] === this.target[slot]) this.last[slot] = now;
    else this.advance(slot, now);
    this.target[slot] = next;
    if (snap) {
      this.value[slot] = next;
      this.started[slot] = null;
      this.ended[slot] = null;
    } else {
      this.started[slot] = now;
      this.ended[slot] = null;
    }
  }

  // Moves every panel towards its target; true while any is still moving.
  step(now: number): boolean {
    for (let i = 0; i < this.value.length; i++) this.advance(i, now);
    return this.animating;
  }

  private advance(i: number, now: number): void {
    const delta = Math.max(0, now - this.last[i]) / SIGN.fadeMs;
    this.last[i] = now;
    const diff = this.target[i] - this.value[i];
    if (Math.abs(diff) <= delta) {
      this.value[i] = this.target[i];
      // Reached inside this step: the end is the step time less the unused part of the step.
      if (diff !== 0 && this.ended[i] === null) {
        this.ended[i] = now - (delta - Math.abs(diff)) * SIGN.fadeMs;
      }
    } else {
      this.value[i] = this.value[i] + Math.sign(diff) * delta;
    }
  }
}

// The fader the hall view drives, so the dev hook can read a panel's opacity.
let active: SignFader | null = null;

export function setActiveFader(fader: SignFader | null): void {
  active = fader;
}

// Opacity and fade timing of a slot's panel on the fader's own clock, for the dev hook.
export function signFadeTiming(slot: number): {
  opacity: number;
  start: number | null;
  end: number | null;
} | null {
  return active ? { opacity: active.opacity(slot), ...active.timing(slot) } : null;
}

export function signOpacity(slot: number): number | null {
  return active ? active.opacity(slot) : null;
}
