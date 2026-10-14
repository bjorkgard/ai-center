import { Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3 } from "three";
import { MATERIALS } from "../materials.ts";
import type { SceneSignals } from "../signals.ts";
import { reportNetwork } from "./networkDev.ts";
import { PACKET, packetCount } from "./packets.ts";
import { junctionBoxGeometry, packetGeometry, tubeGeometry } from "./parts.ts";
import { buildNetwork, type FibreNetwork } from "./route.ts";

const position = new Vector3();
const rotation = new Quaternion();
const scale = new Vector3();
const matrix = new Matrix4();
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

// A packet's speed is measured over at least this much scene time, so one frame's jitter drops
// out; a step longer than this is a wrap or a jump, not travel.
const SPEED_WINDOW_S = 0.5;
const MAX_STEP = 1;

// One line's centre line as flat arrays, so the frame loop reads it without allocating.
interface Track {
  xyz: Float32Array;
  along: Float32Array;
  length: number;
}

function trackOf(points: readonly (readonly number[])[], length: number): Track {
  const xyz = new Float32Array(points.length * 3);
  const along = new Float32Array(points.length);
  points.forEach((p, i) => {
    xyz.set(p, i * 3);
    if (i > 0) {
      const q = points[i - 1];
      along[i] = along[i - 1] + Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    }
  });
  return { xyz, along, length };
}

// Writes the point `d` along `track` into `out`.
function pointAt(track: Track, d: number, out: Vector3): Vector3 {
  const { along, xyz } = track;
  let lo = 0;
  let hi = along.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (along[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = along[hi] - along[lo];
  const f = span > 0 ? (d - along[lo]) / span : 0;
  return out.set(
    xyz[lo * 3] + (xyz[hi * 3] - xyz[lo * 3]) * f,
    xyz[lo * 3 + 1] + (xyz[hi * 3 + 1] - xyz[lo * 3 + 1]) * f,
    xyz[lo * 3 + 2] + (xyz[hi * 3 + 2] - xyz[lo * 3 + 2]) * f,
  );
}

// The fibre network (chunk 10) for the first `placed` halls: tubes from the vault to each hall's
// door side, grey boxes at the junctions and entries, and the packets. Three draws: the tubes, the
// boxes and one InstancedMesh for every line's packets. None casts a shadow or takes a click.
// The geometry is built once per hall set; a changed set builds a new one and disposes this.
export class BuiltFibre {
  readonly group = new Group();
  readonly network: FibreNetwork;
  readonly tubes: Mesh;
  readonly boxes: InstancedMesh;
  readonly packets: InstancedMesh;
  private readonly tracks: Track[];
  private lastAt = new Vector3();
  private lastTime = Number.NaN;
  private windowDistance = 0;
  private windowTime = 0;
  private speed: number | null = null;

  constructor(placed: number) {
    this.network = buildNetwork(placed);
    const { lines, chains, junctions, entries } = this.network;
    this.tracks = lines.map((line) => trackOf(line.rounded, line.length));

    this.tubes = new Mesh(tubeGeometry(chains.map((c) => c.rounded)), MATERIALS.fibre);
    this.tubes.name = "fibre-tubes";

    const spots = junctions.length + entries.length;
    this.boxes = new InstancedMesh(junctionBoxGeometry(), MATERIALS.site, spots);
    this.boxes.name = "fibre-boxes";
    rotation.identity();
    junctions.forEach((p, i) => {
      this.boxes.setMatrixAt(
        i,
        matrix.compose(position.set(p[0], p[1], p[2]), rotation, scale.setScalar(1)),
      );
    });
    entries.forEach((e, i) => {
      // An entry box is flat against the wall.
      this.boxes.setMatrixAt(
        junctions.length + i,
        matrix.compose(position.set(e.x, e.y, e.z), rotation, scale.set(1, 1, 0.6)),
      );
    });
    this.boxes.instanceMatrix.needsUpdate = true;

    this.packets = new InstancedMesh(packetGeometry(), MATERIALS.packet, lines.length * PACKET.cap);
    this.packets.name = "packets";
    for (let i = 0; i < this.packets.count; i++) this.packets.setMatrixAt(i, HIDDEN);

    for (const mesh of [this.tubes, this.boxes, this.packets]) {
      // Fibre is not an entity: a click or double-click goes through it to the ground.
      mesh.raycast = () => {};
      this.group.add(mesh);
    }
    this.boxes.frustumCulled = false;
    this.packets.frustumCulled = false;
    this.group.name = "fibre";
  }

  get lineCount(): number {
    return this.network.lines.length;
  }

  // Writes every packet for scene time `time`: line l shows packetCount(length, rate) of them, each
  // at its wrapped, evenly spaced phase along the line's centre line.
  update(signals: SceneSignals, time: number, reducedMotion: boolean): void {
    const rate = signals.packetRate();
    rotation.identity();
    for (let l = 0; l < this.tracks.length; l++) {
      const track = this.tracks[l];
      const shown = packetCount(track.length, rate);
      for (let j = 0; j < PACKET.cap; j++) {
        const slot = l * PACKET.cap + j;
        if (j >= shown) {
          this.packets.setMatrixAt(slot, HIDDEN);
          continue;
        }
        const d = signals.packetPhase(l, j, track.length, shown, reducedMotion);
        this.packets.setMatrixAt(
          slot,
          matrix.compose(pointAt(track, d, position), rotation, scale.setScalar(1)),
        );
      }
    }
    this.packets.instanceMatrix.needsUpdate = true;
    this.measure(time);
    reportNetwork(this.lineCount, this.speed);
  }

  // Reads the first packet of the first line back from the matrix just drawn and turns its steps
  // into units a second. Steps that are a wrap or a jump (longer than MAX_STEP) are left out.
  private measure(time: number): void {
    const m = this.packets.instanceMatrix.array;
    if (this.packets.count === 0 || m[0] === 0) {
      this.lastTime = Number.NaN;
      return;
    }
    position.set(m[12], m[13], m[14]);
    const dt = time - this.lastTime;
    if (!Number.isNaN(dt) && dt > 0) {
      const step = position.distanceTo(this.lastAt);
      if (step <= MAX_STEP) {
        this.windowDistance += step;
        this.windowTime += dt;
        if (this.windowTime >= SPEED_WINDOW_S) {
          this.speed = this.windowDistance / this.windowTime;
          this.windowDistance = 0;
          this.windowTime = 0;
        }
      }
    }
    this.lastAt.copy(position);
    this.lastTime = time;
  }

  // The first packet's speed in units a second as drawn, or null until a window has passed.
  get packetSpeed(): number | null {
    return this.speed;
  }

  // How many packets are drawn now (not scaled to nothing), for the tests.
  get shownPackets(): number {
    const m = this.packets.instanceMatrix.array;
    let n = 0;
    for (let slot = 0; slot < this.packets.count; slot++) if (m[slot * 16] !== 0) n++;
    return n;
  }

  dispose(): void {
    for (const mesh of [this.tubes, this.boxes, this.packets]) mesh.geometry.dispose();
    this.boxes.dispose();
    this.packets.dispose();
  }
}

export function buildFibre(placed: number): BuiltFibre {
  return new BuiltFibre(placed);
}
