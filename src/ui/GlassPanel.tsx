import type { HTMLAttributes } from "react";
import { useStore } from "../app/store/index.ts";
import {
  CURRENT_PHASE,
  CURRENT_WEATHER,
  FALLBACK_ALPHA,
  glassFill,
  UNDERLAY_RGB,
  type Phase,
  type Weather,
} from "./glass.ts";

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  phase?: Phase;
  weather?: Weather;
  rounded?: boolean;
}

// The one panel surface (design D18). Two layers under the content: a dark underlay in
// --color-bg whose alpha comes from glassFill (or the solid fallback under slow frames), and
// the constant 8% white tint. The panel itself carries the blur, border and radius.
// Callers position it (absolute or relative); the layers are positioned inside it.
export function GlassPanel({
  phase = CURRENT_PHASE,
  weather = CURRENT_WEATHER,
  rounded = true,
  className = "",
  children,
  ...rest
}: GlassPanelProps) {
  const slow = useStore((s) => s.quality !== "high");
  const reduced = useStore((s) => s.reducedMotion);
  const alpha = slow ? FALLBACK_ALPHA : glassFill(phase, weather);
  return (
    <div
      {...rest}
      data-glass={slow ? "fallback" : "adaptive"}
      className={`glass-panel pointer-events-auto isolate ${rounded ? "rounded-panel" : "rounded-none"} border border-glass-border ${className}`}
    >
      <div
        aria-hidden="true"
        data-glass-layer="dark"
        className="absolute inset-0 -z-10 rounded-[inherit] transition-[background-color] duration-(--dur-ui) ease-(--ease)"
        style={{
          backgroundColor: `rgb(${UNDERLAY_RGB} / ${alpha})`,
          transitionDuration: reduced ? "0ms" : undefined,
        }}
      />
      <div
        aria-hidden="true"
        data-glass-layer="tint"
        className="absolute inset-0 -z-10 rounded-[inherit] bg-glass"
      />
      {children}
    </div>
  );
}
