import type { LogMessage, Source, SourceStatus } from "./schema.ts";
import { parseServerMessage, STREAM_PATH, type Cursor, type ServerMessage } from "./wire.ts";

// The live source (PLAN chunk 14c): the log server's WebSocket behind the Source interface.
// A dropped socket or a down server is retried in here, so the store never reconnects and
// sourceEpoch never moves.
export const SESSION_EXPIRED = "Session expired. Reload the page.";
export const WIRE_MISMATCH = "the log server sent a message this page does not understand";
export const BACKOFF_MS = [1000, 2000, 4000, 10_000] as const;
const TOKEN_REJECTED = 4401;

/** The part of WebSocket the source uses; tests pass a fake. */
export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** /api/session answered 401 or 403: the server will not hand this page a token. */
export class SessionRejected extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`session request answered ${status}`);
    this.status = status;
  }
}

export interface LiveOptions {
  url?: string;
  /** The page's token (the `synapse-token` meta tag); null when the page has none. */
  token?: () => string | null;
  createSocket?: (url: string) => SocketLike;
  fetchSession?: () => Promise<string>;
  /** Runs `fn` after `ms`; returns a cancel function. */
  schedule?: (fn: () => void, ms: number) => () => void;
}

// This folder compiles without the DOM lib, so the page is reached through globalThis.
interface Page {
  document?: {
    querySelector(selector: string): { getAttribute(name: string): string | null } | null;
  };
  location?: { protocol: string; host: string };
}
const page = (): Page => globalThis as Page;

export function pageMeta(name: string): string | null {
  return page().document?.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
}

async function fetchSessionToken(): Promise<string> {
  const response = await fetch("/api/session", { cache: "no-store" });
  if (response.status === 401 || response.status === 403) {
    throw new SessionRejected(response.status);
  }
  if (!response.ok) throw new Error(`session request answered ${response.status}`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string") throw new Error("session answer has no token");
  return body.token;
}

const defaultUrl = () => {
  const { protocol = "http:", host = "" } = page().location ?? {};
  return `${protocol === "https:" ? "wss" : "ws"}://${host}${STREAM_PATH}`;
};

// The server sends an unusable config file as a root flagged `configError` (G5).
const configError = (message: Extract<ServerMessage, { type: "roots" }>): string | undefined => {
  const root = message.roots.find((entry) => entry.configError === true);
  return root === undefined ? undefined : `${root.reason ?? "invalid config file"} (${root.path})`;
};

export function createLiveSource(options: LiveOptions = {}): Source {
  const url = options.url ?? defaultUrl();
  const createSocket =
    options.createSocket ?? ((target: string) => new WebSocket(target) as unknown as SocketLike);
  const fetchSession = options.fetchSession ?? fetchSessionToken;
  const schedule =
    options.schedule ??
    ((fn, ms) => {
      const id = setTimeout(fn, ms);
      return () => clearTimeout(id);
    });

  let logCb: (message: LogMessage) => void = () => {};
  let statusCb: (status: SourceStatus, detail?: string) => void = () => {};
  let token = (options.token ?? (() => pageMeta("synapse-token")))();
  let socket: SocketLike | null = null;
  let cancelRetry: (() => void) | null = null;
  let stopped = false;
  let failed = false;
  // Failed attempts since a connection last worked, and whether this rejection already got its
  // one fresh token.
  let attempt = 0;
  let refreshed = false;
  const cursors = new Map<string, Cursor>();

  const status = (next: SourceStatus, detail?: string) => {
    if (!stopped && !failed) statusCb(next, detail);
  };
  const fail = (detail: string) => {
    status("error", detail);
    failed = true;
    const old = socket;
    socket = null;
    old?.close();
  };

  const retry = () => {
    if (stopped || failed) return;
    status("reconnecting");
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    cancelRetry = schedule(() => {
      cancelRetry = null;
      connect();
    }, delay);
  };

  // One fresh token, then straight back to the socket; the caller counted the rejection.
  const renewToken = (announce: boolean) => {
    if (announce) status("reconnecting");
    fetchSession().then(
      (fresh) => {
        if (stopped || failed) return;
        token = fresh;
        connect();
      },
      (error: unknown) => {
        if (error instanceof SessionRejected) return fail(SESSION_EXPIRED);
        refreshed = false;
        retry();
      },
    );
  };

  const onMessage = (message: ServerMessage) => {
    if (message.type === "heartbeat") return;
    if (message.type === "lines") {
      cursors.set(message.path, {
        path: message.path,
        fileId: message.fileId,
        offset: 0,
      });
    }
    if (message.type === "roots") {
      const reason = configError(message);
      if (reason !== undefined) {
        logCb(message);
        return fail(reason);
      }
    }
    logCb(message);
    if (message.type === "progress") status(message.done < message.total ? "catching_up" : "live");
  };

  function connect(): void {
    if (stopped || failed) return;
    if (token === null) {
      renewToken(false);
      return;
    }
    const sent = token;
    const own = createSocket(url);
    socket = own;
    let accepted = false;
    own.onopen = () => {
      if (socket !== own) return;
      own.send(JSON.stringify({ type: "hello", token: sent, cursors: [...cursors.values()] }));
    };
    own.onmessage = (event) => {
      if (socket !== own || stopped || failed) return;
      const message = typeof event.data === "string" ? parseServerMessage(event.data) : undefined;
      if (message === undefined) return fail(WIRE_MISMATCH);
      if (!accepted) {
        accepted = true;
        attempt = 0;
        refreshed = false;
      }
      onMessage(message);
    };
    own.onclose = (event) => {
      if (socket !== own) return;
      socket = null;
      if (event.code !== TOKEN_REJECTED) return retry();
      if (refreshed) return fail(SESSION_EXPIRED);
      refreshed = true;
      renewToken(true);
    };
  }

  return {
    name: "live",
    start() {
      status("connecting");
      connect();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      cancelRetry?.();
      cancelRetry = null;
      const old = socket;
      socket = null;
      old?.close();
    },
    // The log server sends no events yet (they arrive with chunk 15).
    onEvents() {},
    onLog(callback) {
      logCb = callback;
    },
    onStatus(callback) {
      statusCb = callback;
    },
  };
}
