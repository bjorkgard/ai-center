import { watch as fsWatch, type FSWatcher } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export const RESCAN_MS = 5000;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type RootState = "watching" | "polling" | "missing" | "unreadable";

export interface RootInfo {
  path: string;
  state: RootState;
  /** Problem, cause and fix, ending with the README anchor; set unless the root is healthy. */
  reason?: string;
  /** Files modified within the last 24 h. */
  files: number;
}

export interface WatchOptions {
  roots: string[];
  /** A .jsonl file under a root may have changed. Not called for the initial listing. */
  onFile: (path: string) => void;
  log: (line: string) => void;
  /** false disables `fs.watch`: every root is then rescanned only (tests, and the ENOSPC fallback). */
  events?: boolean;
  rescanMs?: number;
  maxAgeMs?: number;
  now?: () => number;
  watch?: typeof fsWatch;
  /** A root changed state (appeared, went missing, fell back to polling). */
  onRoots?: () => void;
}

export interface Watcher {
  start(): Promise<void>;
  stop(): void;
  roots(): RootInfo[];
  /** Known .jsonl files modified within 24 h, newest first. */
  files(): string[];
}

interface Known {
  root: string;
  mtimeMs: number;
  signature: string;
}

interface RootEntry {
  path: string;
  state: RootState;
  reason?: string;
  handle?: FSWatcher;
}

const README = "README #configuration";

const isJsonl = (path: string) => path.endsWith(".jsonl");
const codeOf = (error: unknown) => (error as { code?: string }).code ?? "unknown";

function describeWatchError(root: string, error: unknown): string {
  const code = codeOf(error);
  if (code === "ENOSPC") {
    return `cannot watch ${root}: inotify watch limit reached (ENOSPC); polling every 5 s instead. Raise it with: sudo sysctl fs.inotify.max_user_watches=524288 (see ${README})`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `cannot watch ${root}: ${message} (${code}); polling every 5 s instead (see ${README})`;
}

export function createWatcher(options: WatchOptions): Watcher {
  const { onFile, log } = options;
  const useEvents = options.events ?? true;
  const rescanMs = options.rescanMs ?? RESCAN_MS;
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  const now = options.now ?? Date.now;
  const watchFn = options.watch ?? fsWatch;

  const entries: RootEntry[] = options.roots.map((path) => ({ path, state: "missing" }));
  const known = new Map<string, Known>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let rescanning = false;

  // A file joined or left a running root: its file count changed. A burst becomes one notice.
  let filesNotice = false;
  function filesChanged(): void {
    if (filesNotice || stopped) return;
    filesNotice = true;
    setImmediate(() => {
      filesNotice = false;
      if (!stopped) options.onRoots?.();
    });
  }

  async function scanFile(
    root: string,
    path: string,
    notify: boolean,
    force = false,
  ): Promise<void> {
    let info;
    try {
      info = await stat(path, { bigint: true });
    } catch {
      if (known.delete(path) && notify) filesChanged();
      return;
    }
    if (!info.isFile()) return;
    const mtimeMs = Number(info.mtimeMs);
    const previous = known.get(path);
    if (previous === undefined && now() - mtimeMs > maxAgeMs) return;
    const signature = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`;
    known.set(path, { root, mtimeMs, signature });
    if (notify && previous === undefined) filesChanged();
    if (notify && (force || previous?.signature !== signature)) onFile(path);
  }

  async function listRoot(entry: RootEntry, notify: boolean): Promise<void> {
    let names: string[];
    try {
      names = await readdir(entry.path, { recursive: true });
    } catch (error) {
      markUnreadable(entry, error);
      return;
    }
    await Promise.all(
      names.filter(isJsonl).map((name) => scanFile(entry.path, join(entry.path, name), notify)),
    );
  }

  function markUnreadable(entry: RootEntry, error: unknown): void {
    const before = entry.state;
    markUnreadableState(entry, error);
    if (entry.state !== before) options.onRoots?.();
  }

  function markUnreadableState(entry: RootEntry, error: unknown): void {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      if (entry.state !== "missing") entry.handle?.close();
      entry.handle = undefined;
      entry.state = "missing";
      entry.reason = `root not found: ${entry.path}; set --log-root or SYNAPSE_LOG_ROOTS (see ${README})`;
      return;
    }
    entry.state = "unreadable";
    entry.reason =
      code === "EACCES"
        ? `permission denied (EACCES) reading ${entry.path}; skipped. Check the folder's owner (see ${README})`
        : `cannot read ${entry.path}: ${code}; skipped (see ${README})`;
  }

  function fallBackToPolling(entry: RootEntry, error: unknown): void {
    try {
      entry.handle?.close();
    } catch {
      // already closed
    }
    entry.handle = undefined;
    if (entry.state === "polling") return;
    entry.state = "polling";
    entry.reason = describeWatchError(entry.path, error);
    log(`[logs] ${entry.reason}`);
    options.onRoots?.();
  }

  function startWatching(entry: RootEntry): void {
    if (!useEvents) {
      entry.state = "polling";
      return;
    }
    try {
      const handle = watchFn(entry.path, { recursive: true }, (_event, filename) => {
        if (stopped || filename === null || filename === undefined) return;
        const name = filename.toString();
        if (!isJsonl(name)) return;
        // An event always reports the file, even when its signature is unchanged: the server's
        // serial queue makes a repeated poll harmless.
        void scanFile(entry.path, join(entry.path, name), true, true);
      });
      handle.on("error", (error) => fallBackToPolling(entry, error));
      entry.handle = handle;
      entry.state = "watching";
      entry.reason = undefined;
    } catch (error) {
      fallBackToPolling(entry, error);
    }
  }

  async function probe(entry: RootEntry, notify: boolean): Promise<void> {
    let info;
    try {
      info = await stat(entry.path);
    } catch (error) {
      markUnreadable(entry, error);
      return;
    }
    if (!info.isDirectory()) {
      markUnreadable(entry, Object.assign(new Error("not a directory"), { code: "ENOTDIR" }));
      return;
    }
    const wasUsable = entry.state === "watching" || entry.state === "polling";
    if (!wasUsable) {
      entry.reason = undefined;
      startWatching(entry);
      if (notify) log(`[logs] watching ${entry.path}`);
      await listRoot(entry, notify);
      if (notify) options.onRoots?.();
    }
  }

  async function rescan(): Promise<void> {
    if (rescanning || stopped) return;
    rescanning = true;
    try {
      for (const entry of entries) {
        if (entry.state === "missing" || entry.state === "unreadable") {
          await probe(entry, true);
        } else if (entry.state === "polling") {
          await listRoot(entry, true);
        }
      }
      // Backstop for missed events: stat every known file of a watched root.
      await Promise.all(
        [...known]
          .filter(([, k]) => entries.some((e) => e.path === k.root && e.state === "watching"))
          .map(([path, k]) => scanFile(k.root, path, true)),
      );
    } finally {
      rescanning = false;
    }
  }

  return {
    async start() {
      for (const entry of entries) await probe(entry, false);
      timer = setInterval(() => void rescan(), rescanMs);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearInterval(timer);
      for (const entry of entries) {
        try {
          entry.handle?.close();
        } catch {
          // already closed
        }
        entry.handle = undefined;
      }
    },
    roots() {
      return entries.map((entry) => {
        const files = [...known.values()].filter(
          (k) => k.root === entry.path && now() - k.mtimeMs <= maxAgeMs,
        ).length;
        return { path: entry.path, state: entry.state, reason: entry.reason, files };
      });
    },
    files() {
      return [...known]
        .filter(([, k]) => now() - k.mtimeMs <= maxAgeMs)
        .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
        .map(([path]) => path);
    },
  };
}
