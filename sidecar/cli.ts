import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { join } from "node:path";
import { loadAssets, type AssetMode } from "./assets.ts";
import { createServer, type AssetMap } from "./server.ts";

// Replaced with the package.json version by esbuild `define` at bundle time.
declare const __CLI_VERSION__: string;

export const DEFAULT_PORT = 7317;
export const HOST = "127.0.0.1";
const EXTRA_PORTS = 10;

const USAGE = `Usage: synapse-horizon [options]

Options:
  --port <n>   port to listen on, 1-65535 (default ${DEFAULT_PORT})
  --no-open    do not open the browser
  --version    print the version and exit
  --help       show this help
`;

export class UsageError extends Error {}

export interface Options {
  port: number;
  open: boolean;
  version: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { port: DEFAULT_PORT, open: true, version: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--" && i === 0) continue;
    if (arg === "--no-open") options.open = false;
    else if (arg === "--version") options.version = true;
    else if (arg === "--help") options.help = true;
    else if (arg === "--port" || arg.startsWith("--port=")) {
      const value = arg === "--port" ? argv[++i] : arg.slice("--port=".length);
      if (
        value === undefined ||
        !/^\d+$/.test(value) ||
        Number(value) < 1 ||
        Number(value) > 65535
      ) {
        throw new UsageError(`--port must be a number from 1 to 65535, got ${value ?? "nothing"}`);
      }
      options.port = Number(value);
    } else throw new UsageError(`unknown flag ${arg}`);
  }
  return options;
}

export function openCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

function openBrowser(url: string): Promise<void> {
  const [command, args] = openCommand(process.platform, url);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`)),
    );
    child.unref();
  });
}

export interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  loadAssets: () => { assets: AssetMap; mode: AssetMode };
  openUrl: (url: string) => Promise<void>;
  createServer: typeof createServer;
  /** Where SIGINT and SIGTERM are heard. */
  signals: Pick<EventEmitter, "on" | "off">;
  version: string;
  onListening?: (port: number) => void;
}

export function defaultIo(): Io {
  return {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
    loadAssets: () => loadAssets(join(process.cwd(), "dist")),
    openUrl: openBrowser,
    createServer,
    signals: process,
    version: typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "dev",
  };
}

type ListenResult =
  | { kind: "listening"; server: Server; port: number }
  | { kind: "exhausted" }
  | { kind: "failed"; port: number; code: string | undefined; message: string };

/** Tries `first` and then the next ten ports; busy is detected from the listen error only. */
async function listenWithRetry(first: number, assets: AssetMap, io: Io): Promise<ListenResult> {
  for (let port = first; port <= Math.min(65535, first + EXTRA_PORTS); port++) {
    const server = io.createServer({ port, assets, log: io.stderr });
    const error = await new Promise<NodeJS.ErrnoException | undefined>((resolve) => {
      server.once("error", resolve);
      server.listen(port, HOST, () => {
        server.removeListener("error", resolve);
        resolve(undefined);
      });
    });
    if (error === undefined) return { kind: "listening", server, port };
    if (error.code === "EADDRINUSE") {
      const next = port + 1;
      if (port < first + EXTRA_PORTS && next <= 65535) io.stdout(`${port} busy, using ${next}`);
      continue;
    }
    return { kind: "failed", port, code: error.code, message: error.message };
  }
  return { kind: "exhausted" };
}

/** Runs the CLI. Resolves with the process exit code: after a signal when serving. */
export async function run(argv: string[], io: Io = defaultIo()): Promise<number> {
  let options: Options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (options.version) {
    io.stdout(io.version);
    return 0;
  }

  const { assets, mode } = io.loadAssets();
  if (!assets.has("/index.html")) {
    io.stderr("build is incomplete: index.html missing");
    return 1;
  }

  const result = await listenWithRetry(options.port, assets, io);
  if (result.kind === "exhausted") {
    io.stderr(
      `ports ${options.port}-${Math.min(65535, options.port + EXTRA_PORTS)} busy; use --port`,
    );
    return 1;
  }
  if (result.kind === "failed") {
    io.stderr(
      result.code === "EACCES"
        ? `no permission for port ${result.port}`
        : `could not listen on port ${result.port}: ${result.message}`,
    );
    return 1;
  }

  const { server, port } = result;
  const url = `http://${HOST}:${port}`;
  io.stdout(`Synapse Horizon ${io.version} (${mode}) at ${url}`);
  io.onListening?.(port);

  const stopped = new Promise<number>((resolve) => {
    // Handlers stay attached until shutdown finishes: a second signal (e.g. Ctrl-C delivered
    // to both `vp run serve` and this child) must be ignored, not fall through to Node's
    // default handler, which would kill the process mid-shutdown.
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.close(() => {
        io.signals.off("SIGINT", stop);
        io.signals.off("SIGTERM", stop);
        io.stdout("stopped");
        resolve(0);
      });
      server.closeAllConnections();
    };
    io.signals.on("SIGINT", stop);
    io.signals.on("SIGTERM", stop);
  });

  if (options.open) {
    try {
      await io.openUrl(url);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      io.stderr(`could not open a browser (${reason}); open this URL: ${url}`);
    }
  }
  return stopped;
}
