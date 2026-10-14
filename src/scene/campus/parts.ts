import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SIGN } from "../hall/hallLayout.ts";
import { SITE_COLORS } from "../materials.ts";
import { PAD, PARKING_BAYS, ROADS, ZONES } from "./layout.ts";

// The geometry of the site parts, built once. Every part is low poly with its colour in a colour
// attribute, so each group merges into one mesh on one shared material (eng-review Phase 3 D1,
// E28 triangle caps: car 120, lamp 60, tree 60, fence bay 24, gate 400, dock 600, monument 100).

export class CampusBuildError extends Error {
  override name = "CampusBuildError";
}

export function triangleCount(geometry: BufferGeometry): number {
  return (geometry.index?.count ?? geometry.getAttribute("position").count) / 3;
}

// three's mergeGeometries returns null on mismatched attributes; this throws, as buildHall does.
function merge(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts);
  if (merged === null) throw new CampusBuildError("campus parts have mismatched attributes");
  for (const part of parts) part.dispose();
  return merged;
}

// Colours every vertex of `geometry` and drops its UVs, which no campus material reads.
function painted(geometry: BufferGeometry, hex: string): BufferGeometry {
  geometry.deleteAttribute("uv");
  const c = new Color(hex);
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) c.toArray(colors, i * 3);
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return geometry;
}

const box = (size: [number, number, number], at: [number, number, number], hex: string) =>
  painted(new BoxGeometry(...size).translate(...at), hex);

const plain = (geometry: BufferGeometry) => {
  geometry.deleteAttribute("uv");
  return geometry;
};

// Flat surfaces sit just above the ground plane: the road top, then the paint on it.
const ROAD_TOP = 0.03;
const PAINT = 0.012;

// Roads, aprons and their paint, merged. Flat and not an entity, so it carries `userData.ground`.
export function roadGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = ROADS.map((r) =>
    box(
      [r.maxX - r.minX, ROAD_TOP, r.maxZ - r.minZ],
      [(r.minX + r.maxX) / 2, ROAD_TOP / 2, (r.minZ + r.maxZ) / 2],
      SITE_COLORS.road,
    ),
  );
  const paint = (size: [number, number, number], x: number, z: number) =>
    parts.push(box(size, [x, ROAD_TOP + PAINT / 2, z], SITE_COLORS.marking));
  // Parking bay lines, one more than the bays in each row.
  const { minX, maxX } = ZONES.parking;
  for (const z of PARKING_BAYS.rowZ) {
    for (let x = minX + 1.2; x <= maxX - 0.4 + 1e-9; x += PARKING_BAYS.width) {
      paint([0.06, PAINT, PARKING_BAYS.length], x, z);
    }
  }
  // The stop line at the boom and the bay lines on the dock apron.
  paint([3, PAINT, 0.15], 0, 22.4);
  for (const z of [-6, -2, 2, 6]) paint([5, PAINT, 0.06], 30.5, z);
  return merge(parts);
}

// The security gate (CEO W-RW3's neighbour, chunk 08): booth on a kerb island, a barrier boom
// across the gate road resting down, with warm-white stripes.
export function gateParts(): BufferGeometry[] {
  const { wall, roofSlab, marking, boom, boomStripe } = SITE_COLORS;
  const parts = [
    box([2.8, 0.12, 2.6], [-3.4, 0.06, 20.6], marking),
    box([2.0, 2.2, 1.8], [-3.4, 1.22, 20.6], wall),
    box([2.5, 0.12, 2.3], [-3.4, 2.38, 20.6], roofSlab),
    box([0.3, 1.0, 0.3], [-1.7, 0.5, 21], boom),
    box([0.2, 0.9, 0.2], [1.75, 0.45, 21], boom),
  ];
  for (let k = 0; k < 6; k++) {
    parts.push(box([0.5, 0.12, 0.12], [-1.25 + k * 0.5, 1.0, 21], k % 2 === 0 ? boomStripe : boom));
  }
  return parts;
}

// The loading dock on the hall grid's right flank: a low building with three bay doors facing -x,
// each with a lintel, two bumpers and a dock leveller.
export function dockParts(): BufferGeometry[] {
  const { wall, roofSlab, door, marking } = SITE_COLORS;
  const parts = [
    box([5.8, 3, 13], [36.85, 1.5, 0], wall),
    box([6, 0.15, 13.2], [36.85, 3.075, 0], roofSlab),
  ];
  for (const z of [-4, 0, 4]) {
    parts.push(
      box([0.08, 2.2, 2.2], [33.86, 1.1, z], door),
      box([0.2, 0.25, 2.6], [33.8, 2.3, z], marking),
      box([0.3, 0.5, 0.5], [33.65, 0.25, z - 1.3], door),
      box([0.3, 0.5, 0.5], [33.65, 0.25, z + 1.3], door),
      box([1.2, 0.04, 2.0], [33.1, ROAD_TOP + 0.02, z], marking),
    );
  }
  return parts;
}

// The gate monument: a plinth and a slab; its wordmark is a panel in front of the slab, drawn
// from the sign atlas under the 12 px pose rule (design-review Phase 3 D18, WD12).
const SLAB = { x: 3.8, z: 24.6, width: 4.2, height: 1.5, depth: 0.5, plinth: 0.3 };
const PANEL_SCALE = 1.25;

export const MONUMENT = {
  panelScale: PANEL_SCALE,
  panelWidth: SIGN.width * PANEL_SCALE,
  panelHeight: SIGN.height * PANEL_SCALE,
  // The panel's centre: on the slab's front face, a hair off it.
  centre: { x: SLAB.x, y: SLAB.plinth + SLAB.height / 2, z: SLAB.z + SLAB.depth / 2 + 0.012 },
} as const;

export function monumentParts(): BufferGeometry[] {
  return [
    box([4.4, SLAB.plinth, 1.0], [SLAB.x, SLAB.plinth / 2, SLAB.z], SITE_COLORS.marking),
    box(
      [SLAB.width, SLAB.height, SLAB.depth],
      [SLAB.x, SLAB.plinth + SLAB.height / 2, SLAB.z],
      SITE_COLORS.monument,
    ),
  ];
}

// Gate, dock and monument in one mesh: they do not cast shadows (CEO W-RW23), so one draw.
export function furnitureGeometry(): BufferGeometry {
  return merge([...gateParts(), ...dockParts(), ...monumentParts()]);
}

// One empty-slot pad: a plate with its outline, a step above the ground (WD11).
export function padGeometry(): BufferGeometry {
  const { width, depth, outline } = PAD;
  const y = ROAD_TOP + PAINT / 2;
  return merge([
    box([width, ROAD_TOP, depth], [0, ROAD_TOP / 2, 0], SITE_COLORS.padFace),
    box([width, PAINT, outline], [0, y, -(depth - outline) / 2], SITE_COLORS.padLine),
    box([width, PAINT, outline], [0, y, (depth - outline) / 2], SITE_COLORS.padLine),
    box([outline, PAINT, depth - 2 * outline], [-(width - outline) / 2, y, 0], SITE_COLORS.padLine),
    box([outline, PAINT, depth - 2 * outline], [(width - outline) / 2, y, 0], SITE_COLORS.padLine),
  ]);
}

// A parked car, about 4.5 m long and 1.8 m wide at 1.8 m to the unit, its length along z. The body
// is white so each instance's colour (one of three dark greys) is the paint; glass and wheels are
// near black. Lights are off: nothing here emits.
export function carGeometry(): BufferGeometry {
  const dark = SITE_COLORS.carGlass;
  const parts = [
    box([1.0, 0.4, 2.4], [0, 0.32, 0], "#ffffff"),
    box([0.86, 0.28, 1.2], [0, 0.66, -0.1], dark),
  ];
  for (const x of [-0.5, 0.5]) {
    for (const z of [-0.8, 0.8]) parts.push(box([0.12, 0.28, 0.42], [x, 0.14, z], dark));
  }
  return merge(parts);
}

// A lamp post and its head are two instanced meshes (the head on the shared warm glow).
export function lampPostGeometry(): BufferGeometry {
  return plain(new CylinderGeometry(0.05, 0.07, 2.2, 6, 1).translate(0, 1.1, 0));
}

export function lampHeadGeometry(): BufferGeometry {
  return plain(new BoxGeometry(0.4, 0.1, 0.28).translate(0, 2.25, 0));
}

// One low-poly tree: a trunk and two cones, in one geometry with a colour attribute, so one
// material and one instanced draw serve every tree.
export function treeGeometry(): BufferGeometry {
  return merge([
    box([0.18, 0.45, 0.18], [0, 0.225, 0], SITE_COLORS.trunk),
    painted(new ConeGeometry(0.75, 1.0, 6, 1).translate(0, 0.95, 0), SITE_COLORS.tree),
    painted(new ConeGeometry(0.55, 0.9, 6, 1).translate(0, 1.55, 0), SITE_COLORS.tree),
  ]);
}

// A fence bay, centred on its own origin and running along x: a post at its left end and a
// 1.9-unit panel. The instance's turn lays it along z.
export function fenceBayGeometry(): BufferGeometry {
  return merge([
    plain(new BoxGeometry(0.12, 1.1, 0.12).translate(-0.94, 0.55, 0)),
    plain(new BoxGeometry(1.88, 0.7, 0.05).translate(0.06, 0.65, 0)),
  ]);
}
