export type Phase = "night" | "dusk" | "day";
export type Weather = "clear" | "heatwave" | "monsoon" | "storm";

// Dark underlay alpha beneath the constant 8% white tint (design D18, D21, CEO C21).
// Only day + heatwave leaves its phase's clear level (S-RW15). No GPU readback.
export function glassFill(phase: Phase, weather: Weather): number {
  if (phase === "night") return 0;
  if (phase === "dusk") return 0.3;
  return weather === "heatwave" ? 0.72 : 0.6;
}

// Solid fallback under slow frames (DR7); replaces only the dark layer.
export const FALLBACK_ALPHA = 0.85;

// --color-bg as channels, so the alpha can change and crossfade.
export const UNDERLAY_RGB = "7 10 18";

// Until chunks 34 and 35 put phase and weather in the store, panels read night and clear.
export const CURRENT_PHASE: Phase = "night";
export const CURRENT_WEATHER: Weather = "clear";
