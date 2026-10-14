import { CylinderGeometry, type BufferGeometry } from "three";
import { box, merge, painted } from "../campus/parts.ts";
import { SITE_COLORS } from "../materials.ts";
import { CHILLER, TOWER } from "./plantLayout.ts";

// The cooling plant parts (chunk 09): low poly, each with its colour in a colour attribute and
// built once, on the shared `site` material. Triangle caps (eng-review Phase 3 E28): tower 600,
// chiller 200, fan 64. Each is centred on its own origin on the ground.

const BASIN = 0.5;
const STACK = { radius: 1.3, height: 0.5, segments: 16 };

// A mechanical-draught tower: a basin, a louvred body and an open fan stack on top. The fan sits
// in the stack's mouth, a separate rotating part.
export function towerGeometry(): BufferGeometry {
  const { wall, roofSlab, door, marking } = SITE_COLORS;
  const body = TOWER.height - STACK.height - BASIN;
  const parts = [
    box([TOWER.width, BASIN, TOWER.depth], [0, BASIN / 2, 0], roofSlab),
    box([TOWER.width - 0.2, body, TOWER.depth - 0.2], [0, BASIN + body / 2, 0], wall),
    painted(
      new CylinderGeometry(
        STACK.radius,
        STACK.radius,
        STACK.height,
        STACK.segments,
        1,
        true,
      ).translate(0, TOWER.height - STACK.height / 2, 0),
      marking,
    ),
  ];
  // Two louvre bands on each of the four faces.
  const half = (TOWER.width - 0.2) / 2;
  for (const y of [BASIN + body * 0.3, BASIN + body * 0.7]) {
    parts.push(
      box([TOWER.width - 0.6, 0.35, 0.06], [0, y, half + 0.02], door),
      box([TOWER.width - 0.6, 0.35, 0.06], [0, y, -half - 0.02], door),
      box([0.06, 0.35, TOWER.depth - 0.6], [half + 0.02, y, 0], door),
      box([0.06, 0.35, TOWER.depth - 0.6], [-half - 0.02, y, 0], door),
    );
  }
  return merge(parts);
}

// A chiller: a plant box on four feet with two drums along its top.
export function chillerGeometry(): BufferGeometry {
  const { wall, door, marking } = SITE_COLORS;
  const foot = 0.3;
  const body = CHILLER.height - foot - 0.45;
  const parts = [box([CHILLER.width, body, CHILLER.depth], [0, foot + body / 2, 0], wall)];
  for (const z of [-0.5, 0.5]) {
    parts.push(
      painted(
        new CylinderGeometry(0.4, 0.4, CHILLER.width - 0.4, 12, 1)
          .rotateZ(Math.PI / 2)
          .translate(0, foot + body + 0.2, z),
        marking,
      ),
    );
  }
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      parts.push(
        box(
          [0.3, foot, 0.3],
          [(x * (CHILLER.width - 0.4)) / 2, foot / 2, (z * (CHILLER.depth - 0.4)) / 2],
          door,
        ),
      );
    }
  }
  return merge(parts);
}

// A fan: a hub and four blades in the horizontal plane, turning about the y axis through the hub.
export function fanGeometry(): BufferGeometry {
  const { boom, marking } = SITE_COLORS;
  const r = TOWER.fanRadius;
  return merge([
    painted(new CylinderGeometry(0.14, 0.14, 0.12, 3, 1), marking),
    box([r, 0.03, 0.22], [r / 2, 0, 0], boom),
    box([r, 0.03, 0.22], [-r / 2, 0, 0], boom),
    box([0.22, 0.03, r], [0, 0, r / 2], boom),
    box([0.22, 0.03, r], [0, 0, -r / 2], boom),
  ]);
}
