import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  parseClientMessage,
  STREAM_PATH,
  type Cursor,
  type RootInfoMessage,
  type ServerMessage,
} from "../src/data/wire.ts";
import type { Resolution } from "./roots.ts";
import { FileTail } from "./tail.ts";
import { createWatcher, type WatchOptions, type Watcher } from "./watch.ts";

export type Mode = "dev" | "preview" | "binary";

export const HELLO_TIMEOUT_MS = 2000;
export const HEARTBEAT_MS = 10_000;
export const MAX_PAYLOAD = 1024 * 1024;
export const BUFFER_LIMIT = 1024 * 1024;
export const MAX_PENDING_SOCKETS = 16;
const BACKFILL_CONCURRENCY = 4;
const DRAIN_CHECK_MS = 50;
const README = "README #configuration";

/** The only Host the gates accept: Vite's own `localhost` under dev, `127.0.0.1` elsewhere (C73). */
export function allowedHost(mode: Mode, port: number): string {
  return `${mode === "dev" ? "localhost" : "127.0.0.1"}:${port}`;
}

export interface GateFailure {
  status: 421 | 403;
  body: string;
}

/** Host (421) then Origin (403). An absent Origin passes: non-browser local clients still need the token. */
export function checkGate(
  mode: Mode,
  port: number,
  headers: { host?: string | undefined; origin?: string | undefined },
): GateFailure | undefined {
  const host = allowedHost(mode, port);
  // Browsers drop the port from Host and Origin when it is the scheme default (as `checkHost` does).
  const hosts = port === 80 ? [host, host.replace(/:80$/, "")] : [host];
  if (headers.host === undefined || !hosts.includes(headers.host)) {
    return { status: 421, body: `Misdirected Request: use http://${host}/` };
  }
  if (headers.origin !== undefined && !hosts.some((h) => headers.origin === `http://${h}`)) {
    return { status: 403, body: `Forbidden: this server only accepts the origin http://${host}` };
  }
  return undefined;
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Injects the per-run token and the server mode into index.html; any earlier pair is replaced. */
export function templateIndex(
  html: string,
  { token, mode }: { token: string; mode: Mode },
): string {
  const metas =
    `<meta name="synapse-token" content="${escapeAttr(token)}" />\n    ` +
    `<meta name="synapse-mode" content="${escapeAttr(mode)}" />\n  `;
  const clean = html.replace(/<meta name="synapse-(?:token|mode)"[^>]*>\s*/g, "");
  const head = /<\/head>/i.exec(clean);
  if (head === null) return metas + clean;
  return clean.slice(0, head.index) + metas + clean.slice(head.index);
}

export interface SocketLike {
  readonly bufferedAmount: number;
  send(data: string): void;
}

/**
 * One client's outgoing messages. Above `limit` bytes buffered it stops sending and keeps only
 * the latest `lines` total per file (and the latest progress), so memory stays bounded by the
 * file count; the coalesced set goes out once the buffer drains.
 */
export class Channel {
  readonly #socket: SocketLike;
  readonly #limit: number;
  readonly #pending = new Map<string, ServerMessage>();

  constructor(socket: SocketLike, limit: number) {
    this.#socket = socket;
    this.#limit = limit;
  }

  get pendingSize(): number {
    return this.#pending.size;
  }

  send(message: ServerMessage): void {
    this.drain();
    if (this.#pending.size === 0 && this.#socket.bufferedAmount <= this.#limit) {
      this.#socket.send(JSON.stringify(message));
      return;
    }
    // A heartbeat that cannot be delivered is simply dropped.
    if (message.type === "lines") this.#pending.set(`lines:${message.path}`, message);
    else if (message.type === "progress") this.#pending.set("progress", message);
    else if (message.type === "roots") this.#pending.set("roots", message);
  }

  drain(): void {
    if (this.#pending.size === 0 || this.#socket.bufferedAmount > this.#limit) return;
    const messages = [...this.#pending.values()];
    this.#pending.clear();
    for (const message of messages) this.#socket.send(JSON.stringify(message));
  }
}

/** Client cursors are matched against the server's own known files; unknown paths are dropped. */
export function matchCursors(cursors: Cursor[], known: { has(path: string): boolean }): Cursor[] {
  return cursors.filter((cursor) => known.has(cursor.path));
}

/**
 * The token of a first message that is a JSON object of type "hello": its string value, or null
 * when it is missing or not a string. undefined when the message is not a hello at all.
 */
function helloToken(text: string | undefined): string | null | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as { type?: unknown; token?: unknown } | null;
    if (typeof value !== "object" || value === null || value.type !== "hello") return undefined;
    return typeof value.token === "string" ? value.token : null;
  } catch {
    return undefined;
  }
}

export interface LogServerOptions {
  mode: Mode;
  resolution: Resolution;
  log: (line: string) => void;
  token?: string;
  watch?: Pick<WatchOptions, "events" | "rescanMs" | "watch" | "now">;
  heartbeatMs?: number;
  helloTimeoutMs?: number;
  maxPendingSockets?: number;
  bufferLimit?: number;
  /** Called with the size of every file read (a test hook for the 64 KiB bound). */
  onRead?: (path: string, bytes: number) => void;
}

export interface LogServer {
  readonly token: string;
  /** Lists the roots and starts watching; backfill continues in the background. */
  start(): Promise<RootInfoMessage[]>;
  stop(): Promise<void>;
  /** Resolves when the 24 h backfill has finished. */
  backfilled(): Promise<void>;
  rootsMessage(): RootInfoMessage[];
  /** Handles /api/session, /api/import and a plain GET of /api/stream; false for any other path. */
  handleRequest(req: IncomingMessage, res: ServerResponse, port: number): boolean;
  /** Handles an upgrade for /api/stream only; false (socket untouched) for any other path. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number): boolean;
}

function pathnameOf(url: string | undefined): string | undefined {
  if (url === undefined || !url.startsWith("/")) return undefined;
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function reply(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  // A CORS middleware may already have run; none of these endpoints may answer a foreign page.
  for (const name of res.getHeaderNames()) {
    if (name.startsWith("access-control-")) res.removeHeader(name);
  }
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

const REASONS: Record<number, string> = { 421: "Misdirected Request", 403: "Forbidden" };

export function createLogServer(options: LogServerOptions): LogServer {
  const { mode, resolution, log } = options;
  const token = options.token ?? randomBytes(24).toString("base64url");
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const maxPendingSockets = options.maxPendingSockets ?? MAX_PENDING_SOCKETS;
  const bufferLimit = options.bufferLimit ?? BUFFER_LIMIT;

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const tails = new Map<string, FileTail>();
  const channels = new Set<Channel>();
  const pendingSockets = new Set<WebSocket>();
  const sockets = new Set<WebSocket>();
  const warned = new Set<string>();
  const progress = { done: 0, total: 0 };
  let watcher: Watcher | undefined;
  let backfill: Promise<void> = Promise.resolve();
  let stopped = false;

  const broadcast = (message: ServerMessage) => {
    for (const channel of channels) channel.send(message);
  };

  function tailFor(path: string): FileTail {
    let tail = tails.get(path);
    if (tail === undefined) {
      tail = new FileTail(path, { onRead: (bytes) => options.onRead?.(path, bytes) });
      tails.set(path, tail);
    }
    return tail;
  }

  async function sync(path: string): Promise<void> {
    if (stopped) return;
    try {
      const result = await tailFor(path).poll();
      if (result.kind === "ok" && result.changed) {
        broadcast({ type: "lines", path, fileId: result.fileId, total: result.total });
      }
    } catch (error) {
      const code = (error as { code?: string }).code ?? "unknown";
      if (warned.has(path)) return;
      warned.add(path);
      log(
        code === "EACCES"
          ? `[logs] permission denied (EACCES) reading ${path}; skipped. Check the file's owner (see ${README})`
          : `[logs] cannot read ${path}: ${code}; skipped (see ${README})`,
      );
    }
  }

  async function runBackfill(files: string[]): Promise<void> {
    progress.done = 0;
    progress.total = files.length;
    for (const path of files) tailFor(path);
    let next = 0;
    const worker = async () => {
      while (next < files.length && !stopped) {
        const path = files[next++];
        await sync(path);
        progress.done++;
        broadcast({ type: "progress", ...progress });
      }
    };
    await Promise.all(Array.from({ length: BACKFILL_CONCURRENCY }, worker));
  }

  function rootsMessage(): RootInfoMessage[] {
    if (resolution.kind === "error") {
      return [
        {
          path: resolution.configPath,
          files: 0,
          reason: `${resolution.message}; fix or remove the file (see ${README})`,
          source: "config",
          configError: true,
        },
      ];
    }
    if (resolution.kind === "none" || watcher === undefined) return [];
    const sources = resolution.roots;
    return watcher.roots().map((info, i) => ({
      path: info.path,
      files: info.files,
      source: sources[i].source,
      ...(info.reason === undefined ? {} : { reason: info.reason }),
    }));
  }

  function greet(channel: Channel, matched: Cursor[]): void {
    channel.send({ type: "heartbeat" });
    channel.send({ type: "roots", roots: rootsMessage() });
    channel.send({ type: "progress", ...progress });
    const first = new Set(matched.map((cursor) => cursor.path));
    const ordered = [...tails.values()].sort(
      (a, b) => Number(first.has(b.path)) - Number(first.has(a.path)),
    );
    for (const tail of ordered) {
      if (tail.fileId !== "") {
        channel.send({ type: "lines", path: tail.path, fileId: tail.fileId, total: tail.lines });
      }
    }
  }

  function onConnection(ws: WebSocket): void {
    sockets.add(ws);
    ws.on("error", () => {});
    if (pendingSockets.size >= maxPendingSockets) {
      ws.close(1013, "too many pending connections");
      ws.on("close", () => sockets.delete(ws));
      return;
    }
    pendingSockets.add(ws);
    let channel: Channel | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let drain: ReturnType<typeof setInterval> | undefined;
    const helloTimer = setTimeout(() => ws.close(4401, "no hello"), helloTimeoutMs);

    ws.on("message", (data, isBinary) => {
      if (channel !== undefined || !pendingSockets.has(ws)) return;
      clearTimeout(helloTimer);
      pendingSockets.delete(ws);
      const text = isBinary ? undefined : Buffer.from(data as Buffer).toString("utf8");
      // One decision path: not a hello is 4400; a hello whose token is not ours is 4401, before
      // anything else about it is validated; then a malformed rest is 4400.
      const sent = helloToken(text);
      if (sent === undefined) return ws.close(4400, "the first message must be a hello");
      if (sent !== token) return ws.close(4401, "bad token");
      const hello = parseClientMessage(text!);
      if (hello === undefined) return ws.close(4400, "malformed hello");
      if (hello.cursors.length > tails.size) return ws.close(4400, "too many cursors");
      const accepted = new Channel(ws, bufferLimit);
      channel = accepted;
      channels.add(accepted);
      // Totals are always absolute, so cursors only decide which known files are sent first;
      // a client path is never opened.
      greet(accepted, matchCursors(hello.cursors, tails));
      heartbeat = setInterval(() => accepted.send({ type: "heartbeat" }), heartbeatMs);
      drain = setInterval(() => accepted.drain(), DRAIN_CHECK_MS);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      clearInterval(heartbeat);
      clearInterval(drain);
      pendingSockets.delete(ws);
      sockets.delete(ws);
      if (channel !== undefined) channels.delete(channel);
    });
  }
  wss.on("connection", onConnection);

  return {
    token,

    async start() {
      if (resolution.kind === "roots") {
        watcher = createWatcher({
          ...options.watch,
          roots: resolution.roots.map((root) => root.path),
          onFile: (path) => void sync(path),
          log,
          onRoots: () => broadcast({ type: "roots", roots: rootsMessage() }),
        });
        await watcher.start();
        backfill = runBackfill(watcher.files());
      }
      return rootsMessage();
    },

    async stop() {
      stopped = true;
      watcher?.stop();
      for (const ws of sockets) ws.close(1001, "server stopping");
      const deadline = Date.now() + 500;
      while (sockets.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      for (const ws of sockets) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },

    backfilled: () => backfill,
    rootsMessage,

    handleRequest(req, res, port) {
      const pathname = pathnameOf(req.url);
      if (pathname !== "/api/session" && pathname !== "/api/import" && pathname !== STREAM_PATH) {
        return false;
      }
      const failure = checkGate(mode, port, { host: req.headers.host, origin: req.headers.origin });
      if (failure !== undefined) {
        log(`${failure.status} ${req.method} ${req.url} Host: ${req.headers.host ?? "(none)"}`);
        reply(res, failure.status, failure.body);
        return true;
      }
      if (pathname === STREAM_PATH) {
        reply(res, 426, "Upgrade Required: connect with a WebSocket", { Upgrade: "websocket" });
      } else if (pathname === "/api/session") {
        const site = req.headers["sec-fetch-site"];
        if (req.method !== "GET") reply(res, 405, "Method Not Allowed", { Allow: "GET" });
        else if (site !== undefined && site !== "same-origin") reply(res, 403, "Forbidden");
        else {
          reply(res, 200, JSON.stringify({ token }), {
            "Content-Type": "application/json; charset=utf-8",
          });
        }
      } else if (req.method !== "POST") {
        reply(res, 405, "Method Not Allowed", { Allow: "POST" });
      } else if (req.headers["x-synapse-token"] !== token) {
        reply(res, 401, "Unauthorized: send the session token in X-Synapse-Token");
      } else {
        reply(res, 501, "Not Implemented: import arrives in chunk 17");
      }
      return true;
    },

    handleUpgrade(req, socket, head, port) {
      if (pathnameOf(req.url) !== STREAM_PATH) return false;
      const failure = checkGate(mode, port, { host: req.headers.host, origin: req.headers.origin });
      if (failure !== undefined) {
        log(`${failure.status} UPGRADE ${req.url} Host: ${req.headers.host ?? "(none)"}`);
        socket.end(
          `HTTP/1.1 ${failure.status} ${REASONS[failure.status]}\r\n` +
            `Content-Type: text/plain; charset=utf-8\r\n` +
            `Content-Length: ${Buffer.byteLength(failure.body)}\r\n` +
            `Connection: close\r\n\r\n${failure.body}`,
        );
        return true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return true;
    },
  };
}

/** The `[logs]` lines printed at startup: one per root, plus the zero-files hint. */
export function startupLines(resolution: Resolution, roots: RootInfoMessage[]): string[] {
  if (resolution.kind === "none") return [`[logs] watching nothing (${resolution.reason})`];
  if (resolution.kind === "error") return roots.map((root) => `[logs] ${root.reason}`);
  const lines = roots.map((root) =>
    root.reason !== undefined
      ? `[logs] ${root.reason}`
      : `[logs] ${root.path}: ${root.files} ${root.files === 1 ? "file" : "files"} modified in the last 24 h (${root.source})`,
  );
  if (roots.every((root) => root.files === 0)) {
    lines.push(
      "[logs] no Claude Code or Codex logs found in the last 24 h; start a session, or pass --log-root <dir>",
    );
  }
  return lines;
}
