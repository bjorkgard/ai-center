import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocketClient from "ws";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { createLogServer, type LogServer } from "./logServer.ts";
import { checkHost, createServer, type AssetMap } from "./server.ts";

const assets: AssetMap = new Map([
  [
    "/index.html",
    { bytes: Buffer.from("<title>Synapse Horizon</title>"), contentType: "text/html" },
  ],
  ["/assets/app.js", { bytes: Buffer.from("console.log(1)"), contentType: "text/javascript" }],
]);

let server: Server | undefined;
let logs: string[] = [];

async function start(map: AssetMap = assets): Promise<number> {
  logs = [];
  server = createServer({ port: 0, assets: map, log: (line) => logs.push(line) });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server!.close(resolve));
  server = undefined;
});

function get(port: number, path: string, host?: string, method = "GET") {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path, method, headers: { Host: host ?? `127.0.0.1:${port}` } },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
}

describe("checkHost", () => {
  test("serves the bound 127.0.0.1 host, redirects localhost, rejects the rest", () => {
    expect(checkHost("127.0.0.1:7317", 7317)).toBe("serve");
    expect(checkHost("localhost:7317", 7317)).toBe("redirect");
    expect(checkHost("127.0.0.1:7318", 7317)).toBe("reject");
    expect(checkHost("evil.example:7317", 7317)).toBe("reject");
    expect(checkHost(undefined, 7317)).toBe("reject");
  });

  test("on port 80 the Host header may omit the port", () => {
    expect(checkHost("127.0.0.1", 80)).toBe("serve");
    expect(checkHost("localhost", 80)).toBe("redirect");
    expect(checkHost("127.0.0.1", 7317)).toBe("reject");
    expect(checkHost("evil.example", 80)).toBe("reject");
  });
});

describe("host gate", () => {
  test("421 for an unknown Host, with one log line (method, path, Host)", async () => {
    const port = await start();
    const res = await get(port, "/x?y=1", `evil.example:${port}`);
    expect(res.status).toBe(421);
    expect(logs).toEqual([`421 GET /x?y=1 Host: evil.example:${port}`]);
  });

  test("308 from localhost:<port> keeps path and query", async () => {
    const port = await start();
    const res = await get(port, "/some/path?q=1", `localhost:${port}`);
    expect(res.status).toBe(308);
    expect(res.headers.location).toBe(`http://127.0.0.1:${port}/some/path?q=1`);
  });

  test("the gate uses the port actually bound, not a stale one", async () => {
    const port = await start();
    expect((await get(port, "/", "127.0.0.1:1")).status).toBe(421);
  });
});

describe("manifest lookup", () => {
  test.each([
    "/../package.json",
    "/%2e%2e/package.json",
    "/assets/../../x",
    "/%2e%2e%2fpackage.json",
  ])("404 for traversal %s", async (path) => {
    const port = await start();
    expect((await get(port, path)).status).toBe(404);
  });

  test("400 for malformed percent-encoding", async () => {
    const port = await start();
    expect((await get(port, "/%E0%A4%A")).status).toBe(400);
  });

  test("200 for a known asset with its content type", async () => {
    const port = await start();
    const res = await get(port, "/assets/app.js?v=1");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/javascript");
    expect(res.body).toBe("console.log(1)");
  });

  test("404 for an unknown /assets/ path", async () => {
    const port = await start();
    expect((await get(port, "/assets/missing.js")).status).toBe(404);
  });

  test("other unknown paths fall back to index.html (SPA)", async () => {
    const port = await start();
    const res = await get(port, "/halls/a");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Synapse Horizon");
  });

  test("405 for non-GET methods", async () => {
    const port = await start();
    expect((await get(port, "/", undefined, "POST")).status).toBe(405);
  });
});

describe("handler errors", () => {
  test("500 and a log line when the handler throws, and the server keeps serving", async () => {
    const throwing: AssetMap = new Map(assets);
    const realGet = throwing.get.bind(throwing);
    throwing.get = (key) => {
      if (key === "/boom") throw new Error("kaboom");
      return realGet(key);
    };
    const port = await start(throwing);
    const bad = await get(port, "/boom");
    expect(bad.status).toBe(500);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("500 GET /boom");
    expect(logs[0]).toContain("kaboom");
    expect((await get(port, "/")).status).toBe(200);
  });
});

describe("log server in the binary", () => {
  const sockets: WebSocketClient[] = [];
  let logServer: LogServer | undefined;

  async function startWithLogs() {
    logs = [];
    logServer = createLogServer({
      mode: "binary",
      resolution: { kind: "none", reason: "--no-logs" },
      log: (line) => logs.push(line),
      helloTimeoutMs: 150,
    });
    server = createServer({ port: 0, assets, log: (line) => logs.push(line), logServer });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, logServer };
  }

  afterEach(async () => {
    while (sockets.length > 0) sockets.pop()!.terminate();
    await logServer?.stop();
    logServer = undefined;
  });

  function upgrade(port: number, headers: Record<string, string>) {
    return new Promise<{ status?: number; code?: number }>((resolve) => {
      const ws = new WebSocketClient(`ws://127.0.0.1:${port}/api/stream`, { headers });
      sockets.push(ws);
      ws.on("unexpected-response", (_req, res) => {
        resolve({ status: res.statusCode });
        res.resume();
      });
      ws.on("close", (code) => resolve({ code }));
      ws.on("error", () => {});
    });
  }

  test("/, /index.html and a deep SPA route carry the current token, both metas and no-store", async () => {
    const { port, logServer } = await startWithLogs();
    for (const path of ["/", "/index.html", "/halls/a/deep"]) {
      const res = await get(port, path);
      expect(res.status).toBe(200);
      expect(res.body).toContain(`<meta name="synapse-token" content="${logServer.token}" />`);
      expect(res.body).toContain('<meta name="synapse-mode" content="binary" />');
      expect(res.headers["cache-control"]).toBe("no-store");
    }
    expect((await get(port, "/assets/app.js")).headers["cache-control"]).toBeUndefined();
  });

  test("a foreign Host gets 421 naming the URL to use, on every route", async () => {
    const { port } = await startWithLogs();
    for (const path of ["/", "/api/session", "/api/import"]) {
      const res = await get(port, path, `evil.example:${port}`);
      expect(res.status).toBe(421);
      expect(res.body).toContain(`http://127.0.0.1:${port}/`);
    }
    expect((await upgrade(port, { Host: `evil.example:${port}` })).status).toBe(421);
  });

  test("the WebSocket gate: another origin gets 403, absent origin needs the token, the right token streams", async () => {
    const { port, logServer } = await startWithLogs();
    expect((await upgrade(port, { Origin: `http://127.0.0.1:${port + 1}` })).status).toBe(403);
    expect(await upgrade(port, {})).toEqual({ code: 4401 });
    const ok = new WebSocketClient(`ws://127.0.0.1:${port}/api/stream`);
    sockets.push(ok);
    const received: unknown[] = [];
    const roots = new Promise<unknown>((resolve) =>
      ok.on("message", (data) => {
        const message = JSON.parse((data as Buffer).toString()) as { type: string };
        received.push(message);
        if (message.type === "roots") resolve(message);
      }),
    );
    ok.on("open", () =>
      ok.send(JSON.stringify({ type: "hello", token: logServer.token, cursors: [] })),
    );
    expect(await roots).toEqual({ type: "roots", roots: [] });
    expect(received[0]).toEqual({ type: "heartbeat" });
  });

  test("an upgrade for any other path is closed, and /api/session answers the right Host", async () => {
    const { port, logServer } = await startWithLogs();
    const other = new WebSocketClient(`ws://127.0.0.1:${port}/not-the-stream`);
    sockets.push(other);
    const closed = await new Promise<boolean>((resolve) => {
      other.on("error", () => resolve(true));
      other.on("open", () => resolve(false));
    });
    expect(closed).toBe(true);
    expect(JSON.parse((await get(port, "/api/session")).body)).toEqual({ token: logServer.token });
  });
});
