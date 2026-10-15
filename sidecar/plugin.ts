import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Plugin } from "vite-plus";
import {
  checkGate,
  createLogServer,
  startupLines,
  templateIndex,
  type LogServer,
  type LogServerOptions,
  type Mode,
} from "./logServer.ts";
import { resolveRoots } from "./roots.ts";

export interface PluginOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homedir?: string;
  cwd?: string;
  readConfig?: (path: string) => string;
  /** Where `[logs]` lines go; defaults to Vite's logger. */
  log?: (line: string) => void;
  logOptions?: Partial<Pick<LogServerOptions, "watch" | "heartbeatMs" | "helloTimeoutMs">>;
}

/** A navigation to the app: `/`, `/index.html` or an extensionless route, never /api or a file. */
function isPage(req: IncomingMessage): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const url = req.url ?? "";
  const end = url.search(/[?#]/);
  const pathname = end === -1 ? url : url.slice(0, end);
  if (pathname === "/" || pathname === "/index.html") return true;
  return (
    !pathname.startsWith("/api/") &&
    !pathname.startsWith("/@") &&
    !pathname.startsWith("/node_modules/") &&
    !/\.[^/]+$/.test(pathname)
  );
}

type Handle = (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void;

/**
 * Registers `handle` ahead of every middleware Vite installed. Vite's own CORS and host checks
 * would otherwise answer first: its 403 for a foreign Host instead of our 421, and CORS headers
 * on the token endpoint.
 */
function prependMiddleware(
  app: { use(handle: Handle): unknown; stack: unknown[] },
  handle: Handle,
): void {
  app.use(handle);
  app.stack.unshift(app.stack.pop());
}

/**
 * The log server as a Vite plugin: the same middleware under `vp dev` and `vp preview`
 * (CEO C70). HTTP upgrades are taken only for /api/stream, so Vite's HMR socket is never touched.
 */
export function synapseLogServer(options: PluginOptions = {}): Plugin {
  let devToken: string | undefined;

  function create(mode: Mode, info: (line: string) => void): LogServer {
    const resolution = resolveRoots({
      flags: [],
      noLogs: false,
      env: options.env ?? process.env,
      platform: options.platform ?? process.platform,
      homedir: options.homedir ?? homedir(),
      cwd: options.cwd ?? process.cwd(),
      readConfig: options.readConfig ?? ((path) => readFileSync(path, "utf8")),
    });
    const log = options.log ?? info;
    const logServer = createLogServer({ mode, resolution, log, ...options.logOptions });
    void logServer.start().then((roots) => {
      for (const line of startupLines(resolution, roots)) log(line);
    });
    return logServer;
  }

  function attach(
    server: { httpServer: unknown },
    logServer: LogServer,
    fallbackPort: number,
  ): () => number {
    const http = server.httpServer as Server | null;
    const port = () => (http?.address() as AddressInfo | null)?.port ?? fallbackPort;
    http?.on("upgrade", (req, socket, head) => {
      logServer.handleUpgrade(req, socket, head, port());
    });
    http?.on("close", () => void logServer.stop());
    return port;
  }

  return {
    name: "synapse-log-server",

    configureServer(server) {
      const logServer = create("dev", (line) => server.config.logger.info(line));
      devToken = logServer.token;
      const port = attach(server, logServer, server.config.server.port);
      prependMiddleware(server.middlewares, (req, res, next) => {
        if (req.headers.host === `127.0.0.1:${port()}`) {
          res.writeHead(308, { Location: `http://localhost:${port()}${req.url ?? "/"}` });
          res.end();
          return;
        }
        if (isPage(req)) {
          // Vite sends `no-cache` for the page; the token must never be served from a cache.
          const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
          res.writeHead = ((status: number, ...rest: unknown[]) => {
            res.setHeader("Cache-Control", "no-store");
            return writeHead(status, ...rest);
          }) as typeof res.writeHead;
        }
        if (logServer.handleRequest(req, res, port())) return;
        next();
      });
    },

    configurePreviewServer(server) {
      const logServer = create("preview", (line) => server.config.logger.info(line));
      const port = attach(server, logServer, server.config.preview.port);
      const outDir = resolve(server.config.root, server.config.build.outDir);
      prependMiddleware(server.middlewares, (req, res, next) => {
        void (async () => {
          try {
            if (logServer.handleRequest(req, res, port())) return;
            if (!isPage(req)) return next();
            const failure = checkGate("preview", port(), { host: req.headers.host });
            let html: string;
            try {
              html = await readFile(resolve(outDir, "index.html"), "utf8");
            } catch {
              return next();
            }
            const body = failure
              ? failure.body
              : templateIndex(html, { token: logServer.token, mode: "preview" });
            res.writeHead(failure?.status ?? 200, {
              ...server.config.preview.headers,
              "Content-Type": failure ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
              "Content-Length": Buffer.byteLength(body),
              "Cache-Control": "no-store",
            });
            res.end(req.method === "HEAD" ? undefined : body);
          } catch (error) {
            next(error);
          }
        })();
      });
    },

    transformIndexHtml(html, ctx) {
      // Only the dev server has a token; a production build must never bake one in.
      if (ctx.server === undefined || devToken === undefined) return html;
      return templateIndex(html, { token: devToken, mode: "dev" });
    },
  };
}
