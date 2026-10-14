import { CylinderGeometry, type BufferGeometry } from "three";
import { box, merge, painted } from "../campus/parts.ts";
import { SITE_COLORS } from "../materials.ts";
import { SUBSTATION, VAULT } from "./powerLayout.ts";

// The power yard parts (chunk 10): low poly, each with its colour in a colour attribute and built
// once, on the shared `site` material. Triangle caps (eng-review Phase 3 E28, the chunk that adds
// each part) [estimated]: transformer 200, generator 300, tank 150, vault 100, fence bay 24. Each
// is centred on its own origin on the ground; the generators and the vault face +z.

// A substation transformer: a base slab, the tank, two radiator banks, an oil conservator on top
// and three bushings.
export function transformerGeometry(): BufferGeometry {
  const { wall, roofSlab, door, marking } = SITE_COLORS;
  const parts = [
    box([1.7, 0.15, 1.3], [0, 0.075, 0], roofSlab),
    box([1.4, 1.0, 1.0], [0, 0.65, 0], wall),
    painted(
      new CylinderGeometry(0.2, 0.2, 1.3, 8, 1).rotateZ(Math.PI / 2).translate(0, 1.45, -0.25),
      marking,
    ),
  ];
  for (const x of [-0.78, 0.78]) {
    for (const z of [-0.28, 0.28]) parts.push(box([0.12, 0.8, 0.4], [x, 0.6, z], door));
  }
  for (const x of [-0.4, 0, 0.4]) {
    parts.push(
      painted(new CylinderGeometry(0.07, 0.07, 0.55, 6, 1).translate(x, 1.425, 0.25), door),
    );
  }
  return merge(parts);
}

// A standby generator in a housing on a skid, with a door pair on its front, a muffler and an
// exhaust stack with a rain cap rising above the roof.
export function generatorGeometry(): BufferGeometry {
  const { wall, roofSlab, door, marking, boom } = SITE_COLORS;
  return merge([
    box([3, 0.2, 1.7], [0, 0.1, 0], roofSlab),
    box([2.9, 1.4, 1.6], [0, 0.9, 0], wall),
    box([3, 0.1, 1.7], [0, 1.65, 0], roofSlab),
    box([0.9, 1.0, 0.06], [-0.7, 0.85, 0.83], door),
    box([0.9, 1.0, 0.06], [0.7, 0.85, 0.83], door),
    box([0.5, 0.4, 0.5], [-1, 1.9, -0.4], boom),
    painted(new CylinderGeometry(0.12, 0.12, 1.1, 8, 1).translate(-1, 2.35, -0.4), marking),
    painted(new CylinderGeometry(0.18, 0.18, 0.06, 8, 1).translate(-1, 2.93, -0.4), boom),
  ]);
}

// A fuel tank lying along x on two saddles, with a manhole on top.
export function tankGeometry(): BufferGeometry {
  const { roofSlab, door, marking } = SITE_COLORS;
  return merge([
    painted(
      new CylinderGeometry(0.8, 0.8, 4, 12, 1).rotateZ(Math.PI / 2).translate(0, 1.1, 0),
      marking,
    ),
    box([0.3, 0.3, 1.4], [-1.2, 0.15, 0], roofSlab),
    box([0.3, 0.3, 1.4], [1.2, 0.15, 0], roofSlab),
    painted(new CylinderGeometry(0.22, 0.22, 0.12, 8, 1).translate(0, 1.96, 0), door),
  ]);
}

// The fibre entry vault: a low concrete box with two lids, a pedestal and the cable gland on its
// east face, where the fibre leaves it.
export function vaultGeometry(): BufferGeometry {
  const { wall, door, marking } = SITE_COLORS;
  const half = VAULT.width / 2;
  return merge([
    box([VAULT.width, VAULT.height, VAULT.depth], [0, VAULT.height / 2, 0], wall),
    box([1.1, 0.08, 1.1], [-0.5, VAULT.height + 0.04, 0.2], marking),
    box([0.7, 0.08, 0.7], [0.6, VAULT.height + 0.04, 0.6], marking),
    box([0.5, 0.9, 0.5], [-1, VAULT.height + 0.45, -0.9], door),
    box([0.4, 0.25, 0.5], [half + 0.05, 0.17, -1.1], door),
  ]);
}

const BAY = 2;

// The substation fence: a post and a 1.88-unit panel per 2-unit bay all round the yard, each bay
// 24 triangles. Returns the bay count for the cap test.
export function yardFenceGeometry(): { geometry: BufferGeometry; bays: number } {
  const { fence } = SITE_COLORS;
  const parts: BufferGeometry[] = [];
  const { minX, maxX, minZ, maxZ } = SUBSTATION;
  for (let x = minX + BAY / 2; x < maxX; x += BAY) {
    for (const z of [minZ, maxZ]) {
      parts.push(box([0.12, 1.1, 0.12], [x - 0.94, 0.55, z], fence));
      parts.push(box([1.88, 0.7, 0.05], [x + 0.06, 0.65, z], fence));
    }
  }
  for (let z = minZ + BAY / 2; z < maxZ; z += BAY) {
    for (const x of [minX, maxX]) {
      parts.push(box([0.12, 1.1, 0.12], [x, 0.55, z - 0.94], fence));
      parts.push(box([0.05, 0.7, 1.88], [x, 0.65, z + 0.06], fence));
    }
  }
  return { geometry: merge(parts), bays: parts.length / 2 };
}
