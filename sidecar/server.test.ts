import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vite-plus/test";
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
