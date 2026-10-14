import { createRng } from "../../sim/rng.ts";
import { HALL } from "../hall/hallLayout.ts";

// The campus ground plan (CEO W-RW1): where the 12 hall slots, the roads, the zones and the site
// furniture stand. Pure numbers: no three import, so the camera tests, the waypoint graph and the
// e2e specs read it directly. World axes: x right, z toward the camera's lower left, so the
// gate at the largest z is the bottom centre of the isometric view and the hall grid grows toward
// -z, the top right. Chunk 19 owns which project takes which slot; this file only places them.

// An axis-aligned box on the ground.
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export type ZoneName = "plant" | "power" | "gate" | "parking" | "dock";

export const SLOT_COUNT = 12;
// A 4 x 3 slot grid, the 8 x 6 hall plus a 3-unit road: pitch 11 x 9 [estimated].
export const GRID = { cols: 4, rows: 3, pitchX: 11, pitchZ: 9 } as const;
export const ROAD_WIDTH = 3;
// A hall must be placed on this many slots at least (A and B, CEO C25).
export const MIN_PLACED = 2;
// Tall enough for the cooling towers of chunk 09 (about 2.5 x the wall top).
export const HOME_HEIGHT = 5.5; // [estimated]
export const BOUNDS_HEIGHT = 3;

// Row 0 is the front row, nearest the gate; slots fill left to right, then toward the back.
export function slotPosition(i: number): { x: number; z: number; col: number; row: number } {
  if (!Number.isInteger(i) || i < 0 || i >= SLOT_COUNT) {
    throw new RangeError(`slot ${String(i)} is outside 0-${SLOT_COUNT - 1}`);
  }
  const col = i % GRID.cols;
  const row = Math.floor(i / GRID.cols);
  return {
    x: (col - (GRID.cols - 1) / 2) * GRID.pitchX,
    z: ((GRID.rows - 1) / 2 - row) * GRID.pitchZ,
    col,
    row,
  };
}

const around = (x: number, z: number, width: number, depth: number): Rect => ({
  minX: x - width / 2,
  maxX: x + width / 2,
  minZ: z - depth / 2,
  maxZ: z + depth / 2,
});

// The hall slab on the ground (the roof overhangs it by 0.1).
export function hallFootprint(i: number): Rect {
  const { x, z } = slotPosition(i);
  return around(x, z, HALL.width, HALL.depth);
}

// The middle of the front wall's face, which looks toward +z and the road in front.
export function hallDoor(i: number): { x: number; z: number } {
  const { x, z } = slotPosition(i);
  return { x, z: z + HALL.depth / 2 };
}

// The empty-slot pad: the slab's footprint, its outline included.
export const PAD = { width: HALL.width, depth: HALL.depth, outline: 0.06 } as const;

export function padRect(i: number): Rect {
  const { x, z } = slotPosition(i);
  return around(x, z, PAD.width, PAD.depth);
}

export const ZONES: Record<ZoneName, Rect> = {
  plant: { minX: -44, maxX: -26, minZ: -18, maxZ: -2 },
  power: { minX: -44, maxX: -26, minZ: 0, maxZ: 16 },
  gate: { minX: -6, maxX: 6.5, minZ: 16, maxZ: 28 },
  parking: { minX: 10, maxX: 36, minZ: 17, maxZ: 27 },
  dock: { minX: 26, maxX: 40, minZ: -8, maxZ: 8 },
};

// The fence line; everything on the site lies inside it.
export const CAMPUS_EXTENT: Rect = { minX: -46, maxX: 44, minZ: -20, maxZ: 28 };

// The road centre lines: one in front of each hall row and one behind the back row, one between
// and beside every hall column. The gate road is the column at x = 0.
export const ROAD_ROWS = [13.5, 4.5, -4.5, -13.5] as const;
export const ROAD_COLS = [-22, -11, 0, 11, 22] as const;
const HALF_ROAD = ROAD_WIDTH / 2;
const ROW_SPAN = { minX: -26, maxX: 26 };
const COL_SPAN = { minZ: -15, maxZ: 15 };
// The gate road runs on to the fence, the parking road to the lot.
const COL_END: Record<number, number> = { 0: CAMPUS_EXTENT.maxZ, 11: ZONES.parking.minZ };

export const ROADS: readonly Rect[] = [
  ...ROAD_ROWS.map((z) => ({
    minX: ROW_SPAN.minX,
    // The road in front of row 1 goes on to the loading dock.
    maxX: z === 4.5 ? ZONES.dock.minX + 8 : ROW_SPAN.maxX,
    minZ: z - HALF_ROAD,
    maxZ: z + HALF_ROAD,
  })),
  ...ROAD_COLS.map((x) => ({
    minX: x - HALF_ROAD,
    maxX: x + HALF_ROAD,
    minZ: COL_SPAN.minZ,
    maxZ: COL_END[x] ?? COL_SPAN.maxZ,
  })),
  // The lot and the dock apron are asphalt too.
  ZONES.parking,
  {
    minX: ZONES.dock.minX,
    maxX: ZONES.dock.minX + 8,
    minZ: ZONES.dock.minZ,
    maxZ: ZONES.dock.maxZ,
  },
];

// The camera's clamp box: half extents about the origin, so it covers the whole fence line.
export function campusBounds(): { halfX: number; halfZ: number; maxY: number } {
  return {
    halfX: Math.max(-CAMPUS_EXTENT.minX, CAMPUS_EXTENT.maxX),
    halfZ: Math.max(-CAMPUS_EXTENT.minZ, CAMPUS_EXTENT.maxZ),
    maxY: BOUNDS_HEIGHT,
  };
}

export interface HomeFrame extends Rect {
  maxY: number;
}

// What the startup view and `home()` frame (CEO C25): the placed halls plus the plant, power and
// gate zones. A placed hall never moves; the next `home()` only widens.
export function campusHome(placed: number): HomeFrame {
  if (!Number.isInteger(placed) || placed < MIN_PLACED || placed > SLOT_COUNT) {
    throw new RangeError(`placed halls must be a whole number ${MIN_PLACED}-${SLOT_COUNT}`);
  }
  const rects = [
    ...Array.from({ length: placed }, (_, i) => hallFootprint(i)),
    ZONES.plant,
    ZONES.power,
    ZONES.gate,
  ];
  return {
    minX: Math.min(...rects.map((r) => r.minX)),
    maxX: Math.max(...rects.map((r) => r.maxX)),
    minZ: Math.min(...rects.map((r) => r.minZ)),
    maxZ: Math.max(...rects.map((r) => r.maxZ)),
    maxY: HOME_HEIGHT,
  };
}

const GROUND_MARGIN = 4;
// The campus grid draws a line every 4 units: one per unit turns to a haze at the home zoom.
export const GROUND_CELL = 4;

// The ground plane and its grid: the extent plus a margin, centred on it.
export function groundArea(): {
  cx: number;
  cz: number;
  width: number;
  depth: number;
  cell: number;
} {
  return {
    cell: GROUND_CELL,
    cx: (CAMPUS_EXTENT.minX + CAMPUS_EXTENT.maxX) / 2,
    cz: (CAMPUS_EXTENT.minZ + CAMPUS_EXTENT.maxZ) / 2,
    width: CAMPUS_EXTENT.maxX - CAMPUS_EXTENT.minX + 2 * GROUND_MARGIN,
    depth: CAMPUS_EXTENT.maxZ - CAMPUS_EXTENT.minZ + 2 * GROUND_MARGIN,
  };
}

// Half the shadow camera's side: the whole campus must fit, seen from the origin.
export function shadowRadius(): number {
  const { halfX, halfZ } = campusBounds();
  return Math.ceil(Math.hypot(halfX, halfZ)) + 2;
}

// Fence bays: a post and a 2-unit panel, centred on the fence line. `along` is the direction the
// panel runs. The fence is open at the gate road.
export interface FenceBay {
  x: number;
  z: number;
  along: "x" | "z";
}

const BAY = 2;
const GATE_GAP = 2.5;

export function fenceBays(): FenceBay[] {
  const { minX, maxX, minZ, maxZ } = CAMPUS_EXTENT;
  const bays: FenceBay[] = [];
  for (let x = minX + BAY / 2; x < maxX; x += BAY) {
    bays.push({ x, z: minZ, along: "x" });
    if (Math.abs(x) > GATE_GAP) bays.push({ x, z: maxZ, along: "x" });
  }
  for (let z = minZ + BAY / 2; z < maxZ; z += BAY) {
    bays.push({ x: minX, z, along: "z" });
    bays.push({ x: maxX, z, along: "z" });
  }
  return bays;
}

const overlaps = (a: Rect, b: Rect) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;

const grown = (r: Rect, by: number): Rect => ({
  minX: r.minX - by,
  maxX: r.maxX + by,
  minZ: r.minZ - by,
  maxZ: r.maxZ + by,
});

const SOLIDS: readonly Rect[] = [
  ...ROADS,
  ...Object.values(ZONES),
  ...Array.from({ length: SLOT_COUNT }, (_, i) => padRect(i)),
];

export interface TreeSpot {
  x: number;
  z: number;
  scale: number;
  turn: number;
}

const TREE = { step: 2.2, clearance: 0.9, edge: 1, wooded: 6, maxCount: 140 };

// Trees on the free ground of the campus, thickest along the fence and the road edges: a
// jittered grid, each spot kept by a seeded draw (CEO C27).
export function treeSpots(seed: number): TreeSpot[] {
  const rng = createRng(Math.floor(seed) * 7919 + 13);
  const { minX, maxX, minZ, maxZ } = CAMPUS_EXTENT;
  const spots: TreeSpot[] = [];
  for (let gx = minX + TREE.edge; gx <= maxX - TREE.edge; gx += TREE.step) {
    for (let gz = minZ + TREE.edge; gz <= maxZ - TREE.edge; gz += TREE.step) {
      const x = gx + (rng.next() - 0.5) * 1.2;
      const z = gz + (rng.next() - 0.5) * 1.2;
      const keep = rng.next();
      const scale = 0.8 + rng.next() * 0.5;
      const turn = rng.next() * Math.PI * 2;
      const spot: Rect = grown({ minX: x, maxX: x, minZ: z, maxZ: z }, TREE.clearance);
      const nearEdge =
        Math.min(x - minX, maxX - x, z - minZ, maxZ - z) < TREE.wooded && keep < 0.75;
      const nearRoad = SOLIDS.some((s) => overlaps(spot, grown(s, 1.2))) && keep < 0.3;
      if (!nearEdge && !nearRoad) continue;
      if (SOLIDS.some((s) => overlaps(spot, s))) continue;
      if (x < minX + 0.5 || x > maxX - 0.5 || z < minZ + 0.5 || z > maxZ - 0.5) continue;
      spots.push({ x, z, scale, turn });
    }
  }
  return spots.slice(0, TREE.maxCount);
}

export interface ParkedCar {
  x: number;
  z: number;
  // 0 or PI: which way the car faces along z.
  turn: number;
  // Index of one of the three dark greys.
  shade: 0 | 1 | 2;
}

const BAYS = { width: 1.4, length: 2.8, rowZ: [19.2, 24.8] as const, occupied: 0.55 };

// A lot of two facing rows of bays, filled by a seeded draw.
export function parkedCars(seed: number): ParkedCar[] {
  const rng = createRng(Math.floor(seed) * 104729 + 7);
  const cars: ParkedCar[] = [];
  const { minX, maxX } = ZONES.parking;
  for (const z of BAYS.rowZ) {
    for (let x = minX + 1.2 + BAYS.width / 2; x + BAYS.width / 2 <= maxX - 0.4; x += BAYS.width) {
      if (rng.next() >= BAYS.occupied) continue;
      cars.push({
        x,
        z: z + (rng.next() - 0.5) * 0.2,
        turn: rng.next() < 0.5 ? 0 : Math.PI,
        shade: rng.int(3) as 0 | 1 | 2,
      });
    }
  }
  return cars;
}

// Where the bays' painted lines run, for the parking furniture.
export const PARKING_BAYS = BAYS;

export interface Spot {
  x: number;
  z: number;
}

// Road lamps: one at a corner of every road crossing, alternating corners, then the gate road, the
// lot and the dock apron.
export function lampSpots(): Spot[] {
  const spots: Spot[] = [];
  const offset = HALF_ROAD - 0.3;
  ROAD_COLS.forEach((x, c) => {
    ROAD_ROWS.forEach((z, r) => {
      const sign = (c + r) % 2 === 0 ? 1 : -1;
      spots.push({ x: x + sign * offset, z: z + sign * offset });
    });
  });
  spots.push({ x: 2.2, z: 18 }, { x: -2.2, z: 25 });
  for (const x of [16, 26, 34]) spots.push({ x, z: 22.1 });
  spots.push({ x: 30, z: -6.5 });
  return spots;
}
