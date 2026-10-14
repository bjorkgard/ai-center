import { Color, InstancedMesh, Matrix4, Mesh, Vector3 } from "three";
import { expect, test } from "vite-plus/test";
import { buildHall, hallTriangles } from "../hall/buildHall.ts";
import { MATERIALS, allMaterials, SITE_COLORS } from "../materials.ts";
import { buildCampus } from "./buildCampus.ts";
import { SLOT_COUNT, fenceBays, lampSpots, parkedCars, treeSpots } from "./layout.ts";
import { triangleCount } from "./parts.ts";

const atlas = {
  padRect: () => ({ uv: { u: 0, v: 0, w: 0.1, h: 0.1 } }),
  monumentRect: () => ({ uv: { u: 0, v: 0, w: 0.5, h: 0.1 } }),
};

function meshes(built: ReturnType<typeof buildCampus>): Mesh[] {
  const out: Mesh[] = [];
  built.group.traverse((o) => {
    if ((o as Mesh).isMesh) out.push(o as Mesh);
  });
  return out;
}

const named = (list: Mesh[], name: string) => list.find((m) => m.name === name)!;

test("the site is ten meshes on library materials, so ten main-pass draws", () => {
  const built = buildCampus(1, atlas);
  const list = meshes(built);
  expect(list.map((m) => m.name).sort()).toEqual(
    [
      "campus-roads",
      "campus-furniture",
      "slot-pads",
      "slot-numbers",
      "monument-wordmark",
      "parked-cars",
      "lamp-posts",
      "lamp-heads",
      "trees",
      "fence",
    ].sort(),
  );
  for (const mesh of list) expect(allMaterials()).toContain(mesh.material);
  built.dispose();
});

test("only the trees and the parked cars cast shadows; every other part receives or is flat", () => {
  const built = buildCampus(1, atlas);
  const casters = meshes(built)
    .filter((m) => m.castShadow)
    .map((m) => m.name)
    .sort();
  expect(casters).toEqual(["parked-cars", "trees"]);
  built.dispose();
});

test("flat site surfaces carry userData.ground; furniture, vehicles and plants do not", () => {
  const built = buildCampus(1, atlas);
  const list = meshes(built);
  const ground = list
    .filter((m) => m.userData.ground === true)
    .map((m) => m.name)
    .sort();
  expect(ground).toEqual(["campus-roads", "slot-numbers", "slot-pads"]);
  built.dispose();
});

test("instance counts follow the seeded layout, and a seed changes the trees and cars", () => {
  const built = buildCampus(1, atlas);
  const list = meshes(built);
  expect((named(list, "trees") as InstancedMesh).count).toBe(treeSpots(1).length);
  expect((named(list, "parked-cars") as InstancedMesh).count).toBe(parkedCars(1).length);
  expect((named(list, "lamp-posts") as InstancedMesh).count).toBe(lampSpots().length);
  expect((named(list, "lamp-heads") as InstancedMesh).count).toBe(lampSpots().length);
  expect((named(list, "fence") as InstancedMesh).count).toBe(fenceBays().length);
  expect((named(list, "slot-pads") as InstancedMesh).count).toBe(SLOT_COUNT);
  built.dispose();
});

test("trees sit on their own shared material with no clipping plane, lamp heads on the warm glow", () => {
  const built = buildCampus(1, atlas);
  const list = meshes(built);
  expect(named(list, "trees").material).toBe(MATERIALS.tree);
  expect(MATERIALS.tree.clippingPlanes ?? []).toHaveLength(0);
  expect(named(list, "lamp-heads").material).toBe(MATERIALS.lamp);
  expect(named(list, "parked-cars").material).toBe(MATERIALS.car);
  built.dispose();
});

test("parked cars take one of the three dark greys each, lights off", () => {
  const built = buildCampus(1, atlas);
  const cars = named(meshes(built), "parked-cars") as InstancedMesh;
  const colour = cars.instanceColor!;
  const palette = new Set(
    SITE_COLORS.cars.map((hex) => {
      const c = new Color(hex);
      return [c.r, c.g, c.b].map((v) => v.toFixed(4)).join(",");
    }),
  );
  const seen = new Set<string>();
  for (let i = 0; i < cars.count; i++) {
    seen.add([colour.getX(i), colour.getY(i), colour.getZ(i)].map((v) => v.toFixed(4)).join(","));
  }
  expect(palette.size).toBe(3);
  expect(seen.size).toBeGreaterThanOrEqual(2);
  for (const used of seen) expect(palette.has(used), used).toBe(true);
  expect(MATERIALS.car.emissiveIntensity).toBe(1);
  expect(MATERIALS.car.emissive.getHex()).toBe(0);
  built.dispose();
});

test("setPlaced hides the pads of placed halls", () => {
  const built = buildCampus(1, atlas);
  built.setPlaced(4);
  expect(built.marks.emptySlots).toBe(8);
  const scaleOf = (i: number) => {
    const m = new Matrix4();
    built.marks.pads.getMatrixAt(i, m);
    return new Vector3().setFromMatrixScale(m).x;
  };
  for (let i = 0; i < SLOT_COUNT; i++) expect(scaleOf(i) > 0, `pad ${i}`).toBe(i >= 4);
  built.dispose();
});

test("the site plus twelve full halls stays inside the 150k campus triangle budget (eng E28)", () => {
  const built = buildCampus(1, atlas);
  let site = 0;
  for (const mesh of meshes(built)) {
    const count = (mesh as InstancedMesh).isInstancedMesh ? (mesh as InstancedMesh).count : 1;
    site += count * triangleCount(mesh.geometry);
  }
  const hall = buildHall({ slots: 16, rows: 2 });
  const perHall = hallTriangles(hall) + 16 * 12 + 16 * 13 * 12;
  hall.dispose();
  expect(site).toBeGreaterThan(0);
  expect(site + SLOT_COUNT * perHall).toBeLessThanOrEqual(150_000);
  built.dispose();
});
