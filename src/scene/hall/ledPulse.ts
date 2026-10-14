// The LED pulse (design-review Phase 3 WD6, WD7): an LED's emissive moves between 0.6 and 1.0 of
// its level, never lower, so every D17 colour stays legible. The period is 1.2-3.0 s, shorter
// under more load [estimated]. Under reduced motion the LEDs hold a steady 0.8.
export const PULSE = { min: 0.6, max: 1, fastPeriod: 1.2, slowPeriod: 3 } as const;
export const REDUCED_MOTION_LEVEL = 0.8;

export function pulsePeriod(load: number): number {
  const clamped = Math.min(Math.max(load, 0), 1);
  return PULSE.slowPeriod - (PULSE.slowPeriod - PULSE.fastPeriod) * clamped;
}

// The level in [0.6, 1] at scene time `t` seconds. `phase` (0-1) offsets one rack from the next.
// A rack with no load (0) shows no activity: it holds full level.
export function ledLevel(load: number, phase: number, t: number, reducedMotion: boolean): number {
  if (reducedMotion) return REDUCED_MOTION_LEVEL;
  if (load <= 0) return PULSE.max;
  const wave = 0.5 + 0.5 * Math.sin(2 * Math.PI * (t / pulsePeriod(load) + phase));
  return PULSE.min + (PULSE.max - PULSE.min) * wave;
}
