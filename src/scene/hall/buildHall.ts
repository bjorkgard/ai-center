import {
  BoxGeometry,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Mesh,
  Vector3,
  type ColorRepresentation,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MATERIALS } from "../materials.ts";
import { HALL, RACK_ROW, ROOF_BOTTOM, ROOF_TOP, SIGN_CENTRE } from "./hallLayout.ts";

// Thrown instead of three's silent null when the parts do not merge, and for layouts the
// builder does not make. The scene-error path reports it (CEO W-RW13).
export class HallBuildError extends Error {
  override name = "HallBuildError";
}

// Hall greys as vertex colours on the one shared hall material. The cold aisle is a step
// lighter than the hall floor and the hot aisle a step darker (design-review Phase 3 WD10).
const COLORS = {
  slab: "#2e3748",
  wall: "#3a4559",
  roof: "#232b3a",
  door: "#161c28",
  coldAisle: "#3b4659",
  hotAisle: "#252d3b",
} as const;

const WINDOW = { width: 0.5, height: 0.35, depth: 0.04, y: 1.4 };

export interface HallOptions {
  slots: number;
  rows: number;
}

interface VertexRange {
  start: number;
  count: number;
}

export interface BuiltHall {
  // The merged body (slab, walls, roof, door, aisle tiles) on the shared hall material.
  body: Mesh;
  // The windows on the shared window glow.
  windows: Mesh;
  meshes: Mesh[];
  // Vertex ranges of the colour attribute: the aisle tiles, and everything else.
  ranges: { hall: VertexRange; aisle: VertexRange };
  // Where the sign panel's centre sits in hall-local coordinates.
  signCentre: Vector3;
  // The untinted colours, so a tint is always applied to the base and never compounds.
  base: Float32Array;
  dispose(): void;
}

// three's mergeGeometries returns null (and logs) on mismatched attributes or indexing; every
// caller would have to remember to check, so this throws instead.
export function mergeHallParts(parts: BufferGeometry[]): BufferGeometry {
  if (parts.length === 0) throw new HallBuildError("no hall parts to merge");
  const merged = mergeGeometries(parts);
  if (merged === null) {
    throw new HallBuildError(
      "hall parts have mismatched attributes or indexing and cannot merge into one body",
    );
  }
  return merged;
}

// A box centred at `at`, with its colour on every vertex and no UVs (the shader needs none).
function box(
  size: [number, number, number],
  at: [number, number, number],
  color?: string,
): BufferGeometry {
  const geometry = new BoxGeometry(...size).translate(...at);
  geometry.deleteAttribute("uv");
  if (color) {
    const c = new Color(color);
    const count = geometry.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) c.toArray(colors, i * 3);
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  }
  return geometry;
}

const vertices = (parts: BufferGeometry[]) =>
  parts.reduce((sum, p) => sum + p.getAttribute("position").count, 0);

export function buildHall(options: HallOptions): BuiltHall {
  const { slots, rows } = options;
  if (rows !== 2 || slots !== 2 * RACK_ROW.racks) {
    throw new HallBuildError(
      `buildHall supports 16 slots in 2 rows, got ${slots} slots in ${rows} rows`,
    );
  }
  const { width, depth, slabHeight, wallHeight, wallThickness: t, door } = HALL;
  const wallY = slabHeight + wallHeight / 2;
  const rowLength = RACK_ROW.racks * RACK_ROW.pitch;
  const hotZ = RACK_ROW.coldAisle / 2 + RACK_ROW.depth + RACK_ROW.hotAisle / 2;
  const tile = 0.02;
  const tileY = slabHeight + tile / 2;

  const body: BufferGeometry[] = [
    box([width, slabHeight, depth], [0, slabHeight / 2, 0], COLORS.slab),
    box([width, wallHeight, t], [0, wallY, -depth / 2 + t / 2], COLORS.wall),
    box([width, wallHeight, t], [0, wallY, depth / 2 - t / 2], COLORS.wall),
    box([t, wallHeight, depth - 2 * t], [width / 2 - t / 2, wallY, 0], COLORS.wall),
    box([t, wallHeight, depth - 2 * t], [-width / 2 + t / 2, wallY, 0], COLORS.wall),
    box(
      [door.width, door.height, door.depth],
      [0, slabHeight + door.height / 2, depth / 2 + door.depth / 2],
      COLORS.door,
    ),
    box(
      [width + 2 * HALL.roofOverhang, HALL.roofHeight, depth + 2 * HALL.roofOverhang],
      [0, (ROOF_BOTTOM + ROOF_TOP) / 2, 0],
      COLORS.roof,
    ),
  ];
  const aisle: BufferGeometry[] = [
    box([rowLength, tile, RACK_ROW.coldAisle], [0, tileY, 0], COLORS.coldAisle),
    box([rowLength, tile, RACK_ROW.hotAisle], [0, tileY, hotZ], COLORS.hotAisle),
    box([rowLength, tile, RACK_ROW.hotAisle], [0, tileY, -hotZ], COLORS.hotAisle),
  ];
  const windows: BufferGeometry[] = [];
  for (const x of [-3.2, -2.4, 2.4, 3.2]) {
    windows.push(box([WINDOW.width, WINDOW.height, WINDOW.depth], [x, WINDOW.y, depth / 2 + 0.02]));
  }
  for (const z of [-2.0, -0.8, 0.8, 2.0]) {
    windows.push(box([WINDOW.depth, WINDOW.height, WINDOW.width], [width / 2 + 0.02, WINDOW.y, z]));
  }

  const hallCount = vertices(body);
  const aisleCount = vertices(aisle);
  const bodyGeometry = mergeHallParts([...body, ...aisle]);
  const windowGeometry = mergeHallParts(windows);
  for (const part of [...body, ...aisle, ...windows]) part.dispose();

  const bodyMesh = new Mesh(bodyGeometry, MATERIALS.hall);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  bodyMesh.name = "hall-body";
  const windowMesh = new Mesh(windowGeometry, MATERIALS.window);
  windowMesh.name = "hall-windows";

  const colors = bodyGeometry.getAttribute("color");
  return {
    body: bodyMesh,
    windows: windowMesh,
    meshes: [bodyMesh, windowMesh],
    ranges: {
      hall: { start: 0, count: hallCount },
      aisle: { start: hallCount, count: aisleCount },
    },
    signCentre: new Vector3(...SIGN_CENTRE),
    base: Float32Array.from(colors.array),
    dispose() {
      bodyGeometry.dispose();
      windowGeometry.dispose();
    },
  };
}

export function hallTriangles(hall: BuiltHall): number {
  return hall.meshes.reduce((sum, mesh) => {
    const geometry = mesh.geometry;
    const count = geometry.index?.count ?? geometry.getAttribute("position").count;
    return sum + count / 3;
  }, 0);
}

// Writes base x tint into a vertex range of the colour attribute, never a material.
function tintRange(hall: BuiltHall, range: VertexRange, tint: ColorRepresentation): void {
  const target = hall.body.geometry.getAttribute("color");
  const c = new Color(tint);
  for (let i = range.start; i < range.start + range.count; i++) {
    target.setXYZ(
      i,
      hall.base[i * 3] * c.r,
      hall.base[i * 3 + 1] * c.g,
      hall.base[i * 3 + 2] * c.b,
    );
  }
  target.needsUpdate = true;
}

export const setHallTint = (hall: BuiltHall, tint: ColorRepresentation) =>
  tintRange(hall, hall.ranges.hall, tint);

export const setAisleTint = (hall: BuiltHall, tint: ColorRepresentation) =>
  tintRange(hall, hall.ranges.aisle, tint);
