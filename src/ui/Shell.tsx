import { useEffect, useRef, type ReactNode } from "react";
import { useStore } from "../app/store/index.ts";
import { GlassPanel } from "./GlassPanel.tsx";
import { carveSafeArea, createSafeAreaWatcher, type Rect } from "./safeArea.ts";

const KPI_TITLES = ["Claude sessions", "Codex sessions", "Agents"];
const TABS = ["Sessions", "Subagents", "Tool calls", "Tokens", "Errors", "Projects"];

const title = "m-0 text-label font-normal text-text-2";

// A slot is a measured panel unless it sits in a group that is measured as one (the KPI row).
function Slot(props: { name: string; className: string; grouped?: boolean; children: ReactNode }) {
  return (
    <GlassPanel
      data-panel={props.grouped ? undefined : ""}
      data-testid={`slot-${props.name}`}
      className={props.className}
    >
      {props.children}
    </GlassPanel>
  );
}

const rectOf = (el: Element, origin: DOMRect): Rect => {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left - origin.left),
    y: Math.round(r.top - origin.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
};

// The empty dashboard frame (design D5). Sizes are the same at every window size; the 3D
// area takes the extra space. Panels block pointer events; the gaps pass them through.
// `stage` (the 3D canvas, its backdrop and the loader) sits right after the top bar in the DOM,
// so the canvas is the next Tab stop after the top bar (DR12); the top bar's z-index keeps it
// painted above the stage.
export function Shell({ stage }: { stage: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const rightPanelOpen = useStore((s) => s.rightPanelOpen);

  // Re-runs when the right panel mounts or unmounts so the new element is observed.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // The home area is the canvas minus the top bar and the tab strip only (decision H1).
    const syncHome = (origin: DOMRect) => {
      const bars = ["slot-top-bar", "slot-tab-strip"].flatMap((id) => {
        const bar = el.querySelector(`[data-testid=${id}]`);
        return bar ? [rectOf(bar, origin)] : [];
      });
      const canvas = {
        x: 0,
        y: 0,
        width: Math.round(origin.width),
        height: Math.round(origin.height),
      };
      const next = carveSafeArea(canvas, bars);
      const now = useStore.getState().homeArea;
      const same =
        now.x === next.x &&
        now.y === next.y &&
        now.width === next.width &&
        now.height === next.height;
      if (!same && next.width > 0 && next.height > 0) useStore.getState().setHomeArea(next);
    };
    const measure = () => {
      const origin = el.getBoundingClientRect();
      syncHome(origin);
      return {
        canvas: { x: 0, y: 0, width: Math.round(origin.width), height: Math.round(origin.height) },
        panels: [...el.querySelectorAll("[data-panel]")].map((p) => rectOf(p, origin)),
      };
    };
    const watcher = createSafeAreaWatcher({
      measure,
      read: () => useStore.getState().safeArea,
      write: (area) => useStore.getState().setSafeArea(area),
      raf: (cb) => requestAnimationFrame(cb),
      caf: (id) => cancelAnimationFrame(id),
      warn: (message) => console.warn(message),
    });
    const observer = new ResizeObserver(() => watcher.schedule());
    observer.observe(el);
    for (const p of el.querySelectorAll("[data-panel]")) observer.observe(p);
    const onResize = () => watcher.schedule();
    window.addEventListener("resize", onResize);
    watcher.schedule();
    return () => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
      watcher.stop();
    };
  }, [rightPanelOpen]);

  return (
    <div ref={root} className="pointer-events-none absolute inset-0">
      <GlassPanel
        data-panel
        data-testid="slot-top-bar"
        rounded={false}
        className="absolute inset-x-0 top-0 z-10 flex h-14 items-center border-x-0 border-t-0 px-4"
      >
        <span data-testid="wordmark" className="text-body-strong font-semibold text-text">
          Synapse Horizon
        </span>
      </GlassPanel>
      {stage}
      <div data-panel className="absolute top-[72px] left-4 flex gap-3">
        {KPI_TITLES.map((t) => (
          <Slot
            key={t}
            grouped
            name={t.toLowerCase().replaceAll(" ", "-")}
            className="relative h-[120px] w-[168px] p-3"
          >
            <h2 className={title}>{t}</h2>
          </Slot>
        ))}
      </div>
      {rightPanelOpen && (
        <Slot name="right-panel" className="absolute top-[72px] right-4 bottom-16 w-[360px] p-3">
          <h2 className={title}>Details</h2>
        </Slot>
      )}
      <Slot name="job-tracker" className="absolute bottom-16 left-4 h-[112px] w-[536px] p-3">
        <h2 className={title}>Job tracker</h2>
      </Slot>
      <GlassPanel
        data-panel
        data-testid="slot-tab-strip"
        rounded={false}
        className="absolute inset-x-0 bottom-0 flex h-12 items-center gap-6 border-x-0 border-b-0 px-4"
      >
        {TABS.map((t) => (
          <span key={t} data-testid="tab-label" className="text-label text-text-2">
            {t}
          </span>
        ))}
      </GlassPanel>
    </div>
  );
}
