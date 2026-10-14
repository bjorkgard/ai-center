import { ROAD_COLS, ROAD_ROWS, SLOT_COUNT, hallDoor, slotPosition, type Rect } from "./layout.ts";

// The waypoint graph vehicles will drive (used from later chunks): the gate, the loading dock,
// every hall door and the road crossings between them (CEO W-RW9). Pure: no three import.
export interface Waypoint {
  id: string;
  kind: "gate" | "dock" | "door" | "road";
  x: number;
  z: number;
}

export interface WaypointGraph {
  nodes: Waypoint[];
  edges: [string, string][];
}

// The door node stands just in front of the wall, off the slab.
const DOOR_STEP = 0.2;
const GATE_Z = 24;
const DOCK_X = 30;

const roadId = (x: number, z: number) => `road-${x}-${z}`;

export function buildWaypoints(): WaypointGraph {
  const nodes: Waypoint[] = [];
  const edges: [string, string][] = [];
  const add = (node: Waypoint) => nodes.push(node);

  for (const z of ROAD_ROWS) {
    for (const x of ROAD_COLS) add({ id: roadId(x, z), kind: "road", x, z });
  }
  add({ id: "gate", kind: "gate", x: 0, z: GATE_Z });
  add({ id: "dock", kind: "dock", x: DOCK_X, z: 4.5 });

  // Each hall's door node, and the node on the road in front of it that it joins.
  const approach = new Map<number, Waypoint[]>();
  for (let i = 0; i < SLOT_COUNT; i++) {
    const { x, z } = slotPosition(i);
    const door = hallDoor(i);
    const road = z + 4.5;
    add({ id: `door-${i}`, kind: "door", x: door.x, z: door.z + DOOR_STEP });
    const node: Waypoint = { id: `approach-${i}`, kind: "road", x, z: road };
    add(node);
    edges.push([`door-${i}`, node.id]);
    approach.set(road, [...(approach.get(road) ?? []), node]);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Along a road, consecutive nodes are joined: the crossings, the approaches and the dock or gate.
  const chain = (line: Waypoint[], axis: "x" | "z") => {
    const sorted = [...line].sort((a, b) => a[axis] - b[axis]);
    for (let i = 1; i < sorted.length; i++) edges.push([sorted[i - 1].id, sorted[i].id]);
  };
  for (const z of ROAD_ROWS) {
    const line = ROAD_COLS.map((x) => byId.get(roadId(x, z))!).concat(approach.get(z) ?? []);
    if (z === 4.5) line.push(byId.get("dock")!);
    chain(line, "x");
  }
  for (const x of ROAD_COLS) {
    const line = ROAD_ROWS.map((z) => byId.get(roadId(x, z))!);
    if (x === 0) line.push(byId.get("gate")!);
    chain(line, "z");
  }
  return { nodes, edges };
}

// The ids from `from` to `to` along the fewest edges, or null when there is no path.
export function findPath(graph: WaypointGraph, from: string, to: string): string[] | null {
  const ids = new Set(graph.nodes.map((n) => n.id));
  if (!ids.has(from) || !ids.has(to)) return null;
  const next = new Map<string, string[]>();
  for (const [a, b] of graph.edges) {
    next.set(a, [...(next.get(a) ?? []), b]);
    next.set(b, [...(next.get(b) ?? []), a]);
  }
  const came = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    if (id === to) break;
    for (const n of next.get(id) ?? []) {
      if (!came.has(n)) {
        came.set(n, id);
        queue.push(n);
      }
    }
  }
  if (!came.has(to)) return null;
  const path: string[] = [];
  for (let id: string | null = to; id !== null; id = came.get(id) ?? null) path.unshift(id);
  return path;
}

// Whether the segment p-q passes through the inside of the rectangle; touching its edge or
// running along it does not count.
export function segmentCrossesRect(
  p: { x: number; z: number },
  q: { x: number; z: number },
  rect: Rect,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const axes: [number, number, number, number][] = [
    [p.x, q.x - p.x, rect.minX, rect.maxX],
    [p.z, q.z - p.z, rect.minZ, rect.maxZ],
  ];
  for (const [start, delta, lo, hi] of axes) {
    if (delta === 0) {
      if (start <= lo || start >= hi) return false;
      continue;
    }
    const a = (lo - start) / delta;
    const b = (hi - start) / delta;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t1 - t0 > 1e-9;
}
