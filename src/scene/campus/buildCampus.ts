import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";
import type { SignAtlas } from "../hall/signAtlas.ts";
import { MATERIALS, SITE_COLORS } from "../materials.ts";
import { fenceBays, lampSpots, parkedCars, treeSpots } from "./layout.ts";
import { MonumentMark, PadMarks } from "./marks.ts";
import {
  carGeometry,
  fenceBayGeometry,
  furnitureGeometry,
  lampHeadGeometry,
  lampPostGeometry,
  roadGeometry,
  treeGeometry,
} from "./parts.ts";

export interface BuiltCampus {
  group: Group;
  marks: PadMarks;
  monument: MonumentMark;
  // Halls fill slots 0..n-1: their pads and numbers go.
  setPlaced(n: number): void;
  dispose(): void;
}

const position = new Vector3();
const rotation = new Quaternion();
const scale = new Vector3();
const matrix = new Matrix4();
const UP = new Vector3(0, 1, 0);

// An InstancedMesh with one matrix per item, never culled (the geometry registers once).
function instanced<T>(
  name: string,
  geometry: BufferGeometry,
  material: Material,
  items: readonly T[],
  place: (item: T, index: number) => Matrix4,
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, items.length);
  mesh.name = name;
  mesh.frustumCulled = false;
  items.forEach((item, i) => mesh.setMatrixAt(i, place(item, i)));
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

const at = (x: number, z: number, turn = 0, size = 1) =>
  matrix.compose(position.set(x, 0, z), rotation.setFromAxisAngle(UP, turn), scale.setScalar(size));

// The static campus (chunk 08): roads, parking with parked cars, the gate, the dock, lamps, trees,
// the perimeter fence, the empty-slot pads and the monument wordmark. Ten meshes and so ten
// main-pass draws; only the trees and the cars cast shadows (CEO W-RW23). Seeded: a seed moves
// the trees and fills the lot differently, and the same seed always builds the same campus.
export function buildCampus(
  seed: number,
  atlas: Pick<SignAtlas, "padRect" | "monumentRect">,
): BuiltCampus {
  const group = new Group();
  group.name = "campus";

  const roads = new Mesh(roadGeometry(), MATERIALS.site);
  roads.name = "campus-roads";
  roads.userData.ground = true;
  roads.receiveShadow = true;
  const furniture = new Mesh(furnitureGeometry(), MATERIALS.site);
  furniture.name = "campus-furniture";
  furniture.receiveShadow = true;

  const cars = instanced("parked-cars", carGeometry(), MATERIALS.car, parkedCars(seed), (c) =>
    at(c.x, c.z, c.turn),
  );
  const greys = SITE_COLORS.cars.map((hex) => new Color(hex));
  parkedCars(seed).forEach((car, i) => cars.setColorAt(i, greys[car.shade]));
  cars.castShadow = true;
  cars.receiveShadow = true;

  const lamps = lampSpots();
  const posts = instanced("lamp-posts", lampPostGeometry(), MATERIALS.concrete, lamps, (l) =>
    at(l.x, l.z),
  );
  const heads = instanced("lamp-heads", lampHeadGeometry(), MATERIALS.lamp, lamps, (l) =>
    at(l.x, l.z),
  );

  const trees = instanced("trees", treeGeometry(), MATERIALS.tree, treeSpots(seed), (t) =>
    at(t.x, t.z, t.turn, t.scale),
  );
  trees.castShadow = true;
  trees.receiveShadow = true;

  const fence = instanced("fence", fenceBayGeometry(), MATERIALS.concrete, fenceBays(), (b) =>
    at(b.x, b.z, b.along === "z" ? Math.PI / 2 : 0),
  );
  fence.receiveShadow = true;

  const marks = new PadMarks(atlas);
  const monument = new MonumentMark(atlas);
  const statics = [roads, furniture, cars, posts, heads, trees, fence];
  group.add(...statics, marks.pads, marks.numbers, monument.mesh);

  return {
    group,
    marks,
    monument,
    setPlaced: (n) => marks.setPlaced(n),
    dispose() {
      for (const mesh of statics) {
        mesh.geometry.dispose();
        if ((mesh as InstancedMesh).isInstancedMesh) (mesh as InstancedMesh).dispose();
      }
      marks.dispose();
      monument.dispose();
    },
  };
}
