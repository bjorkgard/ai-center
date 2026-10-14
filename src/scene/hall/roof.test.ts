import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { MATERIALS, STATUS_ORDER, allMaterials, statusLed } from "../materials.ts";
import { clearSceneLines, lastSceneLines } from "../sceneLog.ts";
import { ROOF_CUT_CONSTANT, ROOF_TOP, ROOF_UNCUT_CONSTANT, WALL_TOP } from "./hallLayout.ts";
import { isRoofCut, setRoofCut, subscribeRoof } from "./roof.ts";

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  setRoofCut(true);
  clearSceneLines();
});
afterEach(() => vi.restoreAllMocks());

const plane = () => MATERIALS.hall.clippingPlanes![0];

test("the hall body material holds exactly one clipping plane with clipShadows", () => {
  expect(MATERIALS.hall.clippingPlanes).toHaveLength(1);
  expect(MATERIALS.hall.clipShadows).toBe(true);
});

test("the roof starts cut: the plane sits 0.01 above the wall top", () => {
  expect(isRoofCut()).toBe(true);
  expect(plane().constant).toBeCloseTo(WALL_TOP + 0.01, 9);
  expect(plane().constant).toBe(ROOF_CUT_CONSTANT);
  expect(plane().normal.toArray()).toEqual([0, -1, 0]);
});

test("a toggle changes only the plane's constant, and uncut clears the roof top", () => {
  const before = MATERIALS.hall.clippingPlanes![0];
  const normal = before.normal.toArray();
  setRoofCut(false);
  expect(MATERIALS.hall.clippingPlanes).toHaveLength(1);
  expect(MATERIALS.hall.clippingPlanes![0]).toBe(before);
  expect(before.normal.toArray()).toEqual(normal);
  expect(before.constant).toBe(ROOF_UNCUT_CONSTANT);
  expect(before.constant).toBeGreaterThan(ROOF_TOP);
  setRoofCut(true);
  expect(before.constant).toBe(ROOF_CUT_CONSTANT);
});

test("no other library material carries a clipping plane", () => {
  for (const [name, material] of Object.entries(MATERIALS)) {
    if (name === "hall") continue;
    expect((material as { clippingPlanes?: unknown }).clippingPlanes, name).toBeNull();
  }
});

test("no status LED material, and nothing in allMaterials but the hall body, carries a plane", () => {
  for (const status of STATUS_ORDER) {
    expect(statusLed(status).clippingPlanes, status).toBeNull();
  }
  const clipped = allMaterials().filter((m) => (m as { clippingPlanes?: unknown }).clippingPlanes);
  expect(clipped).toEqual([MATERIALS.hall]);
});

test("each real toggle logs one [scene] transition line and a repeat logs none", () => {
  setRoofCut(false);
  setRoofCut(false);
  expect(lastSceneLines()).toEqual(["[scene] roof cut -> uncut"]);
  setRoofCut(true);
  expect(lastSceneLines()).toHaveLength(2);
  expect(lastSceneLines()[1]).toBe("[scene] roof uncut -> cut");
});

test("subscribers hear a change, not a repeat", () => {
  const seen: boolean[] = [];
  const stop = subscribeRoof(() => seen.push(isRoofCut()));
  setRoofCut(false);
  setRoofCut(false);
  stop();
  setRoofCut(true);
  expect(seen).toEqual([false]);
});

test("a non-boolean argument warns naming it and changes nothing", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  setRoofCut("yes" as never);
  setRoofCut(undefined as never);
  expect(warn).toHaveBeenCalledTimes(2);
  expect(String(warn.mock.calls[0][0])).toContain("on");
  expect(isRoofCut()).toBe(true);
});
