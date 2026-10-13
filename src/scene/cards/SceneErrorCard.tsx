import { useEffect, useRef, useState } from "react";
import { lastSceneLines } from "../sceneLog.ts";
import { copyText } from "./clipboard.ts";
import { Card } from "./Card.tsx";
import { cardStyles, reload } from "./cardStyles.ts";
import { buildErrorDetails } from "./errorDetails.ts";

// The scene stopped after an error (C23, DR14). Panels keep working.
export function SceneErrorCard({ message }: { message: string }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const text = buildErrorDetails({
      message,
      lines: lastSceneLines(),
      version: __APP_VERSION__,
      userAgent: navigator.userAgent,
    });
    const ok = await copyText(text, navigator.clipboard);
    setCopied(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), 2000);
  };

  return (
    <Card
      testId="scene-error-card"
      title="The 3D view stopped after an error."
      body="The panels still work. Reload to restart the 3D view."
      actions={
        <>
          <button type="button" className={cardStyles.outlined} onClick={reload}>
            Reload
          </button>
          <button type="button" className={cardStyles.quiet} onClick={copy}>
            {copied === "copied"
              ? "Copied"
              : copied === "failed"
                ? "Copy failed"
                : "Copy error details"}
          </button>
        </>
      }
    >
      <hr className="my-3 border-0 border-t border-white/12" />
      <div className="flex items-start gap-2">
        {open ? (
          <pre className="m-0 max-h-40 min-w-0 flex-1 overflow-auto font-mono text-caption break-words whitespace-pre-wrap text-text-2">
            {message}
          </pre>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-caption text-text-2">
            {message}
          </span>
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide error details" : "Show error details"}
          className="shrink-0 text-text-2 hover:text-text"
          onClick={() => setOpen(!open)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            aria-hidden="true"
            className={open ? "rotate-180" : undefined}
          >
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
    </Card>
  );
}
