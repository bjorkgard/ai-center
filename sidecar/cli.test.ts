import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { loadDiskAssets } from "./assets.ts";
import { openCommand, parseArgs, run, UsageError, type Io } from "./cli.ts";
import { createServer, type AssetMap } from "./server.ts";

const assets: AssetMap = new Map([
  [
    "/index.html",
    { bytes: Buffer.from("<title>Synapse Horizon</title>"), contentType: "text/html" },
  ],
]);

const occupied: Server[] = [];

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

  test("startup line has the version, URL and mode", async () => {
    const free = await occupy(0);
    await new Promise((resolve) => occupied.pop()!.close(resolve));
    const s = await serve(["--port", String(free), "--no-open"]);
    expect(s.out[0]).toBe(`Synapse Horizon 9.9.9 (dist) at http://127.0.0.1:${free}`);
    s.signals.emit("SIGINT");
    await s.done;
  });
});
