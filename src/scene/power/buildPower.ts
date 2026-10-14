import { Group, Mesh, type BufferGeometry } from "three";
import { box, merge } from "../campus/parts.ts";
import { MATERIALS, SITE_COLORS } from "../materials.ts";
import {
  generatorGeometry,
  tankGeometry,
  transformerGeometry,
  vaultGeometry,
  yardFenceGeometry,
} from "./parts.ts";
import { GENERATORS, TANKS, TRANSFORMERS, VAULT } from "./powerLayout.ts";

export interface BuiltPower {
  group: Group;
  dispose(): void;
}

// The power yard (chunk 10): the substation with its fence, the generators with their stacks, the
// fuel tanks and the fibre vault, on a flat apron, merged into one mesh. It never moves, so it is
// one draw call (and one more in the shadow pass: transformers, generators and tanks cast
// shadows, CEO W-RW23).
export function buildPower(): BuiltPower {
  const at = (geometry: BufferGeometry, x: number, z: number) => geometry.translate(x, 0, z);
  const parts = [
    // The yard's apron, a step above the ground, inside the power zone.
    box([17.6, 0.03, 15.6], [-35, 0.015, 8], SITE_COLORS.padFace),
    yardFenceGeometry().geometry,
    at(vaultGeometry(), VAULT.x, VAULT.z),
    ...TRANSFORMERS.map((s) => at(transformerGeometry(), s.x, s.z)),
    ...GENERATORS.map((s) => at(generatorGeometry(), s.x, s.z)),
    ...TANKS.map((s) => at(tankGeometry(), s.x, s.z)),
  ];
  const mesh = new Mesh(merge(parts), MATERIALS.site);
  mesh.name = "power-yard";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new Group();
  group.name = "power";
  group.add(mesh);
  return {
    group,
    dispose: () => mesh.geometry.dispose(),
  };
}
