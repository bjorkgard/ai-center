import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../app/store/index.ts";
import { uiDurationMs } from "./duration.ts";
import { selectCard } from "../scene/cards/select.ts";
import { GlassPanel } from "./GlassPanel.tsx";
import { departedToasts, restoreToastFor, restoringToastVisible } from "./toasts.ts";

const RESTORING_ID = -1;

interface Item {
  id: number;
  text: string;
  restoring: boolean;
  leaving: boolean;
}

function Icon({ restoring, reduced }: { restoring: boolean; reduced: boolean }) {
  return restoring ? (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="var(--color-cyan)"
        strokeWidth="2"
        style={
          reduced
            ? undefined
            : { transformOrigin: "8px 8px", animation: "toast-spin 0.9s linear infinite" }
        }
      />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <circle cx="8" cy="8" r="4" fill="var(--color-status-tool)" />
    </svg>
  );
}

// Bottom-right above the tab strip, newest on top, inside one aria-live="polite" region
// (design D12, D22, DR9). Chunk 32 adds the 3-toast cap, overflow and error toasts.
export function ToastHost() {
  const webgl = useStore((s) => s.webgl);
  const reason = useStore((s) => s.webglReason);
  const sceneError = useStore((s) => s.sceneError);
  const toasts = useStore((s) => s.toasts);
  const reduced = useStore((s) => s.reducedMotion);
  const card = selectCard(webgl, reason, sceneError);

  const prev = useRef({ status: webgl, reason });
  useEffect(() => {
    if (restoreToastFor(prev.current, webgl, card)) {
      useStore.getState().pushToast("3D view restored");
    }
    prev.current = { status: webgl, reason };
  }, [webgl, reason, card]);

  const wanted = useMemo<Item[]>(
    () => [
      ...(restoringToastVisible(webgl, card)
        ? [{ id: RESTORING_ID, text: "Restoring 3D view", restoring: true, leaving: false }]
        : []),
      ...toasts.map((t) => ({ id: t.id, text: t.text, restoring: false, leaving: false })),
    ],
    [webgl, card, toasts],
  );

  // Items that left the wanted list stay for the exit animation, then drop.
  const [leaving, setLeaving] = useState<Item[]>([]);
  const previous = useRef<Item[]>([]);
  // Layout effect: a toast dropped for a card never paints over it.
  useLayoutEffect(() => {
    const gone = departedToasts(previous.current, wanted, card).map((p) => ({
      ...p,
      leaving: true,
    }));
    previous.current = wanted;
    // A card showing now also drops a restoring toast that is still exiting (DR5).
    setLeaving((current) => {
      const kept = card === null ? current : current.filter((l) => !l.restoring);
      return gone.length === 0 && kept.length === current.length ? current : [...kept, ...gone];
    });
  }, [wanted, card]);
  useEffect(() => {
    if (leaving.length === 0) return;
    const id = setTimeout(() => setLeaving([]), uiDurationMs());
    return () => clearTimeout(id);
  }, [leaving]);

  const ids = new Set(wanted.map((w) => w.id));
  const shown = [...wanted, ...leaving.filter((l) => !ids.has(l.id))];

  return (
    <div
      aria-live="polite"
      data-testid="toast-host"
      className="pointer-events-none absolute right-4 bottom-[64px] flex flex-col gap-2"
    >
      {shown.map((t) => (
        <GlassPanel
          key={t.id}
          data-testid="toast"
          className="relative flex w-[320px] items-center gap-2 px-4 py-3 text-body text-text"
          style={{
            animation: `${reduced ? "toast-fade" : "toast"}-${t.leaving ? "out" : "in"} var(--dur-ui) var(--ease) both`,
          }}
        >
          <Icon restoring={t.restoring} reduced={reduced} />
          <span>{t.text}</span>
        </GlassPanel>
      ))}
    </div>
  );
}
