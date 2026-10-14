import { ZONES, type Rect } from "../campus/layout.ts";

// Where the cooling plant stands inside the plant zone of the campus layout (chunk 09). Pure
// numbers, no three import, so the tests, the fake signals and the view read them directly.
export interface Spot {
  x: number;
  z: number;
}

// Three cooling towers in a row at the back of the zone, two chillers in front of them.
export const TOWERS: readonly Spot[] = [
  { x: -38.5, z: -13 },
  { x: -34, z: -13 },
  { x: -29.5, z: -13 },
];
export const CHILLERS: readonly Spot[] = [
  { x: -37, z: -6 },
  { x: -31, z: -6 },
];

export const TOWER = { width: 3.6, depth: 3.6, height: 3.4, fanY: 3.15, fanRadius: 1.1 } as const;
export const CHILLER = { width: 5, depth: 2.2, height: 1.6 } as const;

export const TOWER_COUNT = TOWERS.length;

// The mouth of tower t's fan stack, where its vapour starts.
export function vapourOrigin(tower: number): { x: number; y: number; z: number } {
  const spot = TOWERS[tower];
  if (spot === undefined) throw new RangeError(`tower ${String(tower)} does not exist`);
  return { x: spot.x, y: TOWER.height, z: spot.z };
}

// The footprint of everything the plant stands on, for the layout test.
export function plantFootprints(): Rect[] {
  const around = (s: Spot, width: number, depth: number): Rect => ({
    minX: s.x - width / 2,
    maxX: s.x + width / 2,
    minZ: s.z - depth / 2,
    maxZ: s.z + depth / 2,
  });
  return [
    ...TOWERS.map((s) => around(s, TOWER.width, TOWER.depth)),
    ...CHILLERS.map((s) => around(s, CHILLER.width, CHILLER.depth)),
  ];
}

// The `view=cooling` camera: ortho at the isometric pose, the plant zone centred.
export const COOLING_FRAMING = {
  target: [
    (ZONES.plant.minX + ZONES.plant.maxX) / 2,
    3,
    (ZONES.plant.minZ + ZONES.plant.maxZ) / 2,
  ] as const,
  zoom: 34,
};
