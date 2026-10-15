import { useStore } from "../app/store/index.ts";
import { cardStyles } from "../scene/cards/cardStyles.ts";
import { demoUrl, firstRun, rootLabel } from "./connection.ts";
import { GlassPanel } from "./GlassPanel.tsx";

// The D9 first-run card, centred in the safe area: the log server found nothing in any root.
// It names the roots the server resolved and where each came from. "Drop a .jsonl" is chunk 17.
export function FirstRunCard() {
  const source = useStore((s) => s.source);
  const progress = useStore((s) => s.logProgress);
  const roots = useStore((s) => s.logRoots);
  if (!firstRun(source, progress, roots) || roots === null) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
      <GlassPanel data-testid="first-run-card" className="relative w-[420px] max-w-full p-4">
        <h2 className="m-0 text-title font-semibold text-text">No sessions yet</h2>
        <p className="mt-2 mb-0 text-body text-text-2">
          Watching {roots.length === 1 ? "this folder" : "these folders"}. No sessions in the last
          24 h.
        </p>
        <ul
          data-testid="first-run-roots"
          className="mt-2 mb-0 list-none p-0 text-label text-text-2"
        >
          {roots.map((root) => (
            <li key={root.path} className="break-all">
              {rootLabel(root)}
              {root.reason !== undefined && <span> – {root.reason}</span>}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-center gap-4">
          <button
            type="button"
            className={cardStyles.outlined}
            onClick={() => window.location.assign(demoUrl(window.location.search))}
          >
            Try the demo
          </button>
        </div>
      </GlassPanel>
    </div>
  );
}
