import { Matrix4, Vector3 } from "three";
import { expect, test } from "vite-plus/test";
import { createCameraRig, ISO_ELEVATION } from "../camera.ts";
import { INSTANCE_OPACITY, INSTANCE_UV_RECT, MATERIALS } from "../materials.ts";
import { SLOT_COUNT, slotPosition } from "./layout.ts";
import { MonumentMark, PadMarks, capMeasure } from "./marks.ts";
import { MONUMENT } from "./parts.ts";

const atlas = {
  padRect: (i: number) => ({ uv: { u: 0.5 + (i % 6) / 12, v: 0.1 * (i % 2), w: 1 / 12, h: 0.05 } }),
  monumentRect: () => ({ uv: { u: 0, v: 0.2, w: 0.5, h: 1 / 7 } }),
};

const scaleOf = (mesh: { getMatrixAt(i: number, m: Matrix4): void }, i: number) => {
  const m = new Matrix4();
  mesh.getMatrixAt(i, m);
  return new Vector3().setFromMatrixScale(m).x;
};

test("the pads are one InstancedMesh of 12 and the numbers another, on the shared materials", () => {
  const marks = new PadMarks(atlas);
  expect(marks.pads.count).toBe(SLOT_COUNT);
  expect(marks.numbers.count).toBe(SLOT_COUNT);
  expect(marks.pads.material).toBe(MATERIALS.site);
  expect(marks.numbers.material).toBe(MATERIALS.sign);
  expect(marks.pads.userData.ground).toBe(true);
  expect(marks.numbers.userData.ground).toBe(true);
  const uv = marks.numbers.geometry.getAttribute(INSTANCE_UV_RECT);
  expect(uv.count).toBe(SLOT_COUNT);
  expect(uv.getX(7)).toBeCloseTo(atlas.padRect(7).uv.u, 6);
  expect(uv.getY(7)).toBeCloseTo(atlas.padRect(7).uv.v, 6);
  expect(marks.numbers.geometry.getAttribute(INSTANCE_OPACITY).count).toBe(SLOT_COUNT);
  marks.dispose();
});

test("placed halls hide their pad and number; every other slot keeps both at its position", () => {
  const marks = new PadMarks(atlas);
  marks.setPlaced(2);
  expect(marks.emptySlots).toBe(10);
  for (let i = 0; i < SLOT_COUNT; i++) {
    const shown = i >= 2;
    expect(scaleOf(marks.pads, i) > 0, `pad ${i}`).toBe(shown);
    expect(scaleOf(marks.numbers, i) > 0, `number ${i}`).toBe(shown);
  }
  const m = new Matrix4();
  marks.pads.getMatrixAt(5, m);
  const at = new Vector3().setFromMatrixPosition(m);
  expect([at.x, at.z]).toEqual([slotPosition(5).x, slotPosition(5).z]);
  marks.setPlaced(3);
  expect(scaleOf(marks.pads, 2)).toBe(0);
  expect(marks.emptySlots).toBe(9);
  marks.dispose();
});

test("a ground capital measures zoom x cap x 0.816 at the isometric pose", () => {
  const rig = createCameraRig({ width: 1280, height: 720 });
  rig.setFraming({ target: new Vector3(0, 0, 0), zoom: 40 });
  const m = capMeasure(rig, new Vector3(0, 0.05, 0), 0.6, "ground");
  // A ground segment of length L along z projects to L x zoom x sqrt(1/2 + 1/6) on screen.
  expect(m).toBeCloseTo(0.6 * 40 * Math.sqrt(0.5 + 1 / 6), 3);
  expect(capMeasure(rig, new Vector3(0, 1, 0), 0.28, "wall")).toBeCloseTo(
    0.28 * 40 * Math.cos(ISO_ELEVATION),
    3,
  );
});

test("a number shows at 12 px or more and fades out below it, and a placed pad never shows one", () => {
  const rig = createCameraRig({ width: 1280, height: 720 });
  const marks = new PadMarks(atlas);
  marks.setPlaced(2);
  const opacity = marks.numbers.geometry.getAttribute(INSTANCE_OPACITY);
  // 12 px / (0.6 x 0.816) = 24.5 units to the pixel.
  rig.setFraming({ target: new Vector3(0, 0, 0), zoom: 30 });
  marks.update(rig, 0, true);
  expect(opacity.getX(5)).toBe(1);
  expect(opacity.getX(0)).toBe(0);
  expect(opacity.getX(1)).toBe(0);
  rig.setFraming({ zoom: 15 });
  marks.update(rig, 100, false);
  marks.update(rig, 200, false);
  marks.update(rig, 300, false);
  expect(opacity.getX(5)).toBe(0);
  marks.dispose();
});

test("the wordmark shows while it faces the camera at 12 px or more, and is hidden from behind", () => {
  const rig = createCameraRig({ width: 1280, height: 720 });
  const mark = new MonumentMark(atlas);
  const opacity = mark.mesh.geometry.getAttribute(INSTANCE_OPACITY);
  const centre = new Vector3(MONUMENT.centre.x, MONUMENT.centre.y, MONUMENT.centre.z);
  rig.setFraming({ target: centre, zoom: 120 });
  mark.update(rig, 0, true);
  expect(opacity.getX(0)).toBe(1);
  rig.setFraming({ zoom: 20 });
  mark.update(rig, 10, true);
  expect(opacity.getX(0)).toBe(0);
  rig.setFraming({ zoom: 120, azimuth: Math.PI * 1.25 });
  mark.update(rig, 20, true);
  expect(opacity.getX(0)).toBe(0);
  expect(mark.mesh.material).toBe(MATERIALS.sign);
  expect(mark.mesh.count).toBe(1);
  mark.dispose();
});
