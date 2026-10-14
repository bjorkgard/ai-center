// Sizes of one data hall, in world units, shared by the geometry builder, the roof plane,
// the sign panel and SEMANTIC_ZOOM. Pure numbers: no three import, so camera.ts can read them.
// Hall-local origin: the centre of the slab on the ground. The front wall faces +z.

// Two rows of 8 racks at the look-dev pitch, a cold aisle between them and a hot aisle behind
// each row (chunk 08's 16-rack hall of about 8 x 6 units; chunk 07 places racks on this grid).
export const RACK_ROW = { racks: 8, pitch: 0.8, depth: 0.8, coldAisle: 1.2, hotAisle: 0.8 };
const END_CLEARANCE = 0.8; // [estimated]

const rowLength = RACK_ROW.racks * RACK_ROW.pitch;
const rowsDepth = 2 * RACK_ROW.depth + RACK_ROW.coldAisle + 2 * RACK_ROW.hotAisle;

export const HALL = {
  width: rowLength + 2 * END_CLEARANCE, // 8
  depth: rowsDepth + 2 * END_CLEARANCE, // 6
  slabHeight: 0.2,
  wallHeight: 1.9,
  wallThickness: 0.2,
  roofHeight: 0.1,
  roofOverhang: 0.1,
  door: { width: 0.9, height: 0.85, depth: 0.06 },
} as const;

export const WALL_TOP = HALL.slabHeight + HALL.wallHeight;
// The roof slab is built wholly above the wall top (CEO C24).
export const ROOF_BOTTOM = WALL_TOP + 0.02;
export const ROOF_TOP = ROOF_BOTTOM + HALL.roofHeight;

// The clipping plane's constant: cut keeps everything up to 0.01 above the wall top, uncut
// keeps the roof too. Plane normal (0, -1, 0): a point is kept while constant - y >= 0.
export const ROOF_CUT_CONSTANT = WALL_TOP + 0.01;
export const ROOF_UNCUT_CONSTANT = ROOF_TOP + 0.01;

// Sign panel on the front wall's face above the door (design-review Phase 3 D10, WD5) [sizes
// estimated]. `baseline` is the name line's baseline above the panel's bottom edge.
export const SIGN = {
  width: 3.2,
  height: 0.8,
  stripe: 0.08,
  letterCap: 0.5,
  nameCap: 0.28,
  baseline: 0.18,
  margin: 0.15,
  minLetterPx: 12,
  fadeMs: 200,
  // Offset from the wall face so the panel never z-fights with it.
  lift: 0.01,
} as const;

// Panel centre in hall-local coordinates: above the door with a small gap.
export const SIGN_CENTRE: readonly [number, number, number] = [
  0,
  HALL.slabHeight + HALL.door.height + 0.1 + SIGN.height / 2,
  HALL.depth / 2 + SIGN.lift,
];

// The `view=hall` camera: ortho at the isometric pose, one hall centred.
export const HALL_FRAMING = { target: [0, 0.8, 0] as const, zoom: 72 };

// Hall letters live in 12 slots (PLAN section on the campus grid).
export const SIGN_SLOTS = 12;
