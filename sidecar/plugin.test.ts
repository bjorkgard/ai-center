import { request } from "node:http";
import type { AddressInfo } from "node:net";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocketClient from "ws";
import { build, createServer, preview } from "vite-plus";
import { afterAll, afterEach, describe, expect, test } from "vite-plus/test";
import type { ServerMessage } from "../src/data/wire.ts";
import { synapseLogServer, type PluginOptions } from "./plugin.ts";

const base = mkdtempSync(join(tmpdir(), "sh-plugin-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const freshDir = () => {
  const dir = join(base, `d${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const HTML = `<!doctype html><html><head><title>t</title></head><body><script type="module" src="/main.js"></script></body></html>`;

function project(): string {
  const dir = freshDir();
  writeFileSync(join(dir, "index.html"), HTML);
  writeFileSync(join(dir, "main.js"), "console.log(1);\n");
  mkdirSync(join(dir, "dist"));
  writeFileSync(join(dir, "dist", "index.html"), HTML);
  return dir;
}

interface Target {
  kind: "dev" | "preview";
  port: number;
  /** Where a browser would open the app; also the Host header the gates accept. */
  host: string;
  root: string;
  logsRoot: string;
  close(): Promise<void>;
}
const targets: Target[] = [];
afterEach(async () => {
  while (targets.length > 0) await targets.pop()!.close();
});

function pluginOptions(logsRoot: string): PluginOptions {
  return {
    env: { SYNAPSE_LOG_ROOTS: logsRoot },
    platform: process.platform,
    homedir: join(base, "home"),
    cwd: base,
    log: () => {},
  };
}

async function start(kind: "dev" | "preview"): Promise<Target> {
  const root = project();
  const logsRoot = freshDir();
  writeFileSync(join(logsRoot, "a.jsonl"), "1\n2\n");
  const plugins = [synapseLogServer(pluginOptions(logsRoot))];
  if (kind === "dev") {
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { host: "localhost", port: 0, hmr: true },
      plugins,
    });
    await server.listen();
    const port = (server.httpServer!.address() as AddressInfo).port;
    const target: Target = {
      kind,
      port,
      host: `localhost:${port}`,
      root,
      logsRoot,
      close: () => server.close(),
    };
    targets.push(target);
    return target;
  }
  const server = await preview({
    root,
    configFile: false,
    logLevel: "silent",
    preview: {
      host: "127.0.0.1",
      port: 0,
      headers: { "Cross-Origin-Opener-Policy": "same-origin" },
    },
    plugins,
  });
  const port = (server.httpServer.address() as AddressInfo).port;
  const target: Target = {
    kind,
    port,
    host: `127.0.0.1:${port}`,
    root,
    logsRoot,
    close: () => new Promise<void>((resolve) => server.httpServer.close(() => resolve())),
  };
  targets.push(target);
  return target;
}

function get(
  t: Target,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: t.kind === "dev" ? "localhost" : "127.0.0.1",
        port: t.port,
        path,
        method,
        headers: { Host: t.host, ...headers },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const tokenOf = async (t: Target) =>
  (JSON.parse((await get(t, "/api/session")).body) as { token: string }).token;

function open(t: Target, headers: Record<string, string> = {}, protocol?: string) {
  const hostname = t.kind === "dev" ? "localhost" : "127.0.0.1";
  const ws = new WebSocketClient(
    `ws://${hostname}:${t.port}${protocol ? "/" : "/api/stream"}`,
    protocol,
    { headers },
  );
  const messages: unknown[] = [];
  const result = new Promise<{ status?: number; code?: number; opened: boolean }>((resolve) => {
    ws.on("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode, opened: false });
      res.resume();
    });
    ws.on("close", (code) => resolve({ code, opened: true }));
    ws.on("error", () => {});
  });
  ws.on("message", (data) => messages.push(JSON.parse((data as Buffer).toString())));
  return { ws, messages, result };
}

const until = async <T>(fn: () => T | undefined | false, ms: number) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`not met within ${ms} ms`);
};

describe.each(["dev", "preview"] as const)("gates under vp %s", (kind) => {
  test("streams line totals to a client holding the token", async () => {
    const t = await start(kind);
    const token = await tokenOf(t);
    const { ws, messages } = open(t);
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, cursors: [] })));
    await until(
      () =>
        messages.find(
          (m) => (m as ServerMessage).type === "lines" && (m as { total: number }).total === 2,
        ),
      3000,
    );
    appendFileSync(join(t.logsRoot, "a.jsonl"), "3\n");
    await until(
      () =>
        messages.find(
          (m) => (m as ServerMessage).type === "lines" && (m as { total: number }).total === 3,
        ),
      1500,
    );
    ws.close();
  });

  test("Host and Origin are refused before the upgrade; the token is checked after it", async () => {
    const t = await start(kind);
    expect((await open(t, { Host: `evil.example:${t.port}` }).result).status).toBe(421);
    expect((await open(t, { Origin: `http://127.0.0.1:${t.port + 1}` }).result).status).toBe(403);
    expect((await open(t, { Origin: "http://evil.example" }).result).status).toBe(403);
    // Absent Origin without a token: accepted, then closed 4401 after the hello timeout.
    const silent = open(t);
    expect(await silent.result).toMatchObject({ opened: true, code: 4401 });
    const wrong = open(t);
    wrong.ws.on("open", () =>
      wrong.ws.send(JSON.stringify({ type: "hello", token: "x", cursors: [] })),
    );
    expect(await wrong.result).toMatchObject({ opened: true, code: 4401 });
    const origin = open(t, { Origin: `http://${t.host}` });
    origin.ws.on("open", () => origin.ws.send("nope"));
    expect(await origin.result).toMatchObject({ opened: true, code: 4400 });
  }, 10_000);

  test("/api/session and /api/import honour the gates", async () => {
    const t = await start(kind);
    const session = await get(t, "/api/session", "GET", { "Sec-Fetch-Site": "same-origin" });
    expect(session.status).toBe(200);
    expect(session.headers["cache-control"]).toBe("no-store");
    const token = (JSON.parse(session.body) as { token: string }).token;
    const cross = await get(t, "/api/session", "GET", { Origin: "http://127.0.0.1:1" });
    expect(cross.status).toBe(403);
    expect(cross.body).not.toContain(token);
    expect(Object.keys(cross.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    const evil = await get(t, "/api/session", "GET", { Host: "evil.example" });
    expect(evil.status).toBe(421);
    expect(evil.body).toContain(`http://${t.host}/`);
    expect((await get(t, "/api/import", "POST", { Host: "evil.example" })).status).toBe(421);
    expect((await get(t, "/api/import", "POST", { Origin: "http://127.0.0.1:1" })).status).toBe(
      403,
    );
    expect((await get(t, "/api/import", "POST")).status).toBe(401);
    expect((await get(t, "/api/import", "POST", { "X-Synapse-Token": token })).status).toBe(501);
  });

  test("index.html carries the current token and mode", async () => {
    const t = await start(kind);
    const token = await tokenOf(t);
    const html = (await get(t, "/")).body;
    expect(html).toContain(`<meta name="synapse-token" content="${token}" />`);
    expect(html).toContain(`<meta name="synapse-mode" content="${kind}" />`);
  });
});

describe("vp preview templating", () => {
  test("/, /index.html and a deep SPA route carry both metas, no-store and the preview headers", async () => {
    const t = await start("preview");
    const token = await tokenOf(t);
    for (const path of ["/", "/index.html", "/halls/a/deep", "/?x=1"]) {
      const res = await get(t, path);
      expect(res.status).toBe(200);
      expect(res.body).toContain(`content="${token}"`);
      expect(res.body).toContain('name="synapse-mode" content="preview"');
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
      expect(String(res.headers["content-type"])).toContain("text/html");
    }
    expect((await get(t, "/", "HEAD")).body).toBe("");
  });

  test("index templating is gated by Host; other assets are untouched", async () => {
    const t = await start("preview");
    expect((await get(t, "/", "GET", { Host: "evil.example" })).status).toBe(421);
    writeFileSync(join(t.root, "dist", "app.js"), "console.log(2)");
    const asset = await get(t, "/app.js", "GET", { Host: "evil.example" });
    expect(asset.status).not.toBe(421);
  });
});

describe("vp dev", () => {
  test("Host 127.0.0.1 gets a 308 to localhost, before Vite's own host check", async () => {
    const t = await start("dev");
    const res = await get(t, "/some/page?q=1", "GET", { Host: `127.0.0.1:${t.port}` });
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(`http://localhost:${t.port}/some/page?q=1`);
  });

  test("an HMR-path upgrade is left to Vite and a change hot-reloads", async () => {
    const t = await start("dev");
    const hmr = open(t, {}, "vite-hmr");
    await new Promise((resolve, reject) => {
      hmr.ws.on("open", resolve);
      hmr.ws.on("error", reject);
    });
    await until(() => hmr.messages.find((m) => (m as { type: string }).type === "connected"), 3000);
    // Load the module so the graph knows it, then change it.
    expect((await get(t, "/main.js")).status).toBe(200);
    writeFileSync(join(t.root, "main.js"), "console.log(2);\n");
    const update = await until(
      () =>
        hmr.messages.find((m) => ["update", "full-reload"].includes((m as { type: string }).type)),
      5000,
    );
    expect(update).toBeTruthy();
    hmr.ws.close();
  }, 15_000);

  test("every response to the page is not cached", async () => {
    const t = await start("dev");
    expect((await get(t, "/")).headers["cache-control"]).toBe("no-store");
  });
});

test("a production build never contains a token", async () => {
  const root = project();
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [synapseLogServer(pluginOptions(freshDir()))],
    build: { outDir: join(root, "out") },
  });
  const html = readFileSync(join(root, "out", "index.html"), "utf8");
  expect(html).not.toContain("synapse-token");
  expect(html).not.toContain("synapse-mode");
});

test("a broken config file is the root status; nothing is watched", async () => {
  const root = project();
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { host: "localhost", port: 0 },
    plugins: [
      synapseLogServer({
        env: {},
        platform: "linux",
        homedir: "/home/u",
        cwd: base,
        readConfig: () => "{nope",
        log: () => {},
      }),
    ],
  });
  await server.listen();
  const port = (server.httpServer!.address() as AddressInfo).port;
  const t: Target = {
    kind: "dev",
    port,
    host: `localhost:${port}`,
    root,
    logsRoot: "",
    close: () => server.close(),
  };
  targets.push(t);
  const token = await tokenOf(t);
  const { ws, messages } = open(t);
  ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token, cursors: [] })));
  const roots = (await until(
    () => messages.find((m) => (m as { type: string }).type === "roots"),
    3000,
  )) as Extract<ServerMessage, { type: "roots" }>;
  expect(roots.roots[0]).toMatchObject({
    path: "/home/u/.config/synapse-horizon/config.json",
    files: 0,
    source: "config",
  });
  expect(roots.roots[0].reason).toContain("invalid config file");
  ws.close();
});
