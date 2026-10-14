import { ZONES, type Rect } from "../campus/layout.ts";

// Where the power yard stands inside the power zone of the campus layout (chunk 10), and the fibre
// entry vault at the zone's east edge. Pure numbers, no three import, so the tests, the fibre
// routes and the views read them directly. Like the plant, the zone is seen from +x, +z: the
// substation is the far (west) corner, the vault is the corner nearest the hall grid.
export interface Spot {
  x: number;
  z: number;
}

// The fenced substation yard, with three transformers in a row inside it.
export const SUBSTATION: Rect = { minX: -43, maxX: -33, minZ: 1.5, maxZ: 9.5 };
export const TRANSFORMERS: readonly Spot[] = [
  { x: -40.5, z: 5.5 },
  { x: -38, z: 5.5 },
  { x: -35.5, z: 5.5 },
];
export const TRANSFORMER = { width: 1.7, depth: 1.3, height: 1.9 } as const;

// Three standby generators in a row in front of the yard, each with an exhaust stack.
export const GENERATORS: readonly Spot[] = [
  { x: -41, z: 12.5 },
  { x: -37, z: 12.5 },
  { x: -33, z: 12.5 },
];
export const GENERATOR = { width: 3, depth: 1.7, height: 1.9, stack: 2.9 } as const;

// Three fuel tanks lying along x, beside the yard.
export const TANKS: readonly Spot[] = [
  { x: -30, z: 3 },
  { x: -30, z: 5.5 },
  { x: -30, z: 8 },
];
export const TANK = { length: 4, radius: 0.8, height: 1.7 } as const;

// The fibre entry vault: a low concrete box on the axis of the road in front of hall row 0
// (z 12-15, which starts at x = -26), so the fibre leaves it straight onto the road grid.
export const VAULT = { x: -29, z: 13.5, width: 3, depth: 3, height: 0.5 } as const;

const around = (s: Spot, width: number, depth: number): Rect => ({
  minX: s.x - width / 2,
  maxX: s.x + width / 2,
  minZ: s.z - depth / 2,
  maxZ: s.z + depth / 2,
});

// The footprint of everything the power yard stands on, for the layout test.
export function powerFootprints(): {
  yard: Rect;
  vault: Rect;
  transformers: Rect[];
  generators: Rect[];
  tanks: Rect[];
} {
  return {
    yard: SUBSTATION,
    vault: around(VAULT, VAULT.width, VAULT.depth),
    transformers: TRANSFORMERS.map((s) => around(s, TRANSFORMER.width, TRANSFORMER.depth)),
    generators: GENERATORS.map((s) => around(s, GENERATOR.width, GENERATOR.depth)),
    tanks: TANKS.map((s) => around(s, TANK.length, TANK.radius * 2)),
  };
}

// The `view=power` camera: ortho at the isometric pose, framed on the power zone and the start of
// the road beyond its vault (the first column road, x = -22), so the fibre is seen leaving it.
export const POWER_FRAMING = {
  target: [(ZONES.power.minX + -22) / 2, 1.5, 9.5] as const,
  zoom: 32,
};
