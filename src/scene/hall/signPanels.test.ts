import { Vector3 } from "three";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { createCameraRig } from "../camera.ts";
import { MATERIALS, allMaterials } from "../materials.ts";
import { guardDisposeEvents } from "../render.ts";
import { INSTANCE_OPACITY, INSTANCE_UV_RECT } from "../materials.ts";
import { SIGN_SLOTS } from "./hallLayout.ts";
import { SignBinding, SignPanels } from "./signPanels.ts";
import { signOpacity } from "./signVisibility.ts";

afterEach(() => vi.restoreAllMocks());

const atlas = {
  rect: (slot: number) => ({
    col: slot % 2,
    row: Math.floor(slot / 2),
    uv: { u: (slot % 2) / 2, v: 1 - (Math.floor(slot / 2) + 1) / 6, w: 0.5, h: 1 / 6 },
  }),
};

test("one InstancedMesh sized for 12 slots serves every hall, on the shared sign material", () => {
  const panels = new SignPanels(atlas);
  expect(panels.mesh.material).toBe(MATERIALS.sign);
  expect(panels.mesh.instanceMatrix.count).toBe(SIGN_SLOTS);
  expect(panels.instances).toBe(0);
  panels.register(0, new Vector3(0, 1.5, 3));
  panels.register(3, new Vector3(12, 1.5, 3));
  expect(panels.instances).toBe(4);
  const uv = panels.mesh.geometry.getAttribute(INSTANCE_UV_RECT);
  expect([uv.getX(0), uv.getX(3)]).toEqual([0, 0.5]);
  panels.unregister(3);
  expect(panels.instances).toBe(1);
  panels.dispose();
});

test("panels fade over 200 ms when the camera turns away, and write the opacity attribute", () => {
  const panels = new SignPanels(atlas);
  const rig = createCameraRig({ width: 1280, height: 720 });
  rig.setFraming({ target: new Vector3(0, 1.5, 0), zoom: 120 });
  panels.register(0, new Vector3(0, 1.5, 3));
  panels.register(1, new Vector3(0, 1.5, -3));
  panels.update(rig, 0, true);
  expect(panels.fader.opacity(0)).toBe(1);
  rig.setFraming({ azimuth: Math.PI * 1.25 });
  panels.update(rig, 100, false);
  panels.update(rig, 200, false);
  panels.update(rig, 300, false);
  expect(panels.fader.opacity(0)).toBe(0);
  expect(panels.fader.opacity(1)).toBe(0);
  rig.setFraming({ azimuth: Math.PI / 4 });
  panels.update(rig, 400, false);
  panels.update(rig, 500, false);
  expect(panels.fader.opacity(0)).toBeGreaterThan(0);
  expect(panels.fader.opacity(0)).toBeLessThan(1);
  expect(panels.mesh.geometry.getAttribute(INSTANCE_OPACITY).getX(0)).toBe(panels.fader.opacity(0));
  expect(signOpacity(0)).toBe(panels.fader.opacity(0));
  panels.dispose();
});

test("a second SignPanels instance does not matter: one fader per instance in one panel mesh", () => {
  const panels = new SignPanels(atlas);
  panels.register(0, new Vector3(0, 1.5, 3));
  panels.register(1, new Vector3(9, 1.5, 3));
  const rig = createCameraRig({ width: 1280, height: 720 });
  rig.setFraming({ target: new Vector3(0, 1.5, 3), zoom: 120 });
  panels.update(rig, 0, true);
  expect(panels.fader.opacity(0)).toBe(1);
  expect(panels.fader.opacity(1)).toBe(1);
  panels.unregister(1);
  expect(panels.fader.opacity(0)).toBe(1);
  expect(panels.fader.opacity(1)).toBe(0);
  panels.dispose();
});

const SIGN_CENTRE = new Vector3(0, 1.55, 3.01);

test("a re-render with an equal but new `at` array keeps the slot registered at opacity 1", () => {
  const panels = new SignPanels(atlas);
  const unregister = vi.spyOn(panels, "unregister");
  const binding = new SignBinding(panels, SIGN_CENTRE);
  const rig = createCameraRig({ width: 1280, height: 720 });
  rig.setFraming({ target: new Vector3(12, 1.5, 3), zoom: 120 });
  binding.sync(1, [12, 0, 0]);
  panels.update(rig, 0, true);
  expect(panels.fader.opacity(1)).toBe(1);
  binding.sync(1, [12, 0, 0]);
  binding.sync(1, [12, 0, 0]);
  expect(unregister).not.toHaveBeenCalled();
  expect(panels.fader.opacity(1)).toBe(1);
  expect(panels.instances).toBe(2);
  // A real move updates the instance in place, still without unregistering.
  binding.sync(1, [14, 0, 0]);
  expect(unregister).not.toHaveBeenCalled();
  expect(panels.mesh.instanceMatrix.array[1 * 16 + 12]).toBe(14);
  binding.release();
  expect(unregister).toHaveBeenCalledTimes(1);
  panels.dispose();
});

test("registering an occupied slot warns once naming the slot and keeps the first owner", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const panels = new SignPanels(atlas);
  const first = new SignBinding(panels, SIGN_CENTRE);
  const second = new SignBinding(panels, SIGN_CENTRE);
  first.sync(2, [0, 0, 0]);
  second.sync(2, [50, 0, 0]);
  second.sync(2, [50, 0, 0]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain("slot 2");
  // The first owner's panel stays where it was, and the second owner's release does not hide it.
  expect(panels.mesh.instanceMatrix.array[2 * 16 + 12]).toBe(0);
  second.release();
  expect(panels.instances).toBe(3);
  expect(panels.mesh.instanceMatrix.array[2 * 16 + 12]).toBe(0);
  first.release();
  expect(panels.instances).toBe(0);
  panels.dispose();
});

test("SignPanels.dispose frees the panel geometry and mesh, and no shared material", () => {
  const panels = new SignPanels(atlas);
  const geometry = vi.spyOn(panels.mesh.geometry, "dispose");
  const mesh = vi.spyOn(panels.mesh, "dispose");
  const guard = guardDisposeEvents(allMaterials());
  panels.dispose();
  expect(geometry).toHaveBeenCalledTimes(1);
  expect(mesh).toHaveBeenCalledTimes(1);
  expect(guard.events()).toBe(0);
  guard.release();
});

test("a hall that loses the sign slot to another hall does not write that slot's atlas text", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const panels = new SignPanels(atlas);
  const written: string[] = [];
  const text = {
    setSign: (slot: number, letter: string, project: string) =>
      written.push(`${slot}:${letter}:${project}`),
  };
  const first = new SignBinding(panels, new Vector3(0, 1.5, 3));
  const second = new SignBinding(panels, new Vector3(0, 1.5, 3));
  first.sync(0, [0, 0, 0]);
  second.sync(0, [12, 0, 0]);
  expect(first.owns(0)).toBe(true);
  expect(second.owns(0)).toBe(false);
  expect(first.writeSign(text, 0, "A", "Northwind")).toBe(true);
  expect(second.writeSign(text, 0, "B", "Harbor")).toBe(false);
  expect(written).toEqual(["0:A:Northwind"]);
  // Once the first hall leaves, the slot is free for the second to take and write.
  first.release();
  second.sync(0, [12, 0, 1]);
  expect(second.writeSign(text, 0, "B", "Harbor")).toBe(true);
  expect(written).toEqual(["0:A:Northwind", "0:B:Harbor"]);
  panels.dispose();
});
