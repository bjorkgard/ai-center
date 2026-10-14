// The cooling vapour as closed forms (eng-review Phase 3 E26, design-review Phase 3 WD9, WD7):
// nothing here simulates. A particle's age is a function of scene time and its own offset, its
// size, rise and fade are functions of its age, and it shows while its index is under 60 x duty.
// All numbers are estimates from the plan.
export const VAPOUR = {
  // Seconds from birth to rebirth.
  life: 6,
  perTower: 60,
  fadeIn: 0.5,
  fadeOut: 1.5,
  // World units a particle rises per second, and the billboard's size at birth and at death.
  rise: 0.6,
  sizeFrom: 1.2,
  sizeTo: 2.4,
  // The largest sideways drift, in units per second, and the start scatter around the stack.
  drift: 0.18,
  scatter: 0.5,
  // The share of the vapour kept under reduced motion (design D20).
  reducedDensity: 0.3,
  color: "#8090A8",
  opacity: 0.35,
} as const;

// Fans turn 0.5 times a second at duty 1 and at a tenth of that at duty 0, so the plant never
// looks stopped; under reduced motion they turn at a quarter of that (WD7).
export const FAN = { turnsPerSecond: 0.5, idleShare: 0.1, reducedShare: 0.25 } as const;

export function clampDuty(duty: number): number {
  return Number.isNaN(duty) ? 0 : Math.min(Math.max(duty, 0), 1);
}

// The share of the vapour on screen: linear in duty, 30% of it under reduced motion.
export function vapourDensity(duty: number, reducedMotion: boolean): number {
  return clampDuty(duty) * (reducedMotion ? VAPOUR.reducedDensity : 1);
}

// Particle k of a tower (0-59) shows when k < 60 x density, within a float tolerance so a duty
// such as 0.7000000000000001 keeps the same 42 as 0.7.
export function particleShown(k: number, duty: number, reducedMotion: boolean): boolean {
  return k < VAPOUR.perTower * vapourDensity(duty, reducedMotion) - 1e-9;
}

// How many of a tower's particles show: the count of `particleShown`.
export function visibleCount(duty: number, reducedMotion: boolean): number {
  let n = 0;
  for (let k = 0; k < VAPOUR.perTower; k++) if (particleShown(k, duty, reducedMotion)) n++;
  return n;
}

// Fan speed in turns per second: linear from a tenth at duty 0 to the full 0.5 at duty 1.
export function fanTurnsPerSecond(duty: number, reducedMotion: boolean): number {
  const d = clampDuty(duty);
  const turns = FAN.turnsPerSecond * (FAN.idleShare + (1 - FAN.idleShare) * d);
  return reducedMotion ? turns * FAN.reducedShare : turns;
}

// Age in seconds of the particle with offset `offset` at scene time `t`: (t + offset) mod 6 s.
export function particleAge(t: number, offset: number): number {
  const age = (t + offset) % VAPOUR.life;
  return age < 0 ? age + VAPOUR.life : age;
}

// 0 to 1: in over the first 0.5 s, out over the last 1.5 s, so a rebirth never pops (E27).
export function particleFade(age: number): number {
  const rise = Math.min(age / VAPOUR.fadeIn, 1);
  const fall = Math.min((VAPOUR.life - age) / VAPOUR.fadeOut, 1);
  return Math.max(0, Math.min(rise, fall));
}

export function particleSize(age: number): number {
  return VAPOUR.sizeFrom + ((VAPOUR.sizeTo - VAPOUR.sizeFrom) * age) / VAPOUR.life;
}

export function particleRise(age: number): number {
  return VAPOUR.rise * age;
}

// Sorts `order` (a permutation of 0..n-1) so the particle with the greatest depth comes first:
// the far ones draw first and the near ones blend over them. In place and allocation free; an
// insertion sort, since the order of one frame is nearly the order of the next.
export function sortBackToFront(depths: ArrayLike<number>, order: Uint16Array): void {
  for (let i = 1; i < order.length; i++) {
    const item = order[i];
    const depth = depths[item];
    let j = i - 1;
    while (j >= 0 && depths[order[j]] < depth) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = item;
  }
}

// Which particles show. A particle takes the duty when it is reborn, so a change reaches the
// plume within one 6 s life; with no time passing (a frozen frame) nothing is reborn, so the
// change is taken at once. The first call takes it for every particle, which is the closed form.
export class VapourLatch {
  private readonly shown: Uint8Array;
  private readonly previousAge: Float64Array;
  private primed = false;
  private stalled = true;
  private lastTime = Number.NaN;

  readonly count: number;

  constructor(count: number) {
    this.count = count;
    this.shown = new Uint8Array(count);
    this.previousAge = new Float64Array(count);
  }

  // Call once per frame, before `isShown`, with the scene time.
  begin(time: number): void {
    this.stalled = !this.primed || time === this.lastTime;
    this.lastTime = time;
  }

  // Particle i of age `age` under `duty`.
  isShown(i: number, age: number, duty: number, reducedMotion: boolean): boolean {
    const reborn = age < this.previousAge[i];
    if (this.stalled || reborn || !this.primed) {
      this.shown[i] = particleShown(i % VAPOUR.perTower, duty, reducedMotion) ? 1 : 0;
    }
    this.previousAge[i] = age;
    return this.shown[i] === 1;
  }

  // Call after the last `isShown` of the frame.
  end(): void {
    this.primed = true;
  }
}
