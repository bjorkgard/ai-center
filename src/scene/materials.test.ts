import { Color, MeshStandardMaterial } from "three";
import { expect, test } from "vite-plus/test";
import {
  BLOOM_OFF_GLOW,
  FIBRE_COLOR,
  INSTANCE_OPACITY,
  INSTANCE_UV_RECT,
  MATERIALS,
  STATUS_COLORS,
  SITE_COLORS,
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

test("the instanced LED material emits its per-instance colour at the LED rung of the ladder", () => {
  expect(MATERIALS.led.emissiveIntensity).toBe(1);
  expect(MATERIALS.led.name).toBe("led");
  expect(allMaterials()).toContain(MATERIALS.led);
  const shader = {
    vertexShader: "",
    fragmentShader: "#include <common>\n#include <emissivemap_fragment>\nvoid main(){}",
  };
  MATERIALS.led.onBeforeCompile(shader as never, {} as never);
  expect(shader.fragmentShader).toMatch(
    /#ifdef USE_COLOR\s+totalEmissiveRadiance\s*\*=\s*vColor\.rgb/,
  );
  expect(MATERIALS.led.customProgramCacheKey()).toBe(MATERIALS.led.customProgramCacheKey());
  expect(() =>
    MATERIALS.led.onBeforeCompile(
      { vertexShader: "", fragmentShader: "void main(){}" } as never,
      {} as never,
    ),
  ).toThrow(/led/);
});

test("the LED material scales x1.5 with bloom off like every other glow", () => {
  try {
    setBloomGlow(false);
    expect(MATERIALS.led.emissiveIntensity).toBeCloseTo(1.5, 9);
  } finally {
    setBloomGlow(true);
  }
  expect(MATERIALS.led.emissiveIntensity).toBe(1);
});

test("emissive ladder with the lamps: LEDs 1.0 < lamps 1.6 < windows 2.0, the lamp warm like the windows", () => {
  expect(MATERIALS.lamp.emissiveIntensity).toBe(1.6);
  expect(MATERIALS.lamp.name).toBe("lamp");
  expect(MATERIALS.lamp.emissiveIntensity).toBeGreaterThan(MATERIALS.led.emissiveIntensity);
  expect(MATERIALS.lamp.emissiveIntensity).toBeLessThan(MATERIALS.window.emissiveIntensity);
  expect(emitted(MATERIALS.lamp)).toBeGreaterThan(RENDER.bloom.luminanceThreshold);
  expect(MATERIALS.lamp.emissive.getHex()).toBe(MATERIALS.window.emissive.getHex());
});

test("with bloom off the lamp is x1.5 and stays between the LED and the window", () => {
  try {
    setBloomGlow(false);
    expect(MATERIALS.lamp.emissiveIntensity).toBeCloseTo(1.6 * 1.5, 9);
    expect(MATERIALS.lamp.emissiveIntensity).toBeGreaterThan(MATERIALS.led.emissiveIntensity);
    expect(MATERIALS.lamp.emissiveIntensity).toBeLessThan(MATERIALS.window.emissiveIntensity);
  } finally {
    setBloomGlow(true);
  }
  expect(MATERIALS.lamp.emissiveIntensity).toBe(1.6);
});

test("the campus materials are shared library instances and none carries a clipping plane", () => {
  for (const key of ["site", "tree", "car", "lamp"] as const) {
    expect(allMaterials()).toContain(MATERIALS[key]);
    expect(MATERIALS[key].clippingPlanes ?? []).toHaveLength(0);
    expect(MATERIALS[key].name).toBe(key);
  }
  expect(MATERIALS.tree).not.toBe(MATERIALS.site);
  expect(MATERIALS.tree.vertexColors).toBe(true);
  expect(MATERIALS.site.vertexColors).toBe(true);
});

// Hue in degrees and saturation 0-1 of a hex colour.
function hs(hex: string): { h: number; s: number; l: number } {
  const out = { h: 0, s: 0, l: 0 };
  new Color(hex).getHSL(out, "srgb");
  return { h: out.h * 360, s: out.s, l: out.l };
}

// Colour in the scene only means something (design-review Phase 3 WD10): status, vendor trim,
// cyan network and warm windows and lamps. Furniture stays neutral, so none sits near them.
const SIGNALS = {
  ...STATUS_COLORS,
  claude: VENDOR_COLORS.claude,
  codex: VENDOR_COLORS.codex,
  fibre: FIBRE_COLOR,
  warm: `#${MATERIALS.window.emissive.getHexString()}`,
};
// Idle and done are slate greys by design (D17); lightness, not hue, tells them apart, so only
// they are left out of the pairwise hue test.
const CHROMATIC = Object.entries(SIGNALS).filter(([, hex]) => hs(hex).s >= 0.2);
// A furniture colour with more saturation than this is only allowed in the slate blue band (the
// roads, pads, walls) or as a pale warm white (the boom stripes).
const NEUTRAL_SATURATION = 0.2;
const SLATE_HUES = [205, 235];
const PALE = 0.75;

// The reasons a furniture colour breaks the rule; empty when it keeps its distance. Above the
// chromatic cap (s > 0.35, l > 0.2) a colour has no escape: its hue stays 40 degrees from every
// chromatic signal and the slate exemption does not apply. Pale colours (the warm-white boom
// stripes) are exempt from the cap and only need the saturation gap.
const CHROMATIC_CAP = 0.35;
function violations(colour: string): string[] {
  const f = hs(colour);
  const out: string[] = [];
  const hueGap = (hex: string) => {
    const d = Math.abs(f.h - hs(hex).h);
    return Math.min(d, 360 - d);
  };
  const chromatic = f.s > CHROMATIC_CAP && f.l > 0.2 && f.l <= PALE;
  const slate = f.h >= SLATE_HUES[0] && f.h <= SLATE_HUES[1];
  if (!chromatic && f.s > NEUTRAL_SATURATION && f.l <= PALE && !slate) {
    out.push(`${colour} is coloured, not slate`);
  }
  // A pale colour only gets the exemption while it keeps clear of the cool and red signals: a pale
  // periwinkle (thinking) or pale pink (error) is still those colours. The warm signals are left
  // to the saturation gap below, since the warm-white boom stripe sits near them by design. 30
  // degrees, because the boom stripe is 37.5 from error's red.
  if (f.l > PALE) {
    for (const name of ["thinking", "tool", "error", "codex", "fibre"] as const) {
      if (hueGap(SIGNALS[name]) < 30) out.push(`${colour} is a pale ${name}`);
    }
  }
  for (const [name, hex] of CHROMATIC) {
    const c = hs(hex);
    const apart = Math.min(Math.abs(f.h - c.h), 360 - Math.abs(f.h - c.h));
    const ok = chromatic ? apart >= 40 : apart >= 40 || Math.abs(f.s - c.s) >= 0.3;
    if (!ok) out.push(`${colour} is near ${name} ${hex}`);
  }
  return out;
}

test("every furniture colour keeps its hue and saturation away from the status, vendor, cyan and warm colours", () => {
  const furniture = Object.values(SITE_COLORS).flat();
  expect(furniture.length).toBeGreaterThan(14);
  const neutral = Object.entries(SIGNALS).filter(([, hex]) => hs(hex).s < 0.2);
  expect(neutral.map(([name]) => name).sort()).toEqual(["done", "idle"]);
  for (const colour of furniture) expect(violations(colour), colour).toEqual([]);
});

test("the palette rule fails red, green and brown furniture, so a saturated colour cannot slip through", () => {
  for (const bad of [
    "#cc4444",
    "#4a7a4a",
    "#a52a2a",
    "#3d6b45",
    "#993333",
    "#228b22",
    "#4455aa",
    "#3344cc",
    "#6677cc",
    "#b4bce8",
    "#f0c8c8",
  ]) {
    expect(violations(bad), bad).not.toEqual([]);
  }
});

test("the site palette is the one in the plan: roads a step above the ground, trees, boom and cars", () => {
  expect(SITE_COLORS.road).toBe("#1a2130");
  expect(SITE_COLORS.padFace).toBe("#1c2433");
  expect(SITE_COLORS.marking).toBe("#3a4559");
  expect(SITE_COLORS.fence).toBe("#2e3748");
  expect(SITE_COLORS.boomStripe).toBe("#E8DCC8");
  expect(SITE_COLORS.tree).toBe("#1d2b2a");
  expect(SITE_COLORS.trunk).toBe("#2a2420");
  expect(SITE_COLORS.cars).toHaveLength(3);
  const ground = new Color("#121926");
  const road = new Color(SITE_COLORS.road);
  expect(road.r + road.g + road.b).toBeGreaterThan(ground.r + ground.g + ground.b);
  for (const car of SITE_COLORS.cars) {
    expect(hs(car).s).toBeLessThan(0.2);
    expect(hs(car).l).toBeLessThan(0.2);
  }
});
