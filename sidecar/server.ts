import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { templateIndex, type LogServer } from "./logServer.ts";

export interface Asset {
  bytes: Uint8Array;
  contentType: string;
}

/** Served files, keyed by URL path (for example "/index.html"). Built once at startup. */
export type AssetMap = Map<string, Asset>;

export interface ServerOptions {
  /** Port the server is expected to bind; the port actually bound wins once listening. */
  port: number;
  assets: AssetMap;
  log: (line: string) => void;
  /** When set, serves /api/session, /api/import and the /api/stream WebSocket, and templates index.html. */
  logServer?: LogServer;
}

export type HostVerdict = "serve" | "redirect" | "reject";

/** Host gate (CEO C6): only 127.0.0.1:<bound port> is served; localhost:<port> is redirected. */
export function checkHost(hostHeader: string | undefined, boundPort: number): HostVerdict {
  // Browsers drop the port from Host when it is the scheme default.
  if (hostHeader === `127.0.0.1:${boundPort}` || (boundPort === 80 && hostHeader === "127.0.0.1")) {
    return "serve";
  }
  if (hostHeader === `localhost:${boundPort}` || (boundPort === 80 && hostHeader === "localhost")) {
    return "redirect";
  }
  return "reject";
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function send(
  res: ServerResponse,
  method: string | undefined,
  status: number,
  contentType: string,
  body: Uint8Array | string,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": typeof body === "string" ? Buffer.byteLength(body) : body.byteLength,
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(method === "HEAD" ? undefined : body);
}

function sendText(res: ServerResponse, method: string | undefined, status: number, text: string) {
  send(res, method, status, "text/plain; charset=utf-8", text);
}

export function createServer({ port, assets, log, logServer }: ServerOptions): Server {
  function boundPort(server: Server): number {
    const address = server.address();
    return address !== null && typeof address === "object" ? (address as AddressInfo).port : port;
  }

  function handle(server: Server, req: IncomingMessage, res: ServerResponse): void {
    const { method, url = "" } = req;
    const host = req.headers.host;
    const verdict = checkHost(host, boundPort(server));
    if (verdict === "reject") {
      log(`421 ${method} ${url} Host: ${host ?? "(none)"}`);
      sendText(res, method, 421, `Misdirected Request: use http://127.0.0.1:${boundPort(server)}/`);
      return;
    }
    if (!url.startsWith("/")) {
      sendText(res, method, 400, "Bad Request");
      return;
    }
    if (verdict === "redirect") {
      res.writeHead(308, { Location: `http://127.0.0.1:${boundPort(server)}${url}` });
      res.end();
      return;
    }
    if (logServer?.handleRequest(req, res, boundPort(server))) return;
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendText(res, method, 405, "Method Not Allowed");
      return;
    }

    const queryAt = url.indexOf("?");
    const rawPath = queryAt === -1 ? url : url.slice(0, queryAt);
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      sendText(res, method, 400, "Bad Request");
      return;
    }
    // The path is only ever a map key, never a disk path; dot segments are still refused outright.
    if (path.split(/[/\\]/).includes("..") || path.includes("\0")) {
      sendText(res, method, 404, "Not Found");
      return;
    }

    // Every response that serves index.html carries the current token and is never cached.
    const sendIndex = (index: Asset) => {
      if (!logServer) return send(res, method, 200, index.contentType, index.bytes);
      const html = templateIndex(Buffer.from(index.bytes).toString("utf8"), {
        token: logServer.token,
        mode: "binary",
      });
      send(res, method, 200, index.contentType, html, { "Cache-Control": "no-store" });
    };

    const key = path === "/" ? "/index.html" : path;
    const asset = assets.get(key);
    if (asset) {
      if (key === "/index.html") sendIndex(asset);
      else send(res, method, 200, asset.contentType, asset.bytes);
      return;
    }
    if (path.startsWith("/assets/")) {
      sendText(res, method, 404, "Not Found");
      return;
    }
    const index = assets.get("/index.html");
    if (index) {
      sendIndex(index);
      return;
    }
    sendText(res, method, 404, "Not Found");
  }

  const server: Server = createHttpServer((req, res) => {
    try {
      handle(server, req, res);
    } catch (error) {
      log(
        `500 ${req.method} ${req.url} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
      if (!res.headersSent) sendText(res, req.method, 500, "Internal Server Error");
      else res.destroy();
    }
  });
  if (logServer) {
    server.on("upgrade", (req, socket, head) => {
      if (!logServer.handleUpgrade(req, socket, head, boundPort(server))) socket.destroy();
    });
  }
  return server;
}
