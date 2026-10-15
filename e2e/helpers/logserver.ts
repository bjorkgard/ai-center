import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

// The webServer of the logserver Playwright project: waits until the main webServer has built
// dist/ and serves it, empties the watched directory, then previews the same build on its own
// port. Usage: node e2e/helpers/logserver.ts <main server url> <port>
const [, , mainUrl, port] = process.argv;
const root = process.env.SYNAPSE_LOG_ROOTS;
if (!mainUrl || !port || !root || root === "none") {
  console.error("usage: SYNAPSE_LOG_ROOTS=<dir> node e2e/helpers/logserver.ts <main url> <port>");
  process.exit(2);
}

async function ready(url: string): Promise<void> {
  for (let i = 0; i < 1200; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`${url} never came up`);
}

await ready(mainUrl);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const child = spawn("vp", ["preview", "--host", "127.0.0.1", "--port", port, "--strictPort"], {
  stdio: "inherit",
  env: process.env,
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
