import { BoxGeometry, BufferGeometry, Color, Float32BufferAttribute, InstancedMesh } from "three";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { MATERIALS } from "../materials.ts";
import {
  HallBuildError,
  buildHall,
  hallTriangles,
  mergeHallParts,
  setAisleTint,
  setHallTint,
} from "./buildHall.ts";
import { SignBinding, getSignPanels } from "./signPanels.ts";
import { HALL, RACK_ROW, ROOF_BOTTOM, WALL_TOP } from "./hallLayout.ts";

afterEach(() => vi.restoreAllMocks());

// Enough of the atlas for SignPanels: one UV rectangle per slot.
class SignAtlasStub {
  rect(slot: number) {
    return {
      col: slot % 2,
      row: Math.floor(slot / 2),
      uv: { u: (slot % 2) / 2, v: 0, w: 0.5, h: 1 / 6 },
    };
  }
}

const coloured = (g: BufferGeometry) => {
  const n = g.getAttribute("position").count;
  return g.setAttribute("color", new Float32BufferAttribute(new Float32Array(n * 3), 3));
};

const colourAt = (hall: ReturnType<typeof buildHall>, vertex: number) => {
  const a = hall.body.geometry.getAttribute("color");
  return [a.getX(vertex), a.getY(vertex), a.getZ(vertex)];
};

test("the 16-slot, 2-row hall is about 8 x 6 and its racks fit the aisle layout", () => {
  expect(HALL.width).toBeCloseTo(8, 9);
  expect(HALL.depth).toBeCloseTo(6, 9);
  expect(RACK_ROW).toMatchObject({ pitch: 0.8, coldAisle: 1.2, hotAisle: 0.8 });
  const hall = buildHall({ slots: 16, rows: 2 });
  hall.body.geometry.computeBoundingBox();
  const box = hall.body.geometry.boundingBox!;
  // The roof overhangs the slab by 0.1 on each side.
  expect(box.max.x - box.min.x).toBeCloseTo(HALL.width + 0.2, 6);
  expect(box.max.z - box.min.z).toBeCloseTo(HALL.depth + 0.2, 6);
  hall.dispose();
});

test("buildHall rejects layouts it cannot build", () => {
  expect(() => buildHall({ slots: 16, rows: 3 })).toThrow(HallBuildError);
  expect(() => buildHall({ slots: 15, rows: 2 })).toThrow(HallBuildError);
});

test("the hall body stays within 2,000 triangles (eng E28)", () => {
  const hall = buildHall({ slots: 16, rows: 2 });
  expect(hallTriangles(hall)).toBeGreaterThan(0);
  expect(hallTriangles(hall)).toBeLessThanOrEqual(2000);
  hall.dispose();
});

test("the roof is built wholly above the wall top", () => {
  expect(ROOF_BOTTOM).toBeGreaterThan(WALL_TOP + 0.01);
  const hall = buildHall({ slots: 16, rows: 2 });
  const pos = hall.body.geometry.getAttribute("position");
  let above = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    // Nothing straddles the cut plane at wall top + 0.01.
    expect(y <= WALL_TOP + 0.001 || y >= ROOF_BOTTOM - 0.001).toBe(true);
    if (y >= ROOF_BOTTOM - 0.001) above++;
  }
  expect(above).toBe(24);
  hall.dispose();
});

test("draw proof: 2 meshes and 1 shadow caster per hall, plus the one shared panel draw", () => {
  const halls = [buildHall({ slots: 16, rows: 2 }), buildHall({ slots: 16, rows: 2 })];
  // Two mounted halls each bind to getSignPanels(): the same owner, so one mesh and two instances.
  const bindings = halls.map(
    () => new SignBinding(getSignPanels(new SignAtlasStub()), halls[0].signCentre),
  );
  bindings[0].sync(0, [0, 0, 0]);
  bindings[1].sync(1, [10, 0, 0]);
  const panelMeshes = new Set(bindings.map((b) => b.panels.mesh));
  const panels = bindings[0].panels;
  expect(panels.mesh).toBeInstanceOf(InstancedMesh);
  expect(panelMeshes.size).toBe(1);
  expect(panels.instances).toBe(2);
  const hall = halls[0];
  const meshes = hall.meshes.length;
  const casters = hall.meshes.filter((m) => m.castShadow).length;
  const panelShare = panelMeshes.size; // one draw for every hall's panel
  expect(meshes).toBe(2);
  expect(casters).toBe(1);
  expect(panels.mesh.castShadow).toBe(false);
  expect(meshes + panelShare + casters).toBeLessThanOrEqual(4);
  expect(hall.body.castShadow && hall.body.receiveShadow).toBe(true);
  bindings.forEach((b) => b.release());
  halls.forEach((h) => h.dispose());
});

test("a built hall's dispose frees its own two geometries and no shared material", () => {
  const hall = buildHall({ slots: 16, rows: 2 });
  const body = vi.spyOn(hall.body.geometry, "dispose");
  const windows = vi.spyOn(hall.windows.geometry, "dispose");
  const material = vi.spyOn(MATERIALS.hall, "dispose");
  hall.dispose();
  expect(body).toHaveBeenCalledTimes(1);
  expect(windows).toHaveBeenCalledTimes(1);
  expect(material).not.toHaveBeenCalled();
});

test("the body uses the shared hall material and the windows the shared window glow", () => {
  const hall = buildHall({ slots: 16, rows: 2 });
  expect(hall.body.material).toBe(MATERIALS.hall);
  expect(hall.windows.material).toBe(MATERIALS.window);
  hall.dispose();
});

test("two halls tinted differently share material instances and differ only in attributes", () => {
  const a = buildHall({ slots: 16, rows: 2 });
  const b = buildHall({ slots: 16, rows: 2 });
  const before = colourAt(a, 0);
  setHallTint(a, new Color(0.5, 0.5, 0.5));
  setHallTint(b, new Color(1, 1, 1));
  expect(a.body.material).toBe(b.body.material);
  expect(a.windows.material).toBe(b.windows.material);
  const tinted = colourAt(a, 0);
  expect(tinted[0]).toBeCloseTo(before[0] * 0.5, 6);
  expect(colourAt(b, 0)[0]).toBeCloseTo(before[0], 6);
  // Tinting back restores the base colour.
  setHallTint(a, new Color(1, 1, 1));
  expect(colourAt(a, 0)[0]).toBeCloseTo(before[0], 6);
  a.dispose();
  b.dispose();
});

test("setAisleTint writes the aisle range only, setHallTint everything else", () => {
  const hall = buildHall({ slots: 16, rows: 2 });
  const count = hall.body.geometry.getAttribute("color").count;
  const { aisle } = hall.ranges;
  expect(aisle.start + aisle.count).toBe(count);
  const hallVertex = 0;
  const aisleVertex = aisle.start;
  const hallBefore = colourAt(hall, hallVertex);
  const aisleBefore = colourAt(hall, aisleVertex);
  setAisleTint(hall, new Color(0.5, 0.5, 0.5));
  expect(colourAt(hall, hallVertex)).toEqual(hallBefore);
  expect(colourAt(hall, aisleVertex)[0]).toBeCloseTo(aisleBefore[0] * 0.5, 6);
  setHallTint(hall, new Color(0.25, 0.25, 0.25));
  expect(colourAt(hall, hallVertex)[0]).toBeCloseTo(hallBefore[0] * 0.25, 6);
  expect(colourAt(hall, aisleVertex)[0]).toBeCloseTo(aisleBefore[0] * 0.5, 6);
  hall.dispose();
});

test("mergeHallParts with mismatched parts throws HallBuildError instead of returning null", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const withColour = coloured(new BoxGeometry(1, 1, 1));
  const without = new BoxGeometry(1, 1, 1);
  expect(() => mergeHallParts([withColour, without])).toThrow(HallBuildError);
  const nonIndexed = coloured(new BoxGeometry(1, 1, 1).toNonIndexed());
  expect(() => mergeHallParts([withColour, nonIndexed])).toThrow(HallBuildError);
  expect(() => mergeHallParts([])).toThrow(HallBuildError);
  expect(
    mergeHallParts([withColour, coloured(new BoxGeometry(2, 2, 2))]).getAttribute("position").count,
  ).toBe(48);
});
