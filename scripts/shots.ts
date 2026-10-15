import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "@playwright/test";
import sharp from "sharp";
import { maxBytes, viewport, viewUrl, views } from "./shots.config.ts";

export class ShotFailed extends Error {}

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(true));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(false)));
  });
}

export function checkBuildIdentity(base: string, html: string, want: string): void {
  const meta = html.match(/<meta[^>]*name="app-version"[^>]*content="([^"]*)"/)?.[1];
  if (meta !== want || !html.includes("<title>Synapse Horizon</title>")) {
    throw new ShotFailed(
      `${base} is not this build (app-version ${meta ?? "missing"}, want ${want})`,
    );
  }
}

export function checkConsole(name: string, errors: string[]): void {
  if (errors.length > 0) throw new ShotFailed(`view ${name}: console error: ${errors[0]}`);
}

export function checkSize(name: string, png: Buffer): void {
  if (png.length > maxBytes) {
    throw new ShotFailed(`view ${name}: ${png.length} bytes > ${maxBytes} bytes`);
  }
}

export async function ensurePortFree(port: number): Promise<void> {
  if (await portInUse(port)) throw new ShotFailed(`port ${port} is already in use`);
}

async function waitForServer(base: string, exited: () => string | undefined): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const early = exited();
    if (early) throw new ShotFailed(`preview server exited early: ${early}`);
    try {
      const res = await fetch(base);
      if (res.ok) {
        checkBuildIdentity(base, await res.text(), version);
        return;
      }
    } catch (err) {
      if (err instanceof ShotFailed) throw err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new ShotFailed(`preview server did not start at ${base}`);
}

async function main(): Promise<void> {
  const port = process.env.SHOTS_PORT ? Number(process.env.SHOTS_PORT) : await freePort();
  await ensurePortFree(port);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(
    "vp",
    ["preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
      // The log server must not watch the real home directory.
      env: { ...process.env, SYNAPSE_LOG_ROOTS: "none" },
    },
  );
  let stderr = "";
  let exitMsg: string | undefined;
  server.stderr.on("data", (d) => (stderr += d));
  server.on("exit", (code) => (exitMsg = `code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
  const stopServer = () => {
    try {
      process.kill(-server.pid!, "SIGTERM");
    } catch {
      // already gone
    }
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stopServer();
      process.exit(130);
    });
  }
  let browser: Browser | undefined;
  const out: { file: string; png: Buffer }[] = [];
  try {
    await waitForServer(base, () => exitMsg);
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport });
    for (const { name, file, ready, query, setup, settled } of views) {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(msg.text());
      });
      page.on("pageerror", (err) => errors.push(err.message));
      await page.goto(viewUrl(base, name, query));
      await page.evaluate("document.fonts.ready");
      await page.waitForFunction(ready, undefined, { timeout: 30_000 });
      if (setup) {
        await page.evaluate(setup);
        if (settled) await page.waitForFunction(settled, undefined, { timeout: 30_000 });
      }
      const raw = await page.screenshot();
      await page.close();
      checkConsole(name, errors);
      // No dithering: it stipples flat faces. Quality 100 keeps bloom gradients from banding.
      const png = await sharp(raw)
        .png({ palette: true, quality: 100, effort: 10, dither: 0 })
        .toBuffer();
      checkSize(name, png);
      out.push({ file, png });
    }
    for (const { file, png } of out) {
      writeFileSync(file, png);
      console.log(`${file}: ${png.length} bytes`);
    }
  } finally {
    await browser?.close();
    stopServer();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof ShotFailed ? `ShotFailed: ${err.message}` : err);
    process.exit(1);
  });
}
