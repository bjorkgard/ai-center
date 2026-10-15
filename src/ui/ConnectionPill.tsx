import { useStore } from "../app/store/index.ts";
import { pillView } from "./connection.ts";

const DOT: Record<string, string> = {
  live: "bg-cyan",
  catching_up: "bg-status-thinking",
  connecting: "bg-status-idle",
  reconnecting: "bg-status-waiting-user",
  closed: "bg-status-idle",
  error: "bg-status-error",
};

// The log server's state at the right end of the top bar (design D10, spec 3.2).
export function ConnectionPill() {
  const source = useStore((s) => s.source);
  const progress = useStore((s) => s.logProgress);
  const roots = useStore((s) => s.logRoots);
  const view = pillView(source, progress, roots);
  if (view === null) return null;
  const off = view.text === "Off";
  return (
    <span
      data-testid="connection-pill"
      data-status={source.status}
      title={view.title}
      className="ml-auto flex h-8 max-w-[60%] items-center gap-2 rounded-control border border-white/12 px-3 text-label text-text-2"
    >
      <span
        aria-hidden="true"
        className={`size-2 shrink-0 rounded-full ${off ? "bg-status-idle" : (DOT[source.status] ?? "bg-status-idle")}`}
      />
      <span className="shrink-0">{view.text}</span>
      {view.reason !== undefined && (
        <span data-testid="pill-reason" className="truncate text-text-2">
          {view.reason}
        </span>
      )}
    </span>
  );
}
