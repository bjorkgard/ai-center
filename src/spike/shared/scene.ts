// Pure scene layout shared by both spike views: one definition of what is drawn
// is the fairness guarantee (PLAN chunk 03, RW8).
export type Load = 1 | 4;

export const BASE_HALLS = 12;
export const CHURN_HALLS = 6;
export const MAX_HALLS = BASE_HALLS + CHURN_HALLS;
export const LEDS_PER_RACK = 16;

const HALL_COLUMNS = 6;
const HALL_HEIGHT = 0.2;
const RACK_SIZE = { x: 0.5, y: 1.4, z: 0.8 };
const RACK_PITCH = { x: 0.8, z: 1.2 };
const LED_SIZE = { x: 0.06, y: 0.06, z: 0.04 };
const LED_GRID = 4;
const HALL_MARGIN = 0.8;
const HALL_GAP = 1.2;

export function racksPerHall(load: Load): number {
  return 16 * load;
}

export function ledsPerHall(load: Load): number {
  return racksPerHall(load) * LEDS_PER_RACK;
}

export function sceneCounts(load: Load, halls = BASE_HALLS) {
  return { halls, racks: halls * racksPerHall(load), leds: halls * ledsPerHall(load) };
}

function rackGridSide(load: Load): number {
  return Math.sqrt(racksPerHall(load));
}

export function hallSize(load: Load) {
  const side = rackGridSide(load);
  return {
    width: side * RACK_PITCH.x + HALL_MARGIN,
    height: HALL_HEIGHT,
    depth: side * RACK_PITCH.z + HALL_MARGIN,
  };
}

export function hallOrigin(index: number, load: Load): { x: number; z: number } {
  const size = hallSize(load);
  return {
    x: (index % HALL_COLUMNS) * (size.width + HALL_GAP),
    z: Math.floor(index / HALL_COLUMNS) * (size.depth + HALL_GAP),
  };
}

export function rackCentre(rack: number, load: Load) {
  const side = rackGridSide(load);
  return {
    x: ((rack % side) - (side - 1) / 2) * RACK_PITCH.x,
    y: HALL_HEIGHT + RACK_SIZE.y / 2,
    z: (Math.floor(rack / side) - (side - 1) / 2) * RACK_PITCH.z,
  };
}

function writeMatrix(
  out: Float32Array,
  i: number,
  scale: { x: number; y: number; z: number },
  x: number,
  y: number,
  z: number,
) {
  const o = i * 16;
  out.fill(0, o, o + 16);
  out[o] = scale.x;
  out[o + 5] = scale.y;
  out[o + 10] = scale.z;
  out[o + 12] = x;
  out[o + 13] = y;
  out[o + 14] = z;
  out[o + 15] = 1;
}

// Column-major instance matrices, local to the hall centre; unit box geometry.
export function fillRackMatrices(out: Float32Array, load: Load): void {
  for (let r = 0; r < racksPerHall(load); r++) {
    const c = rackCentre(r, load);
    writeMatrix(out, r, RACK_SIZE, c.x, c.y, c.z);
  }
}

export function fillLedMatrices(out: Float32Array, load: Load): void {
  for (let r = 0; r < racksPerHall(load); r++) {
    const c = rackCentre(r, load);
    for (let l = 0; l < LEDS_PER_RACK; l++) {
      const col = l % LED_GRID;
      const row = Math.floor(l / LED_GRID);
      writeMatrix(
        out,
        r * LEDS_PER_RACK + l,
        LED_SIZE,
        c.x + (col - (LED_GRID - 1) / 2) * 0.1,
        c.y + (row - (LED_GRID - 1) / 2) * 0.28,
        c.z + RACK_SIZE.z / 2 + LED_SIZE.z / 2,
      );
    }
  }
}

// Camera and light placement for the full 18-hall footprint, computed from the layout.
export function viewPlan(load: Load) {
  const size = hallSize(load);
  const pitchX = size.width + HALL_GAP;
  const pitchZ = size.depth + HALL_GAP;
  const rows = MAX_HALLS / HALL_COLUMNS;
  const centre = { x: ((HALL_COLUMNS - 1) * pitchX) / 2, z: ((rows - 1) * pitchZ) / 2 };
  const span = Math.max(HALL_COLUMNS * pitchX, rows * pitchZ * 1.6);
  return {
    centre,
    camera: {
      fov: 40,
      position: [centre.x, span * 0.75, centre.z + span * 0.8] as const,
    },
    light: {
      position: [centre.x - span * 0.3, span * 0.8, centre.z + span * 0.3] as const,
      shadowExtent: span * 0.7,
      far: span * 3,
    },
  };
}
