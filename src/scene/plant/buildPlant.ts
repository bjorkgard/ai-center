import {
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Camera,
} from "three";
import { hash01 } from "../../sim/rng.ts";
import { INSTANCE_OPACITY, MATERIALS } from "../materials.ts";
import type { SceneSignals } from "../signals.ts";
import { chillerGeometry, fanGeometry, towerGeometry } from "./parts.ts";
import { reportPlant } from "./plantDev.ts";
import { CHILLERS, TOWER, TOWERS, type Spot } from "./plantLayout.ts";
import {
  VAPOUR,
  VapourLatch,
  particleFade,
  particleRise,
  particleSize,
  sortBackToFront,
} from "./vapour.ts";

// A fan's turn rate is read over at least this much scene time, so one frame's jitter drops out.
const FAN_WINDOW_S = 0.25;

export interface PlantLayout {
  towers: readonly Spot[];
  chillers: readonly Spot[];
}

const position = new Vector3();
const rotation = new Quaternion();
const scale = new Vector3();
const matrix = new Matrix4();
const forward = new Vector3();
const UP = new Vector3(0, 1, 0);
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

// Vapour draws as one InstancedMesh for all the towers: one draw call per tower group.
export const VAPOUR_DRAWS = 1;

// A mesh of one part, with one matrix per spot, never culled (its geometry registers once).
function placed(
  name: string,
  geometry: BufferGeometry,
  spots: readonly Spot[],
  shadow: boolean,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, MATERIALS.site, Math.max(spots.length, 1));
  mesh.name = name;
  mesh.count = spots.length;
  mesh.frustumCulled = false;
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  spots.forEach((spot, i) => {
    mesh.setMatrixAt(
      i,
      matrix.compose(position.set(spot.x, 0, spot.z), rotation.identity(), scale.setScalar(1)),
    );
  });
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

// The cooling plant (chunk 09): towers and chillers that cast shadows, a fan per tower that turns
// at the duty's speed, and the vapour: 60 soft billboards per tower, all in one InstancedMesh.
// Vapour and fans read SceneSignals at scene time; nothing here simulates or allocates per frame.
export class BuiltPlant {
  readonly group = new Group();
  readonly towers: InstancedMesh;
  readonly chillers: InstancedMesh;
  readonly fans: InstancedMesh;
  readonly vapour: InstancedMesh;
  private readonly layout: PlantLayout;
  private readonly count: number;
  private readonly latch: VapourLatch;
  private readonly opacity: InstancedBufferAttribute;
  private readonly order: Uint16Array;
  private readonly depth: Float32Array;
  private readonly size: Float32Array;
  private readonly fade: Float32Array;
  private readonly at: Float32Array;
  // Per particle: start scatter (x, z) and drift velocity (x, z), seeded.
  private readonly seeded: Float32Array;
  // The first fan's drawn turn rate, measured over windows of FAN_WINDOW_S from its matrix.
  private fanAngle = Number.NaN;
  private fanTime = 0;
  private windowTurns = 0;
  private windowTime = 0;
  private rate: number | null = null;

  constructor(seed: number, layout: PlantLayout = { towers: TOWERS, chillers: CHILLERS }) {
    this.layout = layout;
    this.count = layout.towers.length * VAPOUR.perTower;
    this.latch = new VapourLatch(this.count);
    this.towers = placed("cooling-towers", towerGeometry(), layout.towers, true);
    this.chillers = placed("chillers", chillerGeometry(), layout.chillers, true);
    this.fans = placed("cooling-fans", fanGeometry(), layout.towers, false);

    const quad = new PlaneGeometry(1, 1);
    this.opacity = new InstancedBufferAttribute(new Float32Array(this.count), 1);
    quad.setAttribute(INSTANCE_OPACITY, this.opacity);
    this.vapour = new InstancedMesh(quad, MATERIALS.vapour, Math.max(this.count, 1));
    this.vapour.name = "vapour";
    this.vapour.count = this.count;
    this.vapour.frustumCulled = false;
    // Plumes are not entities: a click or double-click goes through them to the ground.
    this.vapour.raycast = () => {};
    for (let i = 0; i < this.count; i++) this.vapour.setMatrixAt(i, HIDDEN);

    this.order = Uint16Array.from({ length: this.count }, (_, i) => i);
    this.depth = new Float32Array(this.count);
    this.size = new Float32Array(this.count);
    this.fade = new Float32Array(this.count);
    this.at = new Float32Array(this.count * 3);
    this.seeded = new Float32Array(this.count * 4);
    for (let i = 0; i < this.count; i++) {
      this.seeded[i * 4] = (hash01(seed, i, 11) - 0.5) * 2 * VAPOUR.scatter;
      this.seeded[i * 4 + 1] = (hash01(seed, i, 12) - 0.5) * 2 * VAPOUR.scatter;
      this.seeded[i * 4 + 2] = (hash01(seed, i, 13) - 0.5) * 2 * VAPOUR.drift;
      this.seeded[i * 4 + 3] = (hash01(seed, i, 14) - 0.5) * 2 * VAPOUR.drift;
    }

    this.group.name = "plant";
    this.group.add(this.towers, this.chillers, this.fans, this.vapour);
  }

  // Writes the fans' angles and the vapour for scene time `time`. `camera` turns the billboards
  // to face it and orders them far to near.
  update(signals: SceneSignals, time: number, camera: Camera, reducedMotion: boolean): void {
    const { towers } = this.layout;
    for (let t = 0; t < towers.length; t++) {
      this.fans.setMatrixAt(
        t,
        matrix.compose(
          position.set(towers[t].x, TOWER.fanY, towers[t].z),
          rotation.setFromAxisAngle(UP, signals.fanAngle(t, reducedMotion)),
          scale.setScalar(1),
        ),
      );
    }
    this.fans.instanceMatrix.needsUpdate = true;
    this.measureFan(time);

    const duty = signals.duty();
    const camAt = camera.position;
    forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
    this.latch.begin(time);
    for (let i = 0; i < this.count; i++) {
      const tower = towers[Math.floor(i / VAPOUR.perTower)];
      const age = signals.vapourPhase(i);
      const fade = this.latch.isShown(i, age, duty, reducedMotion) ? particleFade(age) : 0;
      const x = tower.x + this.seeded[i * 4] + this.seeded[i * 4 + 2] * age;
      const y = TOWER.height + 0.2 + particleRise(age);
      const z = tower.z + this.seeded[i * 4 + 1] + this.seeded[i * 4 + 3] * age;
      this.at[i * 3] = x;
      this.at[i * 3 + 1] = y;
      this.at[i * 3 + 2] = z;
      this.size[i] = particleSize(age);
      this.fade[i] = fade;
      this.depth[i] =
        (x - camAt.x) * forward.x + (y - camAt.y) * forward.y + (z - camAt.z) * forward.z;
    }
    this.latch.end();

    sortBackToFront(this.depth, this.order);
    rotation.copy(camera.quaternion);
    for (let slot = 0; slot < this.count; slot++) {
      const p = this.order[slot];
      this.vapour.setMatrixAt(
        slot,
        matrix.compose(
          position.set(this.at[p * 3], this.at[p * 3 + 1], this.at[p * 3 + 2]),
          rotation,
          scale.setScalar(this.fade[p] > 0 ? this.size[p] : 0),
        ),
      );
      this.opacity.setX(slot, this.fade[p]);
    }
    this.vapour.instanceMatrix.needsUpdate = true;
    this.opacity.needsUpdate = true;
    reportPlant(duty, this.rate);
  }

  // Reads the first fan's angle back from the matrix just drawn and turns the change into turns a
  // second. A step is below half a turn, so the wrapped difference is the real one.
  private measureFan(time: number): void {
    if (this.fans.count === 0) return;
    const m = this.fans.instanceMatrix.array;
    const angle = Math.atan2(m[8], m[0]);
    const step = time - this.fanTime;
    if (!Number.isNaN(this.fanAngle) && step > 0) {
      let turned = angle - this.fanAngle;
      if (turned > Math.PI) turned -= 2 * Math.PI;
      else if (turned < -Math.PI) turned += 2 * Math.PI;
      this.windowTurns += turned / (2 * Math.PI);
      this.windowTime += step;
      if (this.windowTime >= FAN_WINDOW_S) {
        this.rate = this.windowTurns / this.windowTime;
        this.windowTurns = 0;
        this.windowTime = 0;
      }
    }
    this.fanAngle = angle;
    this.fanTime = time;
  }

  // The first fan's turns a second as drawn, or null until a window of time has passed.
  get fanTurnRate(): number | null {
    return this.rate;
  }

  // How many vapour particles are drawn now (opacity above 0), for the tests and the dev hook.
  get shownParticles(): number {
    let n = 0;
    for (let slot = 0; slot < this.count; slot++) if (this.opacity.getX(slot) > 0) n++;
    return n;
  }

  dispose(): void {
    for (const mesh of [this.towers, this.chillers, this.fans, this.vapour]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
  }
}

export function buildPlant(seed: number, layout?: PlantLayout): BuiltPlant {
  return new BuiltPlant(seed, layout);
}
