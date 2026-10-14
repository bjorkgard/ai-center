import { createRng, hash01 } from "../sim/rng.ts";
import { RACK_SLOTS } from "./hall/rackLayout.ts";
import { SIGN_SLOTS } from "./hall/hallLayout.ts";
import type { Status } from "./materials.ts";
import { PACKET, packetGap, packetTravel, wrapPhase } from "./fibre/packets.ts";
import { TOWER_COUNT } from "./plant/plantLayout.ts";
import { VAPOUR, clampDuty, fanTurnsPerSecond, particleAge } from "./plant/vapour.ts";
import type { HallSign, RackLoad, SceneSignals } from "./signals.ts";

// The first SceneSignals: closed forms in scene time and `seed`, so a frozen frame is the same
// every time. Only SceneSignals leaves this file's consumers' view: no component imports it.

// Status mix of the strips and blades (design-review Phase 3 WD6): no errors in the hero shot.
export const HERO_MIX = [
  ["tool", 0.6],
  ["thinking", 0.25],
  ["idle", 0.1],
  ["waiting_user", 0.05],
] as const satisfies readonly (readonly [Status, number])[];

// Maps a draw u in [0, 1) onto the mix.
export function heroStatus(u: number): Status {
  let edge = 0;
  for (const [status, share] of HERO_MIX) {
    edge += share;
    if (u < edge) return status;
  }
  return HERO_MIX[HERO_MIX.length - 1][0];
}

// Fixed fictional names, never read from the machine (D16, CEO W-RW34).
export const FAKE_PROJECTS = [
  "Northwind",
  "Harbor",
  "Lumen",
  "Quarry",
  "Tidewater",
  "Juniper",
  "Meridian",
  "Cobalt",
  "Foxglove",
  "Ironwood",
  "Larkspur",
  "Saltmarsh",
] as const;

const MAX_BLADES_LIT = 6;
const IDLE_RACK: RackLoad = { status: "idle", blades: [], load: 0, phase: 0 };
const TAU = 2 * Math.PI;

export interface FakeOptions {
  seed: number;
  // Scene time in seconds.
  now: () => number;
  // A fixed rack count for every hall (view=hall, view=racks) instead of the time-varying one.
  racks?: number;
  // The dev duty slider: a number replaces the fake duty, null leaves it alone.
  dutyOverride?: () => number | null;
  // The dev packet rate: a number replaces the default, null leaves it alone.
  packetRateOverride?: () => number | null;
}

// The fake duty: a slow swell around 0.75 that starts at 0.75 at scene time 0, so the frozen
// shots show a busy plant (chunk 09).
export const FAKE_DUTY = { mean: 0.75, swing: 0.2, period: 90 } as const;
// A frame step above this is a pause or a jump in scene time, and a fan does not catch up on it.
const MAX_FAN_STEP = 1;

export function createFakeSignals({
  seed,
  now,
  racks,
  dutyOverride,
  packetRateOverride,
}: FakeOptions): SceneSignals {
  // Every hall and rack drawn once up front, so reads in the frame loop allocate nothing.
  const loads: RackLoad[][] = Array.from({ length: SIGN_SLOTS }, (_, hall) =>
    Array.from({ length: RACK_SLOTS }, (_, rack) => {
      const rng = createRng(Math.floor(hash01(seed, hall, rack) * 0x7fffffff));
      const blades = Array.from({ length: rng.int(MAX_BLADES_LIT + 1) }, () =>
        heroStatus(rng.next()),
      );
      return {
        status: heroStatus(rng.next()),
        blades,
        load: 0.1 + 0.9 * rng.next(),
        phase: rng.next(),
      };
    }),
  );
  // One offset per vapour particle in 0-6 s, one start angle per fan, drawn up front.
  const particles = TOWER_COUNT * VAPOUR.perTower;
  const vapourOffsets = Array.from(
    { length: particles },
    (_, i) => hash01(seed, i, 7) * VAPOUR.life,
  );
  const fanStart = Array.from({ length: TOWER_COUNT }, (_, i) => hash01(seed, i, 8) * TAU);
  const fanTurned = Array.from({ length: TOWER_COUNT }, () => 0);
  const fanLast = Array.from({ length: TOWER_COUNT }, () => 0);
  const duty = () => {
    const forced = dutyOverride?.() ?? null;
    if (forced !== null) return clampDuty(forced);
    return clampDuty(FAKE_DUTY.mean + FAKE_DUTY.swing * Math.sin((TAU * now()) / FAKE_DUTY.period));
  };
  const offsets = Array.from({ length: SIGN_SLOTS }, (_, hall) => hash01(seed, hall, 99) * TAU);

  return {
    rackCount(hall) {
      if (racks !== undefined) return racks;
      const wave = Math.sin(now() / 24 + (offsets[hall] ?? 0));
      return Math.min(Math.max(Math.round(8 + 7 * wave), 0), RACK_SLOTS);
    },
    ledLoad(hall, rack) {
      return loads[hall]?.[rack] ?? IDLE_RACK;
    },
    hallSign(hall): HallSign {
      const slot = Math.min(Math.max(Math.trunc(hall) || 0, 0), SIGN_SLOTS - 1);
      return { letter: String.fromCharCode(65 + slot), project: FAKE_PROJECTS[slot] };
    },
    duty,
    vapourPhase(i) {
      return particleAge(now(), vapourOffsets[i] ?? 0);
    },
    fanAngle(i, reducedMotion = false) {
      const fan = Math.min(Math.max(Math.trunc(i) || 0, 0), TOWER_COUNT - 1);
      const t = now();
      const step = t - fanLast[fan];
      fanLast[fan] = t;
      if (step > 0 && step <= MAX_FAN_STEP) {
        fanTurned[fan] += TAU * fanTurnsPerSecond(duty(), reducedMotion) * step;
      }
      return fanStart[fan] + fanTurned[fan];
    },
    packetRate() {
      const forced = packetRateOverride?.() ?? null;
      const rate = forced ?? PACKET.defaultRate;
      return Number.isNaN(rate) ? 0 : Math.min(Math.max(rate, 0), PACKET.maxRate);
    },
    // Every line reads the same closed form: the line only decides where the distance wraps.
    packetPhase(_line, i, length, count, reducedMotion = false) {
      return wrapPhase(packetTravel(now(), reducedMotion) + packetGap(length, count) * i, length);
    },
  };
}
