import { InstancedBufferAttribute, InstancedMesh, Matrix4, PlaneGeometry, Vector3 } from "three";
import { SIGN } from "../hall/hallLayout.ts";
import { WORDMARK, type SignAtlas } from "../hall/signAtlas.ts";
import { SignFader, facesCamera, type SignRig } from "../hall/signVisibility.ts";
import { INSTANCE_OPACITY, INSTANCE_UV_RECT, MATERIALS } from "../materials.ts";
import { PAD, SLOT_COUNT, slotPosition } from "./layout.ts";
import { MONUMENT, padGeometry } from "./parts.ts";

// The text-bearing parts of the campus: the empty-slot pads with their numbers, and the gate
// monument's wordmark. Both draw from the shared sign atlas on the shared sign material with the
// E27 fade helper, and show only while their capital letter measures 12 CSS px or more at the
// current camera pose (the chunk 06 rule, W-RW5).

const HIDDEN = new Matrix4().makeScale(0, 0, 0);

// A pad number is 1.2 x 0.9 units with a 0.6-unit cap (WD11), painted near the pad's front edge.
const NUMBER = { width: 1.2, height: 0.9, cap: 0.6, lift: 0.05, inset: 0.75 } as const;

const bottom = new Vector3();
const top = new Vector3();
const bottomScreen = { x: 0, y: 0 };
const topScreen = { x: 0, y: 0 };

// The screen length in CSS px of a capital `cap` units tall, standing at `centre`: along y for
// text on a wall, along z for text painted on the ground (whose "up" is -z). No allocation.
export function capMeasure(
  rig: SignRig,
  centre: Vector3,
  cap: number,
  axis: "wall" | "ground",
): number {
  bottom.copy(centre);
  top.copy(centre);
  if (axis === "wall") {
    bottom.y -= cap / 2;
    top.y += cap / 2;
  } else {
    bottom.z += cap / 2;
    top.z -= cap / 2;
  }
  rig.project(bottom, bottomScreen);
  rig.project(top, topScreen);
  return Math.hypot(bottomScreen.x - topScreen.x, bottomScreen.y - topScreen.y);
}

function fadeAttributes(mesh: InstancedMesh, atlas: Float32Array, count: number) {
  const opacity = new InstancedBufferAttribute(new Float32Array(count), 1);
  mesh.geometry.setAttribute(INSTANCE_UV_RECT, new InstancedBufferAttribute(atlas, 4));
  mesh.geometry.setAttribute(INSTANCE_OPACITY, opacity);
  mesh.frustumCulled = false;
  return opacity;
}

// Writes `fader`'s opacities into `opacity`; true when any changed.
function writeOpacity(opacity: InstancedBufferAttribute, fader: SignFader, count: number) {
  let changed = false;
  for (let i = 0; i < count; i++) {
    if (opacity.getX(i) !== fader.opacity(i)) {
      opacity.setX(i, fader.opacity(i));
      changed = true;
    }
  }
  if (changed) opacity.needsUpdate = true;
}

// Twelve empty-slot pads as one InstancedMesh and their numbers 01-12 as another. A placed hall
// hides its pad and number; the instance index is the slot.
export class PadMarks {
  readonly pads: InstancedMesh;
  readonly numbers: InstancedMesh;
  readonly fader = new SignFader(SLOT_COUNT);
  private readonly opacity: InstancedBufferAttribute;
  private readonly centres: Vector3[] = [];
  private placed = SLOT_COUNT;
  private primed = false;

  constructor(atlas: Pick<SignAtlas, "padRect">) {
    this.pads = new InstancedMesh(padGeometry(), MATERIALS.site, SLOT_COUNT);
    this.pads.name = "slot-pads";
    this.pads.userData.ground = true;
    this.pads.receiveShadow = true;
    this.pads.frustumCulled = false;

    const plane = new PlaneGeometry(NUMBER.width, NUMBER.height).rotateX(-Math.PI / 2);
    this.numbers = new InstancedMesh(plane, MATERIALS.sign, SLOT_COUNT);
    this.numbers.name = "slot-numbers";
    this.numbers.userData.ground = true;
    const uv = new Float32Array(SLOT_COUNT * 4);
    for (let i = 0; i < SLOT_COUNT; i++) {
      const r = atlas.padRect(i).uv;
      uv.set([r.u, r.v, r.w, r.h], i * 4);
      const { x, z } = slotPosition(i);
      this.centres.push(new Vector3(x, NUMBER.lift, z + PAD.depth / 2 - NUMBER.inset));
      this.pads.setMatrixAt(i, new Matrix4().makeTranslation(x, 0, z));
      this.numbers.setMatrixAt(i, new Matrix4().makeTranslation(this.centres[i]));
    }
    this.opacity = fadeAttributes(this.numbers, uv, SLOT_COUNT);
    this.setPlaced(0);
  }

  // Halls fill slots 0..n-1: their pads and numbers go, the rest stay.
  setPlaced(n: number): void {
    this.placed = n;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const { x, z } = slotPosition(i);
      const empty = i >= n;
      this.pads.setMatrixAt(i, empty ? new Matrix4().makeTranslation(x, 0, z) : HIDDEN);
      this.numbers.setMatrixAt(i, empty ? new Matrix4().makeTranslation(this.centres[i]) : HIDDEN);
      if (!empty) this.fader.setTarget(i, false, 0, true);
    }
    for (const mesh of [this.pads, this.numbers]) {
      mesh.instanceMatrix.needsUpdate = true;
      // The raycast sphere covers the instances as they stand now.
      mesh.computeBoundingSphere();
    }
    writeOpacity(this.opacity, this.fader, SLOT_COUNT);
  }

  get emptySlots(): number {
    return SLOT_COUNT - this.placed;
  }

  // A number shows while its 0.6-unit capital measures 12 CSS px or more. Allocation free.
  update(rig: SignRig, now: number, snap: boolean): void {
    const cut = snap || !this.primed;
    this.primed = true;
    for (let i = this.placed; i < SLOT_COUNT; i++) {
      const visible = capMeasure(rig, this.centres[i], NUMBER.cap, "ground") >= SIGN.minLetterPx;
      this.fader.setTarget(i, visible, now, cut);
    }
    this.fader.step(now);
    writeOpacity(this.opacity, this.fader, SLOT_COUNT);
  }

  dispose(): void {
    for (const mesh of [this.pads, this.numbers]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
  }
}

const NORMAL = new Vector3(0, 0, 1);

// The gate monument's wordmark: one instance of the sign panel's plane, scaled up, on the slab's
// front face. It shows while it faces the camera and its capital measures 12 CSS px or more.
export class MonumentMark {
  readonly mesh: InstancedMesh;
  readonly fader = new SignFader(1);
  private readonly opacity: InstancedBufferAttribute;
  private readonly centre = new Vector3(MONUMENT.centre.x, MONUMENT.centre.y, MONUMENT.centre.z);
  private primed = false;

  constructor(atlas: Pick<SignAtlas, "monumentRect">) {
    this.mesh = new InstancedMesh(new PlaneGeometry(SIGN.width, SIGN.height), MATERIALS.sign, 1);
    this.mesh.name = "monument-wordmark";
    const r = atlas.monumentRect().uv;
    this.opacity = fadeAttributes(this.mesh, new Float32Array([r.u, r.v, r.w, r.h]), 1);
    this.mesh.setMatrixAt(
      0,
      new Matrix4().compose(
        this.centre,
        this.mesh.quaternion,
        new Vector3().setScalar(MONUMENT.panelScale),
      ),
    );
  }

  update(rig: SignRig, now: number, snap: boolean): void {
    const cut = snap || !this.primed;
    this.primed = true;
    const cap = WORDMARK.cap * MONUMENT.panelScale;
    const visible =
      facesCamera(rig.active, this.centre, NORMAL) &&
      capMeasure(rig, this.centre, cap, "wall") >= SIGN.minLetterPx;
    this.fader.setTarget(0, visible, now, cut);
    this.fader.step(now);
    writeOpacity(this.opacity, this.fader, 1);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.dispose();
  }
}
