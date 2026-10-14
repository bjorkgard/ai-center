import { Color, MeshStandardMaterial } from "three";
import { expect, test } from "vite-plus/test";
import {
  BLOOM_OFF_GLOW,
  FIBRE_COLOR,
  INSTANCE_OPACITY,
  INSTANCE_UV_RECT,
  MATERIALS,
  STATUS_COLORS,
  STATUS_ORDER,
  VENDOR_COLORS,
  addInstanceFade,
  allMaterials,
  setBloomGlow,
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

test("emissive ladder: sign 0.5 < LEDs 1.0 < windows 2.0 < fibre 2.6, the sign under the bloom threshold", () => {
  const ladder = [
    MATERIALS.sign.emissiveIntensity,
    ...STATUS_ORDER.map((s) => statusLed(s).emissiveIntensity),
    MATERIALS.window.emissiveIntensity,
    MATERIALS.fibre.emissiveIntensity,
  ];
  expect(ladder).toEqual([0.5, 1, 1, 1, 1, 1, 1, 2, 2.6]);
  expect(emitted(MATERIALS.sign)).toBeLessThan(RENDER.bloom.luminanceThreshold);
});

test("with bloom off every glow material is x1.5 and the ladder order holds, then bloom on restores it", () => {
  const glows = [MATERIALS.sign, statusLed("tool"), MATERIALS.window, MATERIALS.fibre];
  const before = glows.map((m) => m.emissiveIntensity);
  try {
    setBloomGlow(false);
    expect(BLOOM_OFF_GLOW).toBe(1.5);
    glows.forEach((m, i) => expect(m.emissiveIntensity).toBeCloseTo(before[i] * 1.5, 9));
    const [sign, led, windows, fibre] = glows.map((m) => m.emissiveIntensity);
    expect(sign).toBeLessThan(led);
    expect(led).toBeLessThan(windows);
    expect(windows).toBeLessThan(fibre);
    // Calling it again does not compound.
    setBloomGlow(false);
    expect(MATERIALS.fibre.emissiveIntensity).toBeCloseTo(before[3] * 1.5, 9);
  } finally {
    setBloomGlow(true);
  }
  glows.forEach((m, i) => expect(m.emissiveIntensity).toBeCloseTo(before[i], 9));
});

// The three shader chunks the helper hooks, as they appear in a standard material's shaders.
const standIn = () => ({
  vertexShader: "#include <common>\n#include <uv_vertex>\n#include <begin_vertex>\nvoid main(){}",
  fragmentShader: "#include <common>\n#include <opaque_fragment>\nvoid main(){}",
});

test("the fade helper injects a per-instance opacity attribute and multiplies the alpha", () => {
  const material = new MeshStandardMaterial({ name: "probe" });
  addInstanceFade(material);
  const shader = standIn();
  material.onBeforeCompile(shader as never, {} as never);
  expect(shader.vertexShader).toContain(`attribute float ${INSTANCE_OPACITY};`);
  expect(shader.vertexShader).toMatch(/vInstanceOpacity\s*=\s*instanceOpacity;/);
  expect(shader.fragmentShader).toContain("varying float vInstanceOpacity;");
  expect(shader.fragmentShader).toContain("// material: probe");
  expect(shader.fragmentShader).toMatch(/gl_FragColor\.a\s*\*=\s*vInstanceOpacity;/);
  expect(shader.vertexShader).not.toContain(INSTANCE_UV_RECT);
  expect(material.customProgramCacheKey()).toBe(material.customProgramCacheKey());
  expect(material.customProgramCacheKey()).toMatch(/instance-fade/);
});

test("the atlas variant also remaps the map UVs by a per-instance rectangle", () => {
  const material = new MeshStandardMaterial();
  addInstanceFade(material, { atlas: true });
  const shader = standIn();
  material.onBeforeCompile(shader as never, {} as never);
  expect(shader.vertexShader).toContain(`attribute vec4 ${INSTANCE_UV_RECT};`);
  expect(shader.vertexShader).toMatch(
    /vMapUv\s*=\s*vMapUv\s*\*\s*instanceUvRect\.zw\s*\+\s*instanceUvRect\.xy/,
  );
  expect(shader.vertexShader).toMatch(/vEmissiveMapUv\s*=\s*vEmissiveMapUv\s*\*/);
  const plain = new MeshStandardMaterial();
  addInstanceFade(plain);
  expect(material.customProgramCacheKey()).not.toBe(plain.customProgramCacheKey());
});

test("a shader missing a hooked chunk is reported by name, not left half patched", () => {
  const material = new MeshStandardMaterial({ name: "probe" });
  addInstanceFade(material);
  expect(() =>
    material.onBeforeCompile(
      { vertexShader: "void main(){}", fragmentShader: "" } as never,
      {} as never,
    ),
  ).toThrow(/probe/);
});

test("the sign panel material uses the fade helper with the atlas variant", () => {
  expect(MATERIALS.sign.customProgramCacheKey()).toMatch(/instance-fade/);
  expect(MATERIALS.sign.transparent).toBe(true);
});
