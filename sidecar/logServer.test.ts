import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocketClient from "ws";
import { afterAll, afterEach, describe, expect, test } from "vite-plus/test";
import { createLiveSource, type SocketLike } from "../src/data/liveSource.ts";
import { parseServerMessage, type ServerMessage } from "../src/data/wire.ts";
import {
  allowedHost,
  BUFFER_LIMIT,
  Channel,
  checkGate,
  matchCursors,
  createLogServer,
  HELLO_TIMEOUT_MS,
  MAX_PAYLOAD,
  MAX_PENDING_SOCKETS,
  startupLines,
  templateIndex,
  type LogServer,
  type LogServerOptions,
  type Mode,
} from "./logServer.ts";

const base = mkdtempSync(join(tmpdir(), "sh-logserver-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const freshRoot = () => {
  const root = join(base, `root${n++}`);
  mkdirSync(root, { recursive: true });
  return root;
};

const until = async <T>(fn: () => T | undefined | false, ms: number, what = "condition") => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const value = fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} not met within ${ms} ms`);
};

interface Running {
  http: Server;
  logServer: LogServer;
  port: number;
  logs: string[];
}
const running: Running[] = [];

async function startServer(
  root: string | string[] | null,
  options: Partial<LogServerOptions> = {},
  port = 0,
): Promise<Running> {
  const logs: string[] = [];
  const roots = root === null ? [] : Array.isArray(root) ? root : [root];
  const logServer = createLogServer({
    mode: "binary",
    resolution:
      root === null
        ? { kind: "none", reason: "--no-logs" }
        : { kind: "roots", roots: roots.map((path) => ({ path, source: "flag" as const })) },
    log: (line) => logs.push(line),
    ...options,
  });
  const http = createServer((req, res) => {
    if (logServer.handleRequest(req, res, (http.address() as AddressInfo).port)) return;
    res.writeHead(404).end();
  });
  http.on("upgrade", (req, socket, head) => {
    if (!logServer.handleUpgrade(req, socket, head, (http.address() as AddressInfo).port)) {
      socket.destroy();
    }
  });
  await new Promise<void>((resolve) => http.listen(port, "127.0.0.1", resolve));
  await logServer.start();
  const entry = { http, logServer, port: (http.address() as AddressInfo).port, logs };
  running.push(entry);
  return entry;
}

async function stopServer(entry: Running): Promise<void> {
  running.splice(running.indexOf(entry), 1);
  await entry.logServer.stop();
  entry.http.closeAllConnections();
  await new Promise((resolve) => entry.http.close(resolve));
}

afterEach(async () => {
  while (running.length > 0) await stopServer(running[0]);
  while (clients.length > 0) clients.pop()!.close();
});

const clients: { close(): void }[] = [];

/** A client on Node's global WebSocket. */
function connect(port: number, token: string | null, cursors: unknown[] = []) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`);
  clients.push(ws);
  const messages: ServerMessage[] = [];
  const state: { code?: number } = {};
  ws.onmessage = (event) => messages.push(JSON.parse(String(event.data)) as ServerMessage);
  ws.onclose = (event) => (state.code = event.code);
  if (token !== null) {
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", token, cursors }));
  }
  const lines = (path: string) =>
    messages.findLast((m) => m.type === "lines" && m.path === path) as
      | Extract<ServerMessage, { type: "lines" }>
      | undefined;
  return { ws, messages, state, lines };
}

describe("streaming line totals", () => {
  test("appending a line to a watched file updates the total within 1 s", async () => {
    const root = freshRoot();
    const file = join(root, "a.jsonl");
    writeFileSync(file, "1\n2\n");
    const { port, logServer } = await startServer(root);
    const c = connect(port, logServer.token);
    await until(() => c.lines(file)?.total === 2, 2000, "initial total");
    appendFileSync(file, "3\n");
    await until(() => c.lines(file)?.total === 3, 1000, "updated total");
  });

  test("hello is answered with roots, a heartbeat, progress and absolute totals; then heartbeats", async () => {
    const root = freshRoot();
    const file = join(root, "a.jsonl");
    writeFileSync(file, "1\n");
    const { port, logServer } = await startServer(root, { heartbeatMs: 50 });
    await logServer.backfilled();
    const c = connect(port, logServer.token);
    await until(() => c.messages.filter((m) => m.type === "heartbeat").length >= 3, 2000);
    expect(c.messages.find((m) => m.type === "roots")).toMatchObject({
      type: "roots",
      roots: [{ path: root, files: 1, source: "flag" }],
    });
    expect(c.messages.map((m) => m.type)).toContain("progress");
    expect(c.lines(file)).toMatchObject({ total: 1 });
  });

  test("restart on the same port with a client staying connected gives equal absolute totals", async () => {
    const root = freshRoot();
    const a = join(root, "a.jsonl");
    const b = join(root, "b.jsonl");
    writeFileSync(a, "1\n2\n3\n");
    writeFileSync(b, "1\n");
    let entry = await startServer(root);
    const port = entry.port;
    const first = connect(port, entry.logServer.token);
    await until(() => first.lines(a) && first.lines(b), 2000);
    const before = [first.lines(a)!.total, first.lines(b)!.total];
    const oldToken = entry.logServer.token;
    await stopServer(entry);
    await until(() => first.state.code !== undefined, 2000, "client sees the close");
    entry = await startServer(root, {}, port);
    expect(entry.logServer.token).not.toBe(oldToken);
    const second = connect(port, entry.logServer.token, [
      { path: a, fileId: first.lines(a)!.fileId, offset: 6 },
    ]);
    await until(() => second.lines(a) && second.lines(b), 2000);
    expect([second.lines(a)!.total, second.lines(b)!.total]).toEqual(before);
  });

  test("a file ending in a partial line counts the line once, when it is completed", async () => {
    const root = freshRoot();
    const file = join(root, "a.jsonl");
    writeFileSync(file, "1\n2\npartial");
    let entry = await startServer(root);
    const port = entry.port;
    let c = connect(port, entry.logServer.token);
    await until(() => c.lines(file)?.total === 2, 2000);
    await stopServer(entry);
    entry = await startServer(root, {}, port);
    c = connect(port, entry.logServer.token);
    await until(() => c.lines(file)?.total === 2, 2000);
    appendFileSync(file, " line\n");
    await until(() => c.lines(file)?.total === 3, 1000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(c.messages.filter((m) => m.type === "lines" && m.total === 4)).toEqual([]);
  });

  test("a rotation replaces the total under a new file id", async () => {
    const root = freshRoot();
    const file = join(root, "a.jsonl");
    writeFileSync(file, "1\n2\n3\n");
    const { port, logServer } = await startServer(root);
    const c = connect(port, logServer.token);
    await until(() => c.lines(file)?.total === 3, 2000);
    const oldId = c.lines(file)!.fileId;
    const next = join(root, "next.tmp");
    writeFileSync(next, "x\n");
    renameSync(next, file);
    await until(() => c.lines(file)?.total === 1, 1500);
    expect(c.lines(file)!.fileId).not.toBe(oldId);
  });

  test("a root that does not exist is reported with problem, cause and fix", async () => {
    const missing = join(base, "does-not-exist");
    const { port, logServer } = await startServer(missing);
    const c = connect(port, logServer.token);
    const message = await until(() => c.messages.find((m) => m.type === "roots"), 2000);
    const roots = (message as Extract<ServerMessage, { type: "roots" }>).roots;
    expect(roots[0].reason).toMatch(/root not found: .*does-not-exist.*--log-root.*#configuration/);
  });

  test("nothing is watched for no-logs, and a config error is the root status", async () => {
    const none = await startServer(null);
    expect(none.logServer.rootsMessage()).toEqual([]);
    const broken = createLogServer({
      mode: "dev",
      resolution: { kind: "error", configPath: "/cfg.json", message: "invalid config file: x" },
      log: () => {},
    });
    await broken.start();
    expect(broken.rootsMessage()).toEqual([
      expect.objectContaining({ path: "/cfg.json", files: 0, source: "config" }),
    ]);
    expect(broken.rootsMessage()[0].reason).toContain("invalid config file: x");
    expect(broken.rootsMessage()[0].configError).toBe(true);
    // The client recognises exactly what the server sends.
    const socket: SocketLike = {
      onopen: null,
      onmessage: null,
      onclose: null,
      send: () => {},
      close: () => {},
    };
    const live = createLiveSource({ url: "ws://x", token: () => "t", createSocket: () => socket });
    const seen: { status: string; detail?: string }[] = [];
    live.onStatus((status, detail) => seen.push({ status, detail }));
    live.start();
    const text = JSON.stringify({ type: "roots", roots: broken.rootsMessage() });
    expect(parseServerMessage(text)).toBeDefined();
    socket.onmessage?.({ data: text });
    expect(seen.at(-1)).toMatchObject({ status: "error" });
    expect(seen.at(-1)?.detail).toContain("invalid config file: x");
    expect(seen.at(-1)?.detail).toContain("/cfg.json");
    await broken.stop();
  });

  test("an ordinary root never carries the config-error flag", async () => {
    const { logServer } = await startServer(freshRoot());
    expect(logServer.rootsMessage().some((root) => root.configError !== undefined)).toBe(false);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable file is skipped with one EACCES line naming the fix",
    async () => {
      const root = freshRoot();
      const file = join(root, "locked.jsonl");
      writeFileSync(file, "1\n");
      chmodSync(file, 0o000);
      const { logs, logServer } = await startServer(root);
      await logServer.backfilled();
      chmodSync(file, 0o600);
      expect(logs.filter((l) => l.includes("EACCES"))).toHaveLength(1);
      expect(logs.join("\n")).toMatch(
        /permission denied \(EACCES\) reading .*locked\.jsonl; skipped/,
      );
    },
  );
});

describe("backfill", () => {
  test("files older than 24 h are not read; 500 fixtures reach 500/500 with reads of at most 64 KiB", async () => {
    const root = freshRoot();
    for (let i = 0; i < 500; i++) {
      writeFileSync(join(root, `f${i}.jsonl`), `${"x".repeat(100)}\n`.repeat(2));
    }
    writeFileSync(join(root, "big.jsonl"), `${"y".repeat(99)}\n`.repeat(3000));
    const old = join(root, "old.jsonl");
    writeFileSync(old, "1\n");
    const past = new Date(Date.now() - 25 * 3600_000);
    utimesSync(old, past, past);
    const reads: Array<[string, number]> = [];
    const { port, logServer } = await startServer(root, {
      onRead: (path, bytes) => reads.push([path, bytes]),
    });
    await logServer.backfilled();
    const c = connect(port, logServer.token);
    await until(() => c.messages.some((m) => m.type === "progress" && m.done === 501), 3000);
    expect(c.messages.filter((m) => m.type === "progress").at(-1)).toEqual({
      type: "progress",
      done: 501,
      total: 501,
    });
    expect(reads.some(([path]) => path === old)).toBe(false);
    expect(Math.max(...reads.map(([, bytes]) => bytes))).toBeLessThanOrEqual(64 * 1024);
    expect(c.lines(join(root, "big.jsonl"))?.total).toBe(3000);
  });

  test("at most 4 files are read at a time", async () => {
    const root = freshRoot();
    for (let i = 0; i < 30; i++) writeFileSync(join(root, `f${i}.jsonl`), "x\n".repeat(50_000));
    let active = 0;
    let peak = 0;
    const open = new Set<string>();
    const { logServer } = await startServer(root, {
      onRead: (path, bytes) => {
        // A file is "active" from its first read until its final short read.
        if (!open.has(path)) {
          open.add(path);
          active++;
          peak = Math.max(peak, active);
        }
        if (bytes < 64 * 1024) {
          open.delete(path);
          active--;
        }
      },
    });
    await logServer.backfilled();
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });
});

describe("limits", () => {
  test("a first message other than hello closes with 4400", async () => {
    const { port } = await startServer(freshRoot());
    for (const first of ['{"type":"heartbeat"}', "not json", "[]", '{"token":"x"}']) {
      const c = connect(port, null);
      c.ws.onopen = () => c.ws.send(first);
      await until(() => c.state.code !== undefined, 2000);
      expect(c.state.code).toBe(4400);
    }
    const binary = connect(port, null);
    binary.ws.onopen = () => binary.ws.send(new Uint8Array([1, 2, 3]));
    await until(() => binary.state.code !== undefined, 2000);
    expect(binary.state.code).toBe(4400);
  });

  test("a hello without a usable token closes 4401, not 4400", async () => {
    const { port } = await startServer(freshRoot());
    for (const first of [
      '{"type":"hello"}',
      '{"type":"hello","cursors":[]}',
      '{"type":"hello","token":5,"cursors":[]}',
      '{"type":"hello","token":null,"cursors":[]}',
      '{"type":"hello","token":"stale"}',
      '{"type":"hello","token":"stale","cursors":"x"}',
    ]) {
      const c = connect(port, null);
      c.ws.onopen = () => c.ws.send(first);
      await until(() => c.state.code !== undefined, 2000);
      expect(c.state.code).toBe(4401);
    }
  });

  test("a correct token with malformed cursors closes 4400", async () => {
    const { port, logServer } = await startServer(freshRoot());
    for (const cursors of ['"x"', "[1]", "null"]) {
      const c = connect(port, null);
      c.ws.onopen = () =>
        c.ws.send(`{"type":"hello","token":"${logServer.token}","cursors":${cursors}}`);
      await until(() => c.state.code !== undefined, 2000);
      expect(c.state.code).toBe(4400);
    }
  });

  test("a wrong token closes 4401 and a missing hello closes 4401 after the timeout", async () => {
    expect(HELLO_TIMEOUT_MS).toBe(2000);
    const { port } = await startServer(freshRoot(), { helloTimeoutMs: 150 });
    const wrong = connect(port, "nope");
    await until(() => wrong.state.code !== undefined, 2000);
    expect(wrong.state.code).toBe(4401);
    const silent = connect(port, null);
    await until(() => silent.state.code !== undefined, 2000);
    expect(silent.state.code).toBe(4401);
  });

  test("a payload over 1 MB closes the socket (1009)", async () => {
    expect(MAX_PAYLOAD).toBe(1024 * 1024);
    const { port, logServer } = await startServer(freshRoot());
    const c = connect(port, null);
    c.ws.onopen = () =>
      c.ws.send(
        JSON.stringify({ type: "hello", token: logServer.token, pad: "x".repeat(MAX_PAYLOAD) }),
      );
    await until(() => c.state.code !== undefined, 2000);
    expect(c.state.code).toBe(1009);
  });

  test("the 17th pending socket is closed with 1013", async () => {
    expect(MAX_PENDING_SOCKETS).toBe(16);
    const { port } = await startServer(freshRoot(), { helloTimeoutMs: 10_000 });
    const pending = Array.from({ length: 16 }, () => connect(port, null));
    await until(() => pending.every((p) => p.ws.readyState === WebSocket.OPEN), 2000);
    const extra = connect(port, null);
    await until(() => extra.state.code !== undefined, 2000);
    expect(extra.state.code).toBe(1013);
    expect(pending.every((p) => p.state.code === undefined)).toBe(true);
  });

  test("a hello may carry at most as many cursors as the server has known files", async () => {
    const root = freshRoot();
    writeFileSync(join(root, "a.jsonl"), "1\n");
    const { port, logServer } = await startServer(root);
    const cursor = (path: string) => ({ path, fileId: "1:1", offset: 0 });
    const ok = connect(port, logServer.token, [cursor(join(root, "a.jsonl"))]);
    await until(() => ok.messages.length > 0, 2000);
    expect(ok.state.code).toBeUndefined();
    const tooMany = connect(port, logServer.token, [cursor("/x"), cursor("/y")]);
    await until(() => tooMany.state.code !== undefined, 2000);
    expect(tooMany.state.code).toBe(4400);
  });

  test("forged cursor paths are ignored: nothing outside the known files is ever opened", async () => {
    const root = freshRoot();
    writeFileSync(join(root, "a.jsonl"), "1\n");
    const reads: string[] = [];
    const { port, logServer } = await startServer(root, { onRead: (path) => reads.push(path) });
    const c = connect(port, logServer.token, [
      { path: "../../etc/passwd", fileId: "1:1", offset: 0 },
    ]);
    await until(() => c.messages.some((m) => m.type === "heartbeat"), 2000);
    expect(c.state.code).toBeUndefined();
    expect(reads.every((p) => p.startsWith(root))).toBe(true);
  });

  test("matchCursors keeps cursors for known files and drops the rest", () => {
    const known = new Set(["/r/a.jsonl"]);
    const kept = { path: "/r/a.jsonl", fileId: "1:1", offset: 3 };
    const forged = { path: "../../etc/passwd", fileId: "1:1", offset: 0 };
    expect(matchCursors([forged, kept], known)).toEqual([kept]);
  });

  test("the first message after an accepted hello is the heartbeat, then roots", async () => {
    const { port, logServer } = await startServer(freshRoot());
    const c = connect(port, logServer.token);
    await until(() => c.messages.length >= 3, 2000);
    expect(c.messages.slice(0, 3).map((m) => m.type)).toEqual(["heartbeat", "roots", "progress"]);
  });
});

describe("backpressure", () => {
  function fakeSocket() {
    const sent: ServerMessage[] = [];
    return {
      sent,
      buffered: 0,
      get bufferedAmount() {
        return this.buffered;
      },
      send(data: string) {
        sent.push(JSON.parse(data) as ServerMessage);
      },
    };
  }

  test("above 1 MB nothing is sent, only the latest total per file is kept, and it is flushed on drain", () => {
    expect(BUFFER_LIMIT).toBe(1024 * 1024);
    const socket = fakeSocket();
    const channel = new Channel(socket, BUFFER_LIMIT);
    socket.buffered = BUFFER_LIMIT + 1;
    for (let round = 1; round <= 3; round++) {
      for (let i = 0; i < 10_000; i++) {
        channel.send({ type: "lines", path: `/f${i}.jsonl`, fileId: "1:1", total: round });
      }
      channel.send({ type: "progress", done: round, total: 3 });
    }
    expect(socket.sent).toEqual([]);
    expect(channel.pendingSize).toBeLessThanOrEqual(10_001);
    socket.buffered = 0;
    channel.drain();
    expect(channel.pendingSize).toBe(0);
    expect(socket.sent).toHaveLength(10_001);
    expect(socket.sent.filter((m) => m.type === "lines").every((m) => m.total === 3)).toBe(true);
    expect(socket.sent.find((m) => m.type === "progress")).toMatchObject({ done: 3 });
  });

  test("below the limit messages are sent at once", () => {
    const socket = fakeSocket();
    const channel = new Channel(socket, BUFFER_LIMIT);
    channel.send({ type: "heartbeat" });
    expect(socket.sent).toEqual([{ type: "heartbeat" }]);
  });
});

describe("gates", () => {
  const modes: Array<[Mode, (port: number) => string]> = [
    ["dev", (port) => `localhost:${port}`],
    ["preview", (port) => `127.0.0.1:${port}`],
    ["binary", (port) => `127.0.0.1:${port}`],
  ];

  test.each(modes)("%s accepts its own host and origin only", (mode, host) => {
    expect(allowedHost(mode, 5173)).toBe(host(5173));
    const own = host(5173);
    expect(checkGate(mode, 5173, { host: own })).toBeUndefined();
    expect(checkGate(mode, 5173, { host: own, origin: `http://${own}` })).toBeUndefined();
    expect(checkGate(mode, 5173, { host: `evil.example:5173` })).toMatchObject({ status: 421 });
    expect(checkGate(mode, 5173, { host: undefined })).toMatchObject({ status: 421 });
    expect(checkGate(mode, 5173, { host: own, origin: "http://127.0.0.1:9999" })).toMatchObject({
      status: 403,
    });
    expect(checkGate(mode, 5173, { host: own, origin: "http://evil.example" })).toMatchObject({
      status: 403,
    });
    expect(checkGate(mode, 5173, { host: `evil.example:5173` })!.body).toContain(`http://${own}/`);
  });

  test.each(modes)("%s on port 80 also accepts the default-port forms", (mode) => {
    const name = allowedHost(mode, 80).replace(":80", "");
    for (const host of [name, `${name}:80`]) {
      expect(checkGate(mode, 80, { host })).toBeUndefined();
      expect(checkGate(mode, 80, { host, origin: `http://${name}` })).toBeUndefined();
      expect(checkGate(mode, 80, { host, origin: `http://${name}:80` })).toBeUndefined();
    }
    expect(checkGate(mode, 80, { host: "evil.example" })).toMatchObject({ status: 421 });
    // The bare form is only the default port's: on any other port it is refused.
    expect(checkGate(mode, 5173, { host: name })).toMatchObject({ status: 421 });
    expect(checkGate(mode, 5173, { host: `${name}:5173`, origin: `http://${name}` })).toMatchObject(
      {
        status: 403,
      },
    );
  });

  /** Opens the stream with the `ws` client, which can set Host and Origin. */
  function raw(port: number, headers: Record<string, string>) {
    return new Promise<{ status?: number; code?: number; opened: boolean }>((resolve) => {
      const ws = new WebSocketClient(`ws://127.0.0.1:${port}/api/stream`, { headers });
      ws.on("unexpected-response", (_req, res) => {
        resolve({ status: res.statusCode, opened: false });
        res.resume();
      });
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", token: "wrong", cursors: [] })));
      ws.on("close", (code) => resolve({ code, opened: true }));
      ws.on("error", () => {});
    });
  }

  test("the upgrade is refused by Host (421) and Origin (403) before any token check", async () => {
    const { port } = await startServer(freshRoot());
    expect((await raw(port, { Host: `evil.example:${port}` })).status).toBe(421);
    expect((await raw(port, { Origin: `http://127.0.0.1:${port + 1}` })).status).toBe(403);
    expect((await raw(port, { Origin: "http://evil.example" })).status).toBe(403);
    // Absent Origin passes the Origin check and then needs the token.
    expect(await raw(port, {})).toMatchObject({ opened: true, code: 4401 });
    expect(await raw(port, { Origin: `http://127.0.0.1:${port}` })).toMatchObject({
      opened: true,
      code: 4401,
    });
  });

  function http(
    port: number,
    path: string,
    method: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: { Host: `127.0.0.1:${port}`, ...headers },
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

  test("/api/import: gate rejections, the token, then 501", async () => {
    const { port, logServer } = await startServer(freshRoot());
    const token = { "X-Synapse-Token": logServer.token };
    expect((await http(port, "/api/import", "POST", { Host: `evil.example:${port}` })).status).toBe(
      421,
    );
    expect(
      (
        await http(port, "/api/import", "POST", {
          ...token,
          Origin: `http://127.0.0.1:${port + 1}`,
        })
      ).status,
    ).toBe(403);
    expect((await http(port, "/api/import", "POST")).status).toBe(401);
    expect((await http(port, "/api/import", "POST", { "X-Synapse-Token": "nope" })).status).toBe(
      401,
    );
    expect((await http(port, "/api/import", "GET", token)).status).toBe(405);
    const ok = await http(port, "/api/import", "POST", token);
    expect(ok.status).toBe(501);
    expect(ok.body).toContain("import arrives in chunk 17");
  });

  test("/api/session returns the token with no-store and no CORS headers", async () => {
    const { port, logServer } = await startServer(freshRoot());
    const ok = await http(port, "/api/session", "GET", { "Sec-Fetch-Site": "same-origin" });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ token: logServer.token });
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(ok.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    expect((await http(port, "/api/session", "GET")).status).toBe(200);
  });

  test("/api/session: a cross-origin fetch gets no readable body; a foreign Host gets 421", async () => {
    const { port, logServer } = await startServer(freshRoot());
    const cross = await http(port, "/api/session", "GET", {
      Origin: `http://127.0.0.1:${port + 1}`,
      "Sec-Fetch-Site": "cross-site",
    });
    expect(cross.status).toBe(403);
    expect(cross.body).not.toContain(logServer.token);
    expect(Object.keys(cross.headers).filter((h) => h.startsWith("access-control-"))).toEqual([]);
    expect(
      (await http(port, "/api/session", "GET", { "Sec-Fetch-Site": "cross-site" })).status,
    ).toBe(403);
    expect((await http(port, "/api/session", "GET", { Host: "evil.example" })).status).toBe(421);
    expect((await http(port, "/api/session", "POST")).status).toBe(405);
  });

  test("a restart with a new token is recovered by a fresh /api/session fetch", async () => {
    const root = freshRoot();
    let entry = await startServer(root);
    const port = entry.port;
    const stale = entry.logServer.token;
    await stopServer(entry);
    entry = await startServer(root, {}, port);
    const stalePeer = connect(port, stale);
    await until(() => stalePeer.state.code !== undefined, 2000);
    expect(stalePeer.state.code).toBe(4401);
    const fresh = JSON.parse((await http(port, "/api/session", "GET")).body) as { token: string };
    expect(fresh.token).toBe(entry.logServer.token);
    const c = connect(port, fresh.token);
    await until(() => c.messages.length > 0, 2000);
    expect(c.state.code).toBeUndefined();
  });

  test("other paths and plain GETs of the stream are not handled as API calls", async () => {
    const { port } = await startServer(freshRoot());
    expect((await http(port, "/other", "GET")).status).toBe(404);
    expect((await http(port, "/api/stream", "GET")).status).toBe(426);
  });
});

describe("templateIndex", () => {
  const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";

  test("injects the token and mode metas into the head", () => {
    const out = templateIndex(html, { token: "tok_1-2", mode: "preview" });
    expect(out).toContain('<meta name="synapse-token" content="tok_1-2" />');
    expect(out).toContain('<meta name="synapse-mode" content="preview" />');
    expect(out.indexOf("synapse-token")).toBeLessThan(out.indexOf("</head>"));
    expect(out).toContain("<title>x</title>");
  });

  test("replaces earlier synapse metas so a token is never doubled", () => {
    const once = templateIndex(html, { token: "old", mode: "dev" });
    const twice = templateIndex(once, { token: "new", mode: "dev" });
    expect(twice.match(/synapse-token/g)).toHaveLength(1);
    expect(twice).toContain('content="new"');
    expect(twice).not.toContain('content="old"');
  });
});

describe("startup lines", () => {
  const info = (over: object) => ({ path: "/r", files: 2, source: "flag" as const, ...over });

  test("one line per root with its path and 24 h file count", () => {
    expect(
      startupLines({ kind: "roots", roots: [{ path: "/r", source: "flag" }] }, [info({})]),
    ).toEqual(["[logs] /r: 2 files modified in the last 24 h (flag)"]);
  });

  test("a missing root shows its reason; zero files everywhere adds the hint", () => {
    const lines = startupLines({ kind: "roots", roots: [{ path: "/r", source: "flag" }] }, [
      info({
        files: 0,
        reason:
          "root not found: /r; set --log-root or SYNAPSE_LOG_ROOTS (see README #configuration)",
      }),
    ]);
    expect(lines[0]).toBe(
      "[logs] root not found: /r; set --log-root or SYNAPSE_LOG_ROOTS (see README #configuration)",
    );
    expect(lines[1]).toBe(
      "[logs] no Claude Code or Codex logs found in the last 24 h; start a session, or pass --log-root <dir>",
    );
  });

  test("watching nothing", () => {
    expect(startupLines({ kind: "none", reason: "--no-logs" }, [])).toEqual([
      "[logs] watching nothing (--no-logs)",
    ]);
  });
});
