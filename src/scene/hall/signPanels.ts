import { InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry, Vector3 } from "three";
import { INSTANCE_OPACITY, INSTANCE_UV_RECT, MATERIALS } from "../materials.ts";
import { SIGN, SIGN_SLOTS } from "./hallLayout.ts";
import { getSignAtlas, type SignAtlas } from "./signAtlas.ts";
import { SignFader, setActiveFader, signVisible, type SignRig } from "./signVisibility.ts";

// The panel faces +z with its hall; every hall in the grid is axis aligned.
const NORMAL = new Vector3(0, 0, 1);
const ANONYMOUS = {};
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

// Every hall's sign panel is one InstancedMesh with 12 instances, one per slot: one draw for all
// halls (eng E27). Each hall writes its own instance: matrix, atlas region and fade.
export class SignPanels {
  readonly mesh: InstancedMesh;
  readonly fader = new SignFader(SIGN_SLOTS);
  private readonly centres: (Vector3 | null)[] = Array.from({ length: SIGN_SLOTS }, () => null);
  private readonly owners: (object | null)[] = Array.from({ length: SIGN_SLOTS }, () => null);
  private readonly warned = new Set<number>();
  private readonly atlas: Pick<SignAtlas, "rect">;
  private readonly opacity: InstancedBufferAttribute;
  private primed = false;

  constructor(atlas: Pick<SignAtlas, "rect">) {
    this.atlas = atlas;
    this.mesh = new InstancedMesh(
      new PlaneGeometry(SIGN.width, SIGN.height),
      MATERIALS.sign,
      SIGN_SLOTS,
    );
    this.opacity = new InstancedBufferAttribute(new Float32Array(SIGN_SLOTS), 1);
    this.mesh.geometry.setAttribute(
      INSTANCE_UV_RECT,
      new InstancedBufferAttribute(new Float32Array(SIGN_SLOTS * 4), 4),
    );
    this.mesh.geometry.setAttribute(INSTANCE_OPACITY, this.opacity);
    for (let i = 0; i < SIGN_SLOTS; i++) this.mesh.setMatrixAt(i, HIDDEN);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.name = "hall-panels";
    setActiveFader(this.fader);
  }

  // A hall in `slot` puts its panel at `centre` (world). The instance index is the slot.
  // A slot has one owner: another owner's register warns once and changes nothing, and only the
  // owner's unregister frees it. Returns whether the caller now owns the slot.
  register(slot: number, centre: Vector3, owner: object = ANONYMOUS): boolean {
    const holder = this.owners[slot];
    if (holder !== null && holder !== owner) {
      if (!this.warned.has(slot)) {
        this.warned.add(slot);
        console.warn(`[hall] sign slot ${slot} is already in use; keeping its first owner`);
      }
      return false;
    }
    this.owners[slot] = owner;
    this.centres[slot] = centre.clone();
    this.mesh.setMatrixAt(slot, new Matrix4().makeTranslation(centre));
    const { u, v, w, h } = this.atlas.rect(slot).uv;
    (this.mesh.geometry.getAttribute(INSTANCE_UV_RECT) as InstancedBufferAttribute).set(
      [u, v, w, h],
      slot * 4,
    );
    this.refresh();
    return true;
  }

  unregister(slot: number, owner: object = ANONYMOUS): void {
    if (this.owners[slot] !== owner) return;
    this.owners[slot] = null;
    this.centres[slot] = null;
    this.mesh.setMatrixAt(slot, HIDDEN);
    this.fader.setTarget(slot, false, 0, true);
    this.opacity.setX(slot, 0);
    this.refresh();
  }

  // Instances drawn: up to the highest registered slot.
  get instances(): number {
    return this.mesh.count;
  }

  private refresh(): void {
    const last = this.centres.findLastIndex((c) => c !== null);
    this.mesh.count = last + 1;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.geometry.getAttribute(INSTANCE_UV_RECT).needsUpdate = true;
    this.opacity.needsUpdate = true;
  }

  // Re-checks every hall's panel against the camera, runs the fades and writes the opacities.
  // Allocation free: it runs on every frame. `snap` cuts the fade (frozen frames, reduced motion).
  update(rig: SignRig, now: number, snap: boolean): void {
    const cut = snap || !this.primed;
    this.primed = true;
    for (let slot = 0; slot < SIGN_SLOTS; slot++) {
      const centre = this.centres[slot];
      if (centre) this.fader.setTarget(slot, signVisible(rig, centre, NORMAL), now, cut);
    }
    this.fader.step(now);
    let changed = false;
    for (let slot = 0; slot < this.mesh.count; slot++) {
      if (this.opacity.getX(slot) !== this.fader.opacity(slot)) {
        this.opacity.setX(slot, this.fader.opacity(slot));
        changed = true;
      }
    }
    if (changed) this.opacity.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}

let shared: SignPanels | null = null;

// The one panel mesh every hall shares. `atlas` is for tests; the app uses the shared atlas.
export function getSignPanels(atlas?: Pick<SignAtlas, "rect">): SignPanels {
  return (shared ??= new SignPanels(atlas ?? getSignAtlas()));
}

// What one mounted hall holds on the shared panels. `sync` runs on every render and acts only on
// the numbers, so a parent re-render with an equal new `at` array changes nothing (and never
// blinks the sign); `release` runs on unmount.
export class SignBinding {
  readonly panels: SignPanels;
  private readonly signCentre: Vector3;
  private slot = -1;
  private key = "";

  constructor(panels: SignPanels, signCentre: Vector3) {
    this.panels = panels;
    this.signCentre = signCentre;
  }

  sync(slot: number, at: readonly [number, number, number]): void {
    const key = `${slot}:${at[0]},${at[1]},${at[2]}`;
    if (key === this.key) return;
    if (slot !== this.slot) this.release();
    const centre = new Vector3(at[0], at[1], at[2]).add(this.signCentre);
    if (this.panels.register(slot, centre, this)) {
      this.slot = slot;
      this.key = key;
    }
  }

  // Whether this hall holds the panel instance of `slot` (a second hall in the same slot does not).
  owns(slot: number): boolean {
    return this.slot >= 0 && this.slot === slot;
  }

  // Draws the hall's text into the atlas only when it owns the slot, so a hall that lost the
  // slot never overwrites its owner's text. Returns whether it wrote.
  writeSign(atlas: Pick<SignAtlas, "setSign">, slot: number, letter: string, project: string) {
    if (!this.owns(slot)) return false;
    atlas.setSign(slot, letter, project);
    return true;
  }

  release(): void {
    if (this.slot >= 0) this.panels.unregister(this.slot, this);
    this.slot = -1;
    this.key = "";
  }
}
