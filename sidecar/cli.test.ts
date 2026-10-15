import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocketClient from "ws";
import { afterAll, afterEach, describe, expect, test } from "vite-plus/test";
import { loadDiskAssets } from "./assets.ts";
import { openCommand, parseArgs, run, UsageError, type Io } from "./cli.ts";
import { configPathFor } from "./roots.ts";
import { createServer, type AssetMap } from "./server.ts";

const assets: AssetMap = new Map([
  [
    "/index.html",
    { bytes: Buffer.from("<title>Synapse Horizon</title>"), contentType: "text/html" },
  ],
]);

const occupied: Server[] = [];
const scratch = mkdtempSync(join(tmpdir(), "sh-cli-"));
let scratchCount = 0;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const freshDir = () => {
  const dir = join(scratch, `d${scratchCount++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const enoent = () => {
  throw Object.assign(new Error("no such file"), { code: "ENOENT" });
};

function occupy(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const blocker = createNetServer();
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", () => {
      occupied.push(blocker);
      resolve((blocker.address() as { port: number }).port);
    });
  });
}

/** Occupies `count` consecutive ports on purpose and returns the first (never a fixed port). */
async function occupyBlock(count: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const first = 20000 + Math.floor(Math.random() * 30000);
    const before = occupied.length;
    try {
      for (let i = 0; i < count; i++) await occupy(first + i);
      return first;
    } catch {
      for (const blocker of occupied.splice(before))
        await new Promise((resolve) => blocker.close(resolve));
    }
  }
  throw new Error("could not find a free block of ports");
}

afterEach(async () => {
  while (occupied.length > 0) {
    const blocker = occupied.pop()!;
    await new Promise((resolve) => blocker.close(resolve));
  }
});

function harness(overrides: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const signals = new EventEmitter();
  let onReady: (port: number) => void = () => {};
  const ready = new Promise<number>((resolve) => (onReady = resolve));
  const io: Io = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    loadAssets: () => ({ assets, mode: "dist" }),
    openUrl: () => Promise.resolve(),
    createServer,
    signals,
    version: "9.9.9",
    // Never the real home: tests that need log folders pass their own flags.
    env: { SYNAPSE_LOG_ROOTS: "none" },
    platform: process.platform,
    homedir: join(scratch, "home"),
    cwd: scratch,
    readConfig: enoent,
    onListening: (port) => onReady(port),
    ...overrides,
  };
  return { io, out, err, signals, ready };
}

async function serve(argv: string[], overrides: Partial<Io> = {}) {
  const h = harness(overrides);
  const done = run(argv, h.io);
  const port = await Promise.race([h.ready, done.then(() => -1)]);
  return { ...h, done, port };
}

describe("flags (UsageError)", () => {
  test("unknown flag prints usage and exits 2", async () => {
    const h = harness();
    expect(await run(["--bogus"], h.io)).toBe(2);
    expect(h.err.join("\n")).toContain("unknown flag --bogus");
    expect(h.err.join("\n")).toContain("Usage:");
  });

  test.each([["0"], ["65536"], ["abc"], ["-1"], ["1.5"]])(
    "--port %s is rejected, exit 2",
    async (value) => {
      const h = harness();
      expect(await run(["--port", value], h.io)).toBe(2);
      expect(h.err.join("\n")).toContain("--port must be a number from 1 to 65535");
    },
  );

  test("--port without a value is rejected", async () => {
    expect(() => parseArgs(["--port"])).toThrow(UsageError);
  });

  test("ignores a leading -- separator (vp run serve -- --no-open)", () => {
    expect(parseArgs(["--", "--no-open", "--port", "4400"])).toMatchObject({
      open: false,
      port: 4400,
    });
  });

  test("accepts the port range edges and --port=n", () => {
    expect(parseArgs(["--port", "1"]).port).toBe(1);
    expect(parseArgs(["--port", "65535"]).port).toBe(65535);
    expect(parseArgs(["--port=4400", "--no-open"])).toMatchObject({ port: 4400, open: false });
  });

  test("--version prints the version and --help prints usage, both exit 0", async () => {
    const v = harness();
    expect(await run(["--version"], v.io)).toBe(0);
    expect(v.out).toEqual(["9.9.9"]);
    const h = harness();
    expect(await run(["--help"], h.io)).toBe(0);
    expect(h.out.join("\n")).toContain("--no-open");
  });

  test("parses --log-root (repeatable, also --log-root=) and --no-logs", () => {
    expect(parseArgs(["--log-root", "/a", "--log-root=/b", "--no-logs"])).toMatchObject({
      logRoots: ["/a", "/b"],
      noLogs: true,
    });
    expect(parseArgs([])).toMatchObject({ logRoots: [], noLogs: false });
    expect(() => parseArgs(["--log-root"])).toThrow(/--log-root needs a folder/);
    expect(() => parseArgs(["--log-root="])).toThrow(UsageError);
  });
});

describe("--help (DX2)", () => {
  test("lists the flags, the env var, the config path for this OS and the default roots", async () => {
    const env = {};
    const h = harness({ env, homedir: "/home/u", platform: "linux" });
    expect(await run(["--help"], h.io)).toBe(0);
    const text = h.out.join("\n");
    for (const expected of [
      "--log-root <dir>",
      "repeatable",
      "--no-logs",
      "SYNAPSE_LOG_ROOTS",
      '"none"',
      configPathFor(env, "linux", "/home/u"),
      "/home/u/.claude/projects",
      "/home/u/.codex/sessions",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "#configuration",
    ]) {
      expect(text).toContain(expected);
    }
  });

  test("shows the Windows config path on win32", async () => {
    const h = harness({
      env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" },
      platform: "win32",
      homedir: "C:\\Users\\u",
    });
    await run(["--help"], h.io);
    expect(h.out.join("\n")).toContain("synapse-horizon\\config.json");
  });
});

describe("config file errors (DX4)", () => {
  test.each([
    ["invalid JSON", () => "{nope", /invalid config file/],
    [
      "an unreadable file",
      () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
      /cannot read the config file/,
    ],
  ])(
    "%s exits 1 naming the path, the error and a valid example",
    async (_name, readConfig, pattern) => {
      const h = harness({ env: {}, homedir: "/home/u", platform: "linux", readConfig });
      expect(await run(["--no-open"], h.io)).toBe(1);
      const text = h.err.join("\n");
      expect(text).toContain("/home/u/.config/synapse-horizon/config.json");
      expect(text).toMatch(pattern);
      expect(text).toContain('"logRoots"');
      expect(text).toContain("#configuration");
      expect(h.out).toEqual([]);
    },
  );
});

describe("listen", () => {
  test("EADDRINUSE: falls back to the next port and prints it", async () => {
    const busy = await occupy(0);
    const s = await serve(["--port", String(busy), "--no-open"]);
    expect(s.port).toBeGreaterThan(busy);
    expect(s.out.join("\n")).toContain(`${busy} busy, using ${busy + 1}`);
    expect(s.out.join("\n")).toContain(`http://127.0.0.1:${s.port}`);
    s.signals.emit("SIGINT");
    expect(await s.done).toBe(0);
  });

  test("PortsExhausted: all 11 ports busy exits 1", async () => {
    const first = await occupyBlock(11);
    const h = harness();
    expect(await run(["--port", String(first), "--no-open"], h.io)).toBe(1);
    expect(h.err).toEqual([`ports ${first}-${first + 10} busy; use --port`]);
  });

  test("PortsExhausted near the top clamps the range to 65535", async () => {
    const h = harness({
      createServer: () => {
        const fake = new EventEmitter() as unknown as Server;
        (fake as unknown as { listen: () => void }).listen = () =>
          queueMicrotask(() =>
            fake.emit("error", Object.assign(new Error("busy"), { code: "EADDRINUSE" })),
          );
        return fake as never;
      },
    });
    expect(await run(["--port", "65530", "--no-open"], h.io)).toBe(1);
    expect(h.err).toEqual(["ports 65530-65535 busy; use --port"]);
  });

  test("EACCES: exits 1 naming the port", async () => {
    const h = harness({
      createServer: () => {
        const fake = new EventEmitter() as unknown as Server;
        (fake as unknown as { listen: () => void }).listen = () =>
          queueMicrotask(() =>
            fake.emit("error", Object.assign(new Error("denied"), { code: "EACCES" })),
          );
        return fake as never;
      },
    });
    expect(await run(["--port", "80", "--no-open"], h.io)).toBe(1);
    expect(h.err).toEqual(["no permission for port 80"]);
  });
});

describe("startup self-check (IncompleteBuild)", () => {
  test("missing index.html exits 1 before listening", async () => {
    let created = false;
    const h = harness({
      loadAssets: () => ({ assets: new Map(), mode: "dist" }),
      createServer: (options) => {
        created = true;
        return createServer(options);
      },
    });
    expect(await run(["--no-open"], h.io)).toBe(1);
    expect(h.err).toEqual(["build is incomplete: index.html missing"]);
    expect(created).toBe(false);
  });

  test("an empty or absent dist/ loads as an empty map", () => {
    const dir = mkdtempSync(join(tmpdir(), "sh-dist-"));
    try {
      expect(loadDiskAssets(dir).has("/index.html")).toBe(false);
      expect(loadDiskAssets(join(dir, "nope")).size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("open browser (OpenFailed)", () => {
  test("a failing opener warns with the URL and keeps serving", async () => {
    const free = await occupy(0);
    await new Promise((resolve) => occupied.pop()!.close(resolve));
    const s = await serve(["--port", String(free)], {
      openUrl: () => Promise.reject(new Error("xdg-open not found")),
    });
    expect(s.port).toBe(free);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.err.join("\n")).toContain(`open this URL: http://127.0.0.1:${free}`);
    const res = await fetch(`http://127.0.0.1:${free}/`);
    expect(res.status).toBe(200);
    s.signals.emit("SIGTERM");
    expect(await s.done).toBe(0);
  });

  test("picks the platform opener", () => {
    expect(openCommand("darwin", "u")[0]).toBe("open");
    expect(openCommand("linux", "u")[0]).toBe("xdg-open");
    expect(openCommand("win32", "u")[0]).toBe("cmd");
  });
});

describe("signals", () => {
  test("SIGINT closes the server (even with an open keep-alive socket), prints stopped, exits 0", async () => {
    const free = await occupy(0);
    await new Promise((resolve) => occupied.pop()!.close(resolve));
    const s = await serve(["--port", String(free), "--no-open"]);
    const res = await fetch(`http://127.0.0.1:${free}/`, { headers: { Connection: "keep-alive" } });
    await res.text();
    s.signals.emit("SIGINT");
    expect(await s.done).toBe(0);
    expect(s.out).toContain("stopped");
    await expect(fetch(`http://127.0.0.1:${free}/`)).rejects.toThrow();
  });

  test("a second signal during shutdown is ignored, not left to the default handler", async () => {
    const free = await occupy(0);
    await new Promise((resolve) => occupied.pop()!.close(resolve));
    const s = await serve(["--port", String(free), "--no-open"]);
    s.signals.emit("SIGINT");
    // With no listener left, a real process would be killed by this second SIGINT.
    expect(s.signals.listenerCount("SIGINT")).toBeGreaterThan(0);
    s.signals.emit("SIGINT");
    s.signals.emit("SIGTERM");
    expect(await s.done).toBe(0);
    expect(s.out.filter((line) => line === "stopped")).toHaveLength(1);
    expect(s.signals.listenerCount("SIGINT")).toBe(0);
  });

  test("startup line has the version, URL and mode", async () => {
    const free = await occupy(0);
    await new Promise((resolve) => occupied.pop()!.close(resolve));
    const s = await serve(["--port", String(free), "--no-open"]);
    expect(s.out.slice(0, 3)).toEqual([
      "Synapse Horizon 9.9.9 (dist)",
      `listening on http://127.0.0.1:${free}/`,
      "[logs] watching nothing (SYNAPSE_LOG_ROOTS=none)",
    ]);
    s.signals.emit("SIGINT");
    await s.done;
  });
});

describe("[logs] lines (X3, G5, DX4)", () => {
  async function started(argv: string[], overrides: Partial<Io> = {}) {
    const s = await serve(["--no-open", ...argv], overrides);
    s.signals.emit("SIGINT");
    await s.done;
    return s.out.filter((line) => line.startsWith("[logs]"));
  }

  test("one line per root with its path and 24 h file count", async () => {
    const root = freshDir();
    writeFileSync(join(root, "a.jsonl"), "1\n");
    writeFileSync(join(root, "b.jsonl"), "1\n");
    expect(await started(["--log-root", root])).toEqual([
      `[logs] ${root}: 2 files modified in the last 24 h (flag)`,
    ]);
  });

  test("zero files adds the hint", async () => {
    const root = freshDir();
    const lines = await started(["--log-root", root]);
    expect(lines).toEqual([
      `[logs] ${root}: 0 files modified in the last 24 h (flag)`,
      "[logs] no Claude Code or Codex logs found in the last 24 h; start a session, or pass --log-root <dir>",
    ]);
  });

  test("a missing root: problem, fix and README anchor", async () => {
    const missing = join(scratch, "nope");
    const lines = await started(["--log-root", missing]);
    expect(lines[0]).toBe(
      `[logs] root not found: ${missing}; set --log-root or SYNAPSE_LOG_ROOTS (see README #configuration)`,
    );
  });

  test("--no-logs and SYNAPSE_LOG_ROOTS=none watch nothing", async () => {
    expect(await started(["--no-logs"])).toEqual(["[logs] watching nothing (--no-logs)"]);
    expect(await started([], { env: { SYNAPSE_LOG_ROOTS: "none" } })).toEqual([
      "[logs] watching nothing (SYNAPSE_LOG_ROOTS=none)",
    ]);
  });

  test("the inotify limit: names ENOSPC, the polling fallback and the sysctl fix", async () => {
    const root = freshDir();
    writeFileSync(join(root, "a.jsonl"), "1\n");
    const lines = await started(["--log-root", root], {
      logOptions: {
        watch: {
          watch: () => {
            throw Object.assign(new Error("ENOSPC: no space"), { code: "ENOSPC" });
          },
        },
      },
    });
    expect(lines[0]).toBe(
      `[logs] cannot watch ${root}: inotify watch limit reached (ENOSPC); polling every 5 s instead. Raise it with: sudo sysctl fs.inotify.max_user_watches=524288 (see README #configuration)`,
    );
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an unreadable file: EACCES, skipped, check the owner",
    async () => {
      const root = freshDir();
      const locked = join(root, "locked.jsonl");
      writeFileSync(locked, "1\n");
      chmodSync(locked, 0o000);
      const s = await serve(["--no-open", "--log-root", root]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      s.signals.emit("SIGINT");
      await s.done;
      chmodSync(locked, 0o600);
      expect(s.out).toContain(
        `[logs] permission denied (EACCES) reading ${locked}; skipped. Check the file's owner (see README #configuration)`,
      );
    },
  );

  test("the env var and the config file feed the same resolver", async () => {
    const root = freshDir();
    expect(await started([], { env: { SYNAPSE_LOG_ROOTS: root } })).toEqual([
      `[logs] ${root}: 0 files modified in the last 24 h (env)`,
      expect.stringContaining("no Claude Code or Codex logs found"),
    ]);
    const fromConfig = await started([], {
      env: {},
      readConfig: () => JSON.stringify({ logRoots: [root] }),
    });
    expect(fromConfig[0]).toBe(`[logs] ${root}: 0 files modified in the last 24 h (config)`);
  });
});

describe("log server in the binary", () => {
  test("SIGINT closes open WebSocket clients, then exits 0", async () => {
    const root = freshDir();
    writeFileSync(join(root, "a.jsonl"), "1\n2\n");
    const s = await serve(["--no-open", "--log-root", root]);
    const html = await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
    const token = /name="synapse-token" content="([^"]+)"/.exec(html)![1];
    const messages: unknown[] = [];
    const ws = new WebSocketClient(`ws://127.0.0.1:${s.port}/api/stream`);
    ws.on("message", (data) => messages.push(JSON.parse((data as Buffer).toString())));
    await new Promise((resolve) => ws.on("open", resolve));
    ws.send(JSON.stringify({ type: "hello", token, cursors: [] }));
    const closed = new Promise<number>((resolve) => ws.on("close", resolve));
    const started = Date.now();
    while (!messages.some((m) => (m as { type: string }).type === "lines")) {
      if (Date.now() - started > 3000) throw new Error("no lines message");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    s.signals.emit("SIGINT");
    expect(await s.done).toBe(0);
    expect(await closed).toBe(1001);
  });
});
