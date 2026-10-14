import {
  MIN_PLACED,
  ROAD_COLS,
  ROAD_ROWS,
  ROAD_WIDTH,
  SLOT_COUNT,
  hallDoor,
  slotPosition,
} from "../campus/layout.ts";
import { VAULT } from "../power/powerLayout.ts";

// The fibre routes (CEO W-RW11, design-review Phase 3 WD8): from the vault along the road in front
// of hall row 0, then up the column road beside a hall's column, then along the road in front of
// its row to the door side, where the last 0.6 units climb the wall to an entry box. Pure
// numbers, no three import: the tests, the tube builder and the packets read them. Lines that
// start the same way share their tubes; a junction box stands where they part.
export type Vec3 = readonly [number, number, number];

export const FIBRE = {
  radius: 0.05,
  // The road top is 0.03 (campus/parts.ts); the tube lies 0.03 above it, its centre one radius up.
  lift: 0.03,
  y: 0.11,
  // Tube centres run this far in from the kerb of the road.
  kerbInset: 0.4,
  bend: 0.6,
  climb: 0.6,
  // The climb stands beside the door, not in front of it, and a hair off the wall.
  doorOffset: 0.8,
  wallGap: 0.06,
} as const;

// An arc is cut into segments about this long.
const ARC_STEP = 0.35;
const HALF_LANE = ROAD_WIDTH / 2 - FIBRE.kerbInset;

export interface FibreLine {
  slot: number;
  // The vertices: where the line starts, turns, meets a junction and ends.
  points: Vec3[];
  // The same path with its bends rounded, and the length of that.
  rounded: Vec3[];
  length: number;
}

export interface FibreChain {
  // A tube between two junctions (or the vault, or an entry box), bends rounded.
  rounded: Vec3[];
}

export interface FibreNetwork {
  lines: FibreLine[];
  chains: FibreChain[];
  junctions: Vec3[];
  // The entry box of every line, at the top of its climb.
  entries: { slot: number; x: number; y: number; z: number }[];
}

const sub = (a: Vec3, b: Vec3): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);

export function pathLength(points: readonly Vec3[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += len(sub(points[i], points[i - 1]));
  return sum;
}

// Replaces each corner that is not `sharp` by a quarter arc of `radius`, shortened to half of the
// shorter leg beside it so two neighbouring bends never overlap. Corners at a junction stay sharp:
// a tube ends there, so a line and its tubes bend the same way.
export function roundPath(
  points: readonly Vec3[],
  sharp: readonly boolean[],
  radius: number,
): Vec3[] {
  const out: Vec3[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const back = sub(p, points[i - 1]);
    const ahead = sub(points[i + 1], p);
    const a = len(back);
    const b = len(ahead);
    const d1 = back.map((v) => v / a);
    const d2 = ahead.map((v) => v / b);
    const straight = Math.abs(d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) > 1 - 1e-9;
    if (sharp[i] || straight) {
      out.push(p);
      continue;
    }
    const r = Math.min(radius, a / 2, b / 2);
    const steps = Math.max(1, Math.ceil(((Math.PI / 2) * r) / ARC_STEP));
    // The arc runs about the centre `c` from the point r before the corner to r after it.
    const c = [0, 1, 2].map((k) => p[k] - d1[k] * r + d2[k] * r);
    for (let s = 0; s <= steps; s++) {
      const theta = ((Math.PI / 2) * s) / steps;
      out.push(
        [0, 1, 2].map(
          (k) => c[k] - d2[k] * r * Math.cos(theta) + d1[k] * r * Math.sin(theta),
        ) as unknown as Vec3,
      );
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

const idOf = (p: Vec3) => p.map((v) => v.toFixed(3)).join(",");

// Where hall `slot`'s line runs, node by node, from the vault to the top of the climb. Every node
// on a path lies on the road lanes, so two paths that share a node share the way to it.
function nodePath(slot: number): Vec3[] {
  const { col, row } = slotPosition(slot);
  const y = FIBRE.y;
  const laneZ = (r: number) => ROAD_ROWS[r] - HALF_LANE;
  const laneX = (c: number) => ROAD_COLS[c] + HALF_LANE;
  const doorX = (c: number) => slotPosition(c).x + FIBRE.doorOffset;
  const exit = VAULT.x + VAULT.width / 2 - 0.2;

  // The spine along the first road row: the vault, then each column's lane and each row 0 door.
  const spine: number[] = [exit];
  for (let c = 0; c <= col; c++) spine.push(laneX(c), doorX(c));
  const stop = row === 0 ? doorX(col) : laneX(col);
  const path: Vec3[] = spine.filter((x) => x <= stop + 1e-9).map((x) => [x, y, laneZ(0)]);
  for (let r = 1; r <= row; r++) path.push([laneX(col), y, laneZ(r)]);
  if (row > 0) path.push([doorX(col), y, laneZ(row)]);
  const wall = hallDoor(slot).z + FIBRE.wallGap;
  path.push([doorX(col), y, wall], [doorX(col), y + FIBRE.climb, wall]);
  return path;
}

// The network for the first `placed` slots (A and B always). Pure: the same count always gives
// the same lines.
export function buildNetwork(placed: number): FibreNetwork {
  if (!Number.isInteger(placed) || placed < MIN_PLACED || placed > SLOT_COUNT) {
    throw new RangeError(`placed halls must be a whole number ${MIN_PLACED}-${SLOT_COUNT}`);
  }
  const paths = Array.from({ length: placed }, (_, slot) => nodePath(slot));

  // The union of the paths is a tree rooted at the vault.
  const children = new Map<string, string[]>();
  const at = new Map<string, Vec3>();
  const degree = new Map<string, number>();
  for (const path of paths) {
    path.forEach((p, i) => {
      const id = idOf(p);
      at.set(id, p);
      if (i === 0) return;
      const parent = idOf(path[i - 1]);
      const kids = children.get(parent) ?? [];
      if (!kids.includes(id)) {
        kids.push(id);
        children.set(parent, kids);
        degree.set(parent, (degree.get(parent) ?? 0) + 1);
        degree.set(id, (degree.get(id) ?? 0) + 1);
      }
    });
  }
  const isJunction = (id: string) => (degree.get(id) ?? 0) >= 3;

  // The vertices of a run of nodes: its ends, its junctions and its turns.
  const vertices = (run: readonly Vec3[]) => {
    const points: Vec3[] = [];
    const sharp: boolean[] = [];
    run.forEach((p, i) => {
      const edge = i === 0 || i === run.length - 1;
      let corner = false;
      if (!edge) {
        const a = sub(p, run[i - 1]);
        const b = sub(run[i + 1], p);
        corner = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) < len(a) * len(b) - 1e-9;
      }
      if (edge || corner || isJunction(idOf(p))) {
        points.push(p);
        sharp.push(isJunction(idOf(p)));
      }
    });
    return { points, sharp };
  };

  const lines: FibreLine[] = paths.map((path, slot) => {
    const { points, sharp } = vertices(path);
    const rounded = roundPath(points, sharp, FIBRE.bend);
    return { slot, points, rounded, length: pathLength(rounded) };
  });

  const rootId = idOf(paths[0][0]);
  const chains: FibreChain[] = [];
  for (const [id, p] of at) {
    if (id !== rootId && !isJunction(id)) continue;
    for (const first of children.get(id) ?? []) {
      const run: Vec3[] = [p];
      let next: string | undefined = first;
      while (next !== undefined) {
        run.push(at.get(next)!);
        next = isJunction(next) ? undefined : children.get(next)?.[0];
      }
      const { points } = vertices(run);
      chains.push({
        rounded: roundPath(
          points,
          points.map(() => false),
          FIBRE.bend,
        ),
      });
    }
  }

  return {
    lines,
    chains,
    junctions: [...at].filter(([id]) => isJunction(id)).map(([, p]) => p),
    entries: lines.map((line) => {
      const [x, y, z] = line.points[line.points.length - 1];
      return { slot: line.slot, x, y, z };
    }),
  };
}
