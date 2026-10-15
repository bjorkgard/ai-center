import { useEffect, useState } from "react";
import { useStore } from "../app/store/index.ts";
import { pageMeta } from "../data/liveSource.ts";
import { RECONNECT_BANNER_MS, bannerShown, bannerText } from "./connection.ts";

// "vp dev" and "vp run serve" are commands: set them in code type.
function withCode(text: string) {
  const at = text.search(/vp (?:run serve|dev)/);
  if (at === -1) return text;
  const command = text.slice(at).replace(/\.$/, "");
  return (
    <>
      {text.slice(0, at)}
      <code className="font-mono">{command}</code>.
    </>
  );
}

// The D11 banner: amber, directly under the top bar. Shown when the first connection fails or
// the socket has been reconnecting for 3 s, hidden once live again; a rejected session keeps it.
export function ConnectionBanner() {
  const live = useStore((s) => s.source.name === "live");
  const status = useStore((s) => s.source.status);
  const seen = useStore((s) => s.logSeen);
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (status !== "reconnecting") return;
    const id = setTimeout(() => setElapsed(true), RECONNECT_BANNER_MS);
    return () => {
      clearTimeout(id);
      setElapsed(false);
    };
  }, [status]);

  if (!live || !bannerShown(status, seen, elapsed ? RECONNECT_BANNER_MS : 0)) return null;
  return (
    <div
      role="status"
      data-testid="connection-banner"
      className="pointer-events-auto absolute inset-x-0 top-14 z-10 flex items-center justify-center gap-4 border-b border-status-waiting-user/40 bg-bg px-4 py-2 text-label text-status-waiting-user"
    >
      <span>{withCode(bannerText(pageMeta("synapse-mode"), status))}</span>
      {status === "error" && (
        <button
          type="button"
          className="h-7 rounded-control border border-status-waiting-user px-3 text-label hover:bg-status-waiting-user/10"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      )}
    </div>
  );
}
