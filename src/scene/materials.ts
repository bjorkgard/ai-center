import {
  Color,
  LineBasicMaterial,
  MeshStandardMaterial,
  Plane,
  Vector3,
  type CanvasTexture,
  type Material,
} from "three";
import { ROOF_CUT_CONSTANT } from "./hall/hallLayout.ts";

// Status palette (design D17); the same table drives LEDs, dots and table cells.
export const STATUS_COLORS = {
  idle: "#6B7385",
  thinking: "#A5B4FC",
  tool: "#34D399",
  waiting_user: "#FBBF24",
  error: "#F87171",
  done: "#475066",
} as const;
export type Status = keyof typeof STATUS_COLORS;
export const STATUS_ORDER = Object.keys(STATUS_COLORS) as Status[];

// Trim and avatars only, never status (design D17).
export const VENDOR_COLORS = { claude: "#F59E0B", codex: "#D1FAE5" } as const;

// Fibre lines. Cyan never means a status.
export const FIBRE_COLOR = "#22D3EE";

const WINDOW_COLOR = "#FFB45A";

// Site furniture is neutral slate and concrete (design-review Phase 3 D15, WD10) [estimated]:
// colour in the scene only means status, vendor trim, the cyan network and warm windows and lamps,
// so none of these sits near those. A test keeps their hue and saturation apart.
export const SITE_COLORS = {
  road: "#1a2130",
  marking: "#3a4559",
  padFace: "#1c2433",
  padLine: "#3a4559",
  wall: "#2e3748",
  roofSlab: "#232b3a",
  door: "#161c28",
  fence: "#2e3748",
  boom: "#323a4a",
  boomStripe: "#E8DCC8",
  monument: "#232b3a",
  tree: "#1d2b2a",
  trunk: "#2a2420",
  carGlass: "#0f1218",
  cars: ["#23262c", "#2b2e34", "#1b1d22"],
} as const;

const matte = (color: string) => new MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 });

// A matte material that takes its colour from the geometry's colour attribute.
const painted = (name: string) =>
  new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, name });

// Emits `color` and stays dark otherwise. Intensities put the glow above the bloom threshold
// (RENDER.bloom.luminanceThreshold); a test checks it.
const glow = (color: string, emissiveIntensity: number) =>
  glowing(
    new MeshStandardMaterial({
      color: "#0b0e14",
      emissive: color,
      emissiveIntensity,
      roughness: 0.6,
      metalness: 0,
    }),
  );

// Every glow material with its emissive intensity while bloom is on. While bloom is off the
// glow is scaled so it still reads (design-review Phase 3 WD4); the order is unchanged.
const GLOW_BASE = new Map<MeshStandardMaterial, number>();
export const BLOOM_OFF_GLOW = 1.5; // [estimated]

function glowing(material: MeshStandardMaterial): MeshStandardMaterial {
  GLOW_BASE.set(material, material.emissiveIntensity);
  return material;
}

// Called whenever the bloom state changes; a uniform change, so nothing recompiles.
export function setBloomGlow(bloomOn: boolean): void {
  for (const [material, base] of GLOW_BASE) {
    material.emissiveIntensity = bloomOn ? base : base * BLOOM_OFF_GLOW;
  }
}

export const INSTANCE_OPACITY = "instanceOpacity";
export const INSTANCE_UV_RECT = "instanceUvRect";

// Per-instance fades on a shared material (eng-review Phase 3 E27): an `instanceOpacity`
// attribute multiplies the alpha and, for atlas text, an `instanceUvRect` (u, v, w, h)
// attribute remaps the map UVs, so one InstancedMesh fades and relabels each instance alone.
// The cache key is fixed per variant, so every use shares one program.
export function addInstanceFade(material: Material, options: { atlas?: boolean } = {}): void {
  const atlas = options.atlas === true;
  const hook = (shader: { vertexShader: string; fragmentShader: string }) => {
    const patch = (source: string, marker: string, add: string, where: "after" | "before") => {
      if (!source.includes(marker)) {
        throw new Error(
          `instance fade: ${marker} not found in the shader of material "${material.name}"`,
        );
      }
      return source.replace(marker, where === "after" ? `${marker}\n${add}` : `${add}\n${marker}`);
    };
    const attributes = `attribute float ${INSTANCE_OPACITY};\nvarying float vInstanceOpacity;${
      atlas ? `\nattribute vec4 ${INSTANCE_UV_RECT};` : ""
    }`;
    let vertex = patch(shader.vertexShader, "#include <common>", attributes, "after");
    if (atlas) {
      vertex = patch(
        vertex,
        "#include <uv_vertex>",
        `#ifdef USE_MAP
vMapUv = vMapUv * ${INSTANCE_UV_RECT}.zw + ${INSTANCE_UV_RECT}.xy;
#endif
#ifdef USE_EMISSIVEMAP
vEmissiveMapUv = vEmissiveMapUv * ${INSTANCE_UV_RECT}.zw + ${INSTANCE_UV_RECT}.xy;
#endif`,
        "after",
      );
    }
    vertex = patch(
      vertex,
      "#include <begin_vertex>",
      `vInstanceOpacity = ${INSTANCE_OPACITY};`,
      "after",
    );
    shader.vertexShader = vertex;
    shader.fragmentShader = patch(
      patch(
        shader.fragmentShader,
        "#include <common>",
        `varying float vInstanceOpacity;\n// material: ${material.name}`,
        "after",
      ),
      "#include <opaque_fragment>",
      "gl_FragColor.a *= vInstanceOpacity;",
      "after",
    );
  };
  material.onBeforeCompile = (shader) => hook(shader);
  material.customProgramCacheKey = () => (atlas ? "instance-fade-atlas" : "instance-fade");
}

// The hall sign panels (chunk 06): atlas text under emissive 0.5, below the 0.6 bloom threshold.
function signMaterial(): MeshStandardMaterial {
  const material = glowing(
    new MeshStandardMaterial({
      color: "#ffffff",
      emissive: new Color("#ffffff"),
      emissiveIntensity: 0.5,
      roughness: 0.8,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      name: "sign",
    }),
  );
  addInstanceFade(material, { atlas: true });
  return material;
}

// One clipping plane for every hall body: normal (0, -1, 0), so a point is kept while it sits
// below `constant`. Starts cut at the wall top; roof.ts moves the constant, never the plane.
const ROOF_PLANE = new Plane(new Vector3(0, -1, 0), ROOF_CUT_CONSTANT);

// Below the glow of the windows and fibre: at 2.4 the tone mapping pushed thinking to white and
// idle and done to near the same grey, so the six statuses read as fewer colours.
const LED_INTENSITY = 1.0; // [estimated]

// One material for every instanced LED (chunk 07): the emissive is the per-instance colour
// (status colour times the pulse level) times the intensity, so one draw shows every status.
// The base colour stays dark; instance colour is the only thing that lights it.
function ledMaterial(): MeshStandardMaterial {
  const material = glow("#ffffff", LED_INTENSITY);
  material.name = "led";
  material.onBeforeCompile = (shader) => {
    const marker = "#include <emissivemap_fragment>";
    if (!shader.fragmentShader.includes(marker)) {
      throw new Error(`led: ${marker} not found in the shader of material "${material.name}"`);
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      marker,
      `${marker}\n#ifdef USE_COLOR\ntotalEmissiveRadiance *= vColor.rgb;\n#endif`,
    );
  };
  material.customProgramCacheKey = () => "led-instance-colour";
  return material;
}

// The road lamp heads: the warm of the windows, one rung below them on the ladder (1.6).
function lampMaterial(): MeshStandardMaterial {
  const material = glow(WINDOW_COLOR, 1.6);
  material.name = "lamp";
  return material;
}

const LEDS = Object.fromEntries(
  STATUS_ORDER.map((status) => [status, glow(STATUS_COLORS[status], LED_INTENSITY)]),
) as Record<Status, MeshStandardMaterial>;

// The shared material library (design D14). Every mesh uses these instances and never builds
// its own, so mounting and unmounting a view disposes none of them (RW6, E9).
export const MATERIALS = {
  ground: matte("#121926"),
  concrete: matte("#2e3748"),
  slate: matte("#3a4559"),
  roof: matte("#232b3a"),
  rack: new MeshStandardMaterial({ color: "#242c3b", roughness: 0.6, metalness: 0.1 }),
  hall: new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    clippingPlanes: [ROOF_PLANE],
    clipShadows: true,
    name: "hall",
  }),
  sign: signMaterial(),
  led: ledMaterial(),
  // The campus parts (chunk 08): flat roads, pads, gate, dock and monument, the instanced trees and
  // cars, and the road lamp heads. None carries a clipping plane (CEO W-RW19).
  site: painted("site"),
  tree: painted("tree"),
  car: new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.45,
    metalness: 0.3,
    name: "car",
  }),
  lamp: lampMaterial(),
  window: glow(WINDOW_COLOR, 2),
  fibre: glow(FIBRE_COLOR, 2.6),
  claude: new MeshStandardMaterial({
    color: VENDOR_COLORS.claude,
    emissive: VENDOR_COLORS.claude,
    emissiveIntensity: 0.25,
    roughness: 0.7,
  }),
  codex: new MeshStandardMaterial({
    color: VENDOR_COLORS.codex,
    emissive: VENDOR_COLORS.codex,
    emissiveIntensity: 0.15,
    roughness: 0.7,
  }),
  grid: new LineBasicMaterial({ color: "#222d42" }),
  // The dev waypoint graph (Campus section): a bright line over the roads.
  waypoints: new LineBasicMaterial({ color: "#e6ebf5" }),
} as const;

export function statusLed(status: Status): MeshStandardMaterial {
  return LEDS[status];
}

// The shared atlas texture reaches the sign material here (the material exists before the
// atlas does); both maps sample it, the second one so the text glows.
export function bindSignTexture(texture: CanvasTexture): void {
  const sign = MATERIALS.sign;
  if (sign.map === texture) return;
  sign.map = texture;
  sign.emissiveMap = texture;
  sign.needsUpdate = true;
}

export function allMaterials(): (MeshStandardMaterial | LineBasicMaterial)[] {
  return [...Object.values(MATERIALS), ...Object.values(LEDS)];
}
