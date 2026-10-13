import { LineBasicMaterial, MeshStandardMaterial } from "three";

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

const matte = (color: string) => new MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 });

// Emits `color` and stays dark otherwise. Intensities put the glow above the bloom threshold
// (RENDER.bloom.luminanceThreshold); a test checks it.
const glow = (color: string, emissiveIntensity: number) =>
  new MeshStandardMaterial({
    color: "#0b0e14",
    emissive: color,
    emissiveIntensity,
    roughness: 0.6,
    metalness: 0,
  });

// Below the glow of the windows and fibre: at 2.4 the tone mapping pushed thinking to white and
// idle and done to near the same grey, so the six statuses read as fewer colours.
const LED_INTENSITY = 1.0; // [estimated]

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
} as const;

export function statusLed(status: Status): MeshStandardMaterial {
  return LEDS[status];
}

export function allMaterials(): (MeshStandardMaterial | LineBasicMaterial)[] {
  return [...Object.values(MATERIALS), ...Object.values(LEDS)];
}
