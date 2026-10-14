import { Color, MeshStandardMaterial } from "three";
import { expect, test } from "vite-plus/test";
import {
  FIBRE_COLOR,
  MATERIALS,
  STATUS_COLORS,
  STATUS_ORDER,
  VENDOR_COLORS,
  allMaterials,
  statusLed,
} from "./materials.ts";
import { RENDER, guardDisposeEvents } from "./render.ts";

// Linear luminance of what the material emits, as the bloom threshold sees it.
function emitted(m: MeshStandardMaterial): number {
  const c = m.emissive;
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) * m.emissiveIntensity;
}

test("the six status LED colours are the D17 table", () => {
  expect(STATUS_COLORS).toEqual({
    idle: "#6B7385",
    thinking: "#A5B4FC",
    tool: "#34D399",
    waiting_user: "#FBBF24",
    error: "#F87171",
    done: "#475066",
  });
  expect(STATUS_ORDER).toHaveLength(6);
  for (const status of STATUS_ORDER) {
    const led = statusLed(status);
    expect(`#${led.emissive.getHexString().toUpperCase()}`).toBe(STATUS_COLORS[status]);
  }
});

test("vendor colours are the brand trim colours, and cyan is never a status", () => {
  expect(VENDOR_COLORS).toEqual({ claude: "#F59E0B", codex: "#D1FAE5" });
  expect(Object.values(STATUS_COLORS)).not.toContain(FIBRE_COLOR);
  expect(`#${MATERIALS.fibre.emissive.getHexString().toUpperCase()}`).toBe(FIBRE_COLOR);
});

test("the fibre and window emissives sit above the bloom threshold, the building greys below", () => {
  expect(emitted(MATERIALS.fibre)).toBeGreaterThan(RENDER.bloom.luminanceThreshold);
  expect(emitted(MATERIALS.window)).toBeGreaterThan(RENDER.bloom.luminanceThreshold);
  for (const grey of [MATERIALS.concrete, MATERIALS.slate, MATERIALS.ground]) {
    expect(emitted(grey)).toBe(0);
  }
});

test("the library is shared instances: the same object on every read, none new per call", () => {
  expect(statusLed("tool")).toBe(statusLed("tool"));
  const before = allMaterials();
  expect(allMaterials()).toEqual(before);
  expect(new Set(before).size).toBe(before.length);
  expect(before).toContain(statusLed("error"));
});

test("a shared material that is only read receives 0 dispose events", () => {
  const guard = guardDisposeEvents(allMaterials());
  statusLed("idle");
  expect(guard.events()).toBe(0);
  allMaterials()[0].dispose();
  expect(guard.events()).toBe(1);
  guard.release();
});

test("the dark building greys stay dark for the night contrast", () => {
  const dark = new Color("#404a5e");
  for (const grey of [MATERIALS.concrete, MATERIALS.slate, MATERIALS.ground]) {
    expect(grey.color.r + grey.color.g + grey.color.b).toBeLessThan(dark.r + dark.g + dark.b);
  }
});
