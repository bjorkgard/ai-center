import { expect, test } from "vite-plus/test";
import { hudRows, type HudInput } from "./hud.ts";

const base: HudInput = {
  fps: 59.6,
  frozen: false,
  stats: {
    frames: 10,
    composerGen: 0,
    sceneCalls: 4,
    postCalls: 17,
    triangles: 1234,
    geometries: 3,
    textures: 1,
    programs: 5,
    capFps: 60,
    mode: "active",
    frameErrors: 0,
    projection: "orthographic",
    bloom: true,
    composerReady: true,
  },
  quality: "high",
  webgl: "ok",
};

const text = (input: HudInput) => hudRows(input).map(([k, v]) => `${k}: ${v}`);

test("the HUD lists fps, scene and post draw calls, triangles and renderer.info counts", () => {
  const rows = text(base);
  expect(rows).toContain("fps: 60");
  expect(rows).toContain("scene calls: 4");
  expect(rows).toContain("post calls: 17");
  expect(rows).toContain("triangles: 1234");
  expect(rows).toContain("geometries: 3");
  expect(rows).toContain("textures: 1");
  expect(rows).toContain("programs: 5");
  expect(rows).toContain("cap: 60 fps active");
  expect(rows).toContain("quality: high");
  expect(rows).toContain("webgl: ok");
  expect(rows).toContain("frame errors: 0");
  expect(rows).toContain("camera: orthographic");
});

test("under freeze the HUD says frozen in place of fps and keeps the counts", () => {
  const rows = text({ ...base, frozen: true });
  expect(rows).toContain("fps: frozen");
  expect(rows).toContain("scene calls: 4");
  expect(rows).toContain("triangles: 1234");
});

test("before the first frame the HUD shows dashes, not NaN", () => {
  const rows = text({ ...base, stats: null, fps: 0 });
  expect(rows.join("\n")).not.toContain("NaN");
  expect(rows).toContain("scene calls: -");
});
