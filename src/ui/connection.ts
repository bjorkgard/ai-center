import { SESSION_EXPIRED } from "../data/liveSource.ts";
import type { RootInfoMessage, RootSource } from "../data/wire.ts";
import type { SourceInfo, SourceState } from "../app/store/data.ts";

// What the connection pill, the D11 banner and the D9 card show (PLAN chunk 14c). Pure, so each
// state is a table row in a test.
export const RECONNECT_BANNER_MS = 3000;

type Progress = { done: number; total: number } | null;

export interface PillView {
  text: string;
  /** The first root problem, shown beside the text (G5). */
  reason?: string;
  title?: string;
}

const TEXT: Record<SourceState, string> = {
  idle: "Off",
  connecting: "Connecting",
  catching_up: "Catching up",
  live: "Connected",
  reconnecting: "Reconnecting",
  closed: "Off",
  error: "Off",
};

/** Null when the source is not the log server: the pill is its status. */
export function pillView(
  source: SourceInfo,
  progress: Progress,
  roots: RootInfoMessage[] | null,
): PillView | null {
  if (source.name !== "live" || source.status === "idle") return null;
  const { status } = source;
  if (status === "error") return { text: "Off", title: source.detail };
  if (status === "catching_up") {
    return { text: `Catching up ${progress?.done ?? 0}/${progress?.total ?? 0} files` };
  }
  // The server watching nothing (--no-logs) is "Off", whatever the socket says.
  if (status === "live" && roots?.length === 0) return { text: "Off" };
  const reason = roots?.find((root) => root.reason !== undefined)?.reason;
  return reason === undefined
    ? { text: TEXT[status] }
    : { text: TEXT[status], reason, title: reason };
}

const BANNER: Record<string, string> = {
  dev: "Log server not running. Start it with vp dev.",
  binary: "Synapse Horizon stopped. Run it again to reconnect.",
  preview: "Log server not running. Start it with vp run serve.",
};

export function bannerText(mode: string | null, status: SourceState): string {
  if (status === "error") return SESSION_EXPIRED;
  return BANNER[mode ?? ""] ?? BANNER.dev;
}

/** `waitedMs` is how long the status has been reconnecting. */
export function bannerShown(status: SourceState, everLive: boolean, waitedMs: number): boolean {
  if (status === "error") return true;
  if (status !== "reconnecting") return false;
  return !everLive || waitedMs >= RECONNECT_BANNER_MS;
}

/** The D9 card: backfill done and no file in any root. No roots at all is "Off", not first run. */
export function firstRun(
  source: SourceInfo,
  progress: Progress,
  roots: RootInfoMessage[] | null,
): boolean {
  if (source.name !== "live" || source.status !== "live") return false;
  if (progress !== null && progress.done < progress.total) return false;
  return roots !== null && roots.length > 0 && roots.every((root) => root.files === 0);
}

const SOURCE_LABEL: Record<RootSource, string> = {
  flag: "--log-root",
  env: "SYNAPSE_LOG_ROOTS",
  config: "config file",
  default: "default",
};

export const rootLabel = (root: RootInfoMessage): string =>
  `${root.path} (${SOURCE_LABEL[root.source]})`;

/** The search string of "Try the demo": this page's parameters with the steady mock selected. */
export function demoUrl(search: string): string {
  const q = new URLSearchParams(search);
  q.set("source", "mock");
  q.set("scenario", "steady");
  return `?${q.toString()}`;
}
