import { BoxGeometry, Color, InstancedMesh, Matrix4, Quaternion, Vector3 } from "three";
import { MATERIALS, STATUS_ORDER, statusLed, type Status } from "../materials.ts";
import type { SceneSignals } from "../signals.ts";
import { HALL } from "./hallLayout.ts";
import { ledLevel } from "./ledPulse.ts";
import {
  LEDS_PER_RACK,
  RACK,
  RACK_SLOTS,
  BLADES,
  LED_DEPTH,
  ledBox,
  slotPose,
} from "./rackLayout.ts";
import { SlotAllocator } from "./slots.ts";

// Rack bodies, origin at the base centre so a matrix only places them.
export function rackGeometry(): BoxGeometry {
  return new BoxGeometry(RACK.width, RACK.height, RACK.depth).translate(0, RACK.height / 2, 0);
}

// A unit box: each LED's matrix scales it to a strip or a blade.
export function ledGeometry(): BoxGeometry {
  return new BoxGeometry(1, 1, 1);
}

const HIDDEN = new Matrix4().makeScale(0, 0, 0);

// The D17 status colours as linear rgb, read once from the shared LED materials.
const RGB = Object.fromEntries(
  STATUS_ORDER.map((status) => {
    const c: Color = statusLed(status).emissive;
    return [status, [c.r, c.g, c.b]];
  }),
) as Record<Status, number[]>;

// An unlit blade: nearly black, so only a lit one reads.
const UNLIT = [0.012, 0.014, 0.02];

const RACK_KEYS = Array.from({ length: RACK_SLOTS }, (_, i) => `rack-${i}`);

const position = new Vector3();
const rotation = new Quaternion();
const scale = new Vector3();
const matrix = new Matrix4();
const UP = new Vector3(0, 1, 0);

// One hall's racks: an InstancedMesh of 16 bodies and one of 208 LEDs (a strip and 12 blades per
// rack), allocated once. A count change writes only `count` and instance attributes, so the
// geometry, the attributes and the draw calls stay as they are (CEO W-RW8). Positions are
// hall-local; the hall's group places them.
export class RackInstances {
  readonly racks: InstancedMesh;
  readonly leds: InstancedMesh;
  readonly allocator = new SlotAllocator(RACK_SLOTS);

  constructor() {
    this.racks = new InstancedMesh(rackGeometry(), MATERIALS.rack, RACK_SLOTS);
    this.leds = new InstancedMesh(ledGeometry(), MATERIALS.led, RACK_SLOTS * LEDS_PER_RACK);
    this.racks.name = "hall-racks";
    this.leds.name = "hall-leds";
    this.racks.castShadow = true;
    this.racks.receiveShadow = true;
    this.leds.castShadow = false;
    // Always drawn, never culled: the geometry registers with the renderer once, and a count of
    // 0 draws nothing.
    this.racks.frustumCulled = false;
    this.leds.frustumCulled = false;
    const black = new Color(0, 0, 0);
    for (let i = 0; i < RACK_SLOTS; i++) this.racks.setMatrixAt(i, HIDDEN);
    for (let i = 0; i < RACK_SLOTS * LEDS_PER_RACK; i++) {
      this.leds.setMatrixAt(i, HIDDEN);
      this.leds.setColorAt(i, black);
    }
    this.racks.count = 0;
    this.leds.count = 0;
  }

  // Racks for `keys`: each keeps its slot, new keys take the lowest free ones.
  setKeys(keys: readonly string[]): void {
    const before = Array.from({ length: RACK_SLOTS }, (_, slot) => this.allocator.keyAt(slot));
    this.allocator.sync(keys);
    for (let slot = 0; slot < RACK_SLOTS; slot++) {
      if (before[slot] !== this.allocator.keyAt(slot))
        this.place(slot, this.allocator.isUsed(slot));
    }
    this.racks.count = this.allocator.highest;
    this.leds.count = this.allocator.highest * LEDS_PER_RACK;
    this.racks.instanceMatrix.needsUpdate = true;
    this.leds.instanceMatrix.needsUpdate = true;
  }

  // racks 0..n-1, the dev slider and the fake count; no-op when already there.
  setRackCount(n: number): void {
    const count = Math.min(Math.max(Math.trunc(n) || 0, 0), RACK_SLOTS);
    if (count === this.allocator.used && this.allocator.highest === count) return;
    this.setKeys(RACK_KEYS.slice(0, count));
  }

  // The strip colour of the rack in `slot` as last written, or null when no rack stands there.
  ledColor(slot: number): [number, number, number] | null {
    if (!this.allocator.isUsed(slot)) return null;
    const colour = this.leds.instanceColor!;
    const i = slot * LEDS_PER_RACK;
    return [colour.getX(i), colour.getY(i), colour.getZ(i)];
  }

  get rackCount(): number {
    return this.racks.count;
  }

  // Writes a slot's rack and 13 LED matrices, or hides them.
  private place(slot: number, used: boolean): void {
    if (!used) {
      this.racks.setMatrixAt(slot, HIDDEN);
      for (let k = 0; k < LEDS_PER_RACK; k++) {
        this.leds.setMatrixAt(slot * LEDS_PER_RACK + k, HIDDEN);
        this.leds.instanceColor!.setXYZ(slot * LEDS_PER_RACK + k, 0, 0, 0);
      }
      this.leds.instanceColor!.needsUpdate = true;
      return;
    }
    const pose = slotPose(slot);
    rotation.setFromAxisAngle(UP, pose.facing === 1 ? 0 : Math.PI);
    position.set(pose.x, HALL.slabHeight, pose.z);
    scale.set(1, 1, 1);
    this.racks.setMatrixAt(slot, matrix.compose(position, rotation, scale));
    for (let k = 0; k < LEDS_PER_RACK; k++) {
      const box = ledBox(k);
      position.set(
        pose.x + pose.facing * box.x,
        HALL.slabHeight + box.y,
        pose.z + pose.facing * box.z,
      );
      scale.set(box.width, box.height, LED_DEPTH);
      this.leds.setMatrixAt(slot * LEDS_PER_RACK + k, matrix.compose(position, rotation, scale));
    }
  }

  // Colours every occupied rack's LEDs from the signals at scene time `t`: the status colour
  // times the pulse level, dark for unlit blades. Allocation free (it runs every frame), and it
  // flags the upload only when a value changed.
  update(signals: Pick<SceneSignals, "ledLoad">, hall: number, t: number, reducedMotion: boolean) {
    const colour = this.leds.instanceColor!;
    let changed = false;
    const write = (i: number, rgb: readonly number[], level: number) => {
      const r = rgb[0] * level;
      const g = rgb[1] * level;
      const b = rgb[2] * level;
      if (
        colour.getX(i) !== Math.fround(r) ||
        colour.getY(i) !== Math.fround(g) ||
        colour.getZ(i) !== Math.fround(b)
      ) {
        colour.setXYZ(i, r, g, b);
        changed = true;
      }
    };
    for (let slot = 0; slot < this.racks.count; slot++) {
      if (!this.allocator.isUsed(slot)) continue;
      const load = signals.ledLoad(hall, slot);
      const level = ledLevel(load.load, load.phase, t, reducedMotion);
      const base = slot * LEDS_PER_RACK;
      write(base, RGB[load.status], level);
      for (let b = 0; b < BLADES; b++) {
        const status = load.blades[b];
        if (status === undefined) write(base + 1 + b, UNLIT, 1);
        else write(base + 1 + b, RGB[status], level);
      }
    }
    if (changed) colour.needsUpdate = true;
  }

  dispose(): void {
    this.racks.geometry.dispose();
    this.leds.geometry.dispose();
    this.racks.dispose();
    this.leds.dispose();
  }
}
