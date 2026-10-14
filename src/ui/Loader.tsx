import { useEffect, useState } from "react";
import { useStore } from "../app/store/index.ts";
import { uiDurationMs } from "./duration.ts";

const SHOW_AFTER_MS = 300; // [estimated]

// Covers the 3D area until the first frame, or until WebGL is unavailable (design D10,
// DR2, CEO S-RW19). It appears only after 300 ms, so a fast start shows nothing, fades
// out over --dur-ui and, under reduced motion, cuts instantly. It never comes back.
export function Loader({ ready }: { ready: boolean }) {
  const unavailable = useStore((s) => s.webgl === "unavailable");
  const reduced = useStore((s) => s.reducedMotion);
  const [ended, setEnded] = useState(false);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(false);
  if ((ready || unavailable) && !ended) setEnded(true);

  useEffect(() => {
    const id = setTimeout(() => setShown(true), SHOW_AFTER_MS);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!ended || !shown || reduced) return;
    const id = setTimeout(() => setDone(true), uiDurationMs());
    return () => clearTimeout(id);
  }, [ended, shown, reduced]);

  if (done || !shown || (ended && reduced)) return null;
  const phase = ended ? "fading" : "shown";
  return (
    <div
      aria-hidden="true"
      data-testid="loader"
      data-phase={phase}
      className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-bg transition-opacity duration-(--dur-ui) ease-(--ease)"
      style={{ opacity: phase === "fading" ? 0 : 1 }}
    >
      <div data-testid="loader-wordmark" className="text-title font-semibold text-text">
        Synapse Horizon
      </div>
      <div className="mt-4 h-0.5 w-40 overflow-hidden">
        <div
          data-testid="loader-bar"
          className="h-full w-full bg-cyan"
          style={reduced ? undefined : { animation: "loader-sweep 1.2s linear infinite" }}
        />
      </div>
    </div>
  );
}
