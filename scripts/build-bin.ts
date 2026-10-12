import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleCli, workDir } from "./bundle-cli.ts";

const SENTINEL_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const BLOB_KEY = "NODE_SEA_BLOB";
const MANIFEST_KEY = "__manifest__.json";
const RETRY_DELAYS_MS = [1000, 2000, 4000];

export class FetchError extends Error {}
export class ChecksumMismatch extends Error {}
export class ToolFailed extends Error {}

export interface RunResult {
  status: number | null;
  stderr: string;
  error?: Error;
}
export type RunTool = (command: string, args: string[]) => RunResult;
export type Fetch = (
  url: string,
) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export const runTool: RunTool = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr ?? "", error: result.error };
};

/** Runs one build step; a missing tool or non-zero exit throws ToolFailed naming the step. */
export function step(name: string, run: RunTool, command: string, args: string[]): void {
  const result = run(command, args);
  if (result.error || result.status !== 0) {
    const why = result.error ? result.error.message : `exit ${result.status}`;
    throw new ToolFailed(`build step "${name}" failed (${command}: ${why})\n${result.stderr}`);
  }
}

/** GET with 3 retries (1s, 2s, 4s) on network errors and 5xx; other statuses fail at once. */
export async function fetchBytes(
  url: string,
  fetchFn: Fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Buffer> {
  let lastError = "";
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      const res = await fetchFn(url);
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastError = `HTTP ${res.status}`;
      if (res.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new FetchError(`could not fetch ${url}: ${lastError}`);
}

export function nodeTarget(platform: NodeJS.Platform, arch: string) {
  const os = platform === "win32" ? "win" : platform;
  const windows = platform === "win32";
  return { os, arch, windows, ext: windows ? "zip" : "tar.gz" };
}

export function expectedHash(shasums: string, file: string): string | undefined {
  for (const line of shasums.split("\n")) {
    const [hash, name] = line.trim().split(/\s+/);
    if (name === file) return hash;
  }
  return undefined;
}

/** Downloads the official Node archive, verifies it against SHASUMS256.txt and returns its path. */
export async function downloadNodeArchive(opts: {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  cacheDir: string;
  fetchFn: Fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ archive: string; dirName: string; windows: boolean }> {
  const { os, arch, windows, ext } = nodeTarget(opts.platform, opts.arch);
  const dirName = `node-v${opts.version}-${os}-${arch}`;
  const file = `${dirName}.${ext}`;
  const base = `https://nodejs.org/dist/v${opts.version}`;
  const archive = join(opts.cacheDir, file);
  mkdirSync(opts.cacheDir, { recursive: true });

  const shasums = (await fetchBytes(`${base}/SHASUMS256.txt`, opts.fetchFn, opts.sleep)).toString(
    "utf8",
  );
  const expected = expectedHash(shasums, file);
  if (!expected) throw new FetchError(`${file} not listed in ${base}/SHASUMS256.txt`);

  if (!existsSync(archive)) {
    writeFileSync(archive, await fetchBytes(`${base}/${file}`, opts.fetchFn, opts.sleep));
  }
  const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (actual !== expected) {
    rmSync(archive, { force: true });
    throw new ChecksumMismatch(
      `checksum mismatch for ${file}\nexpected ${expected}\nactual   ${actual}`,
    );
  }
  return { archive, dirName, windows };
}

/** Always re-extracts from the verified archive, so a tampered earlier extract is never reused. */
export function extractNode(
  archive: string,
  member: string,
  cacheDir: string,
  run: RunTool,
): string {
  const binary = join(cacheDir, member);
  rmSync(binary, { force: true });
  step("extract node", run, "tar", ["-xf", archive, "-C", cacheDir, member]);
  return binary;
}

function listFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

async function main(): Promise<void> {
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const nodeVersion = readFileSync(".node-version", "utf8").trim();
  const { os, arch, windows } = nodeTarget(process.platform, process.arch);
  const target = `${os}-${arch}`;

  step("vp build", runTool, "vp", ["build"]);
  const bundle = await bundleCli();

  const keys = listFiles("dist");
  if (!keys.includes("index.html")) throw new Error("dist/index.html missing after vp build");
  const manifest = join(workDir, MANIFEST_KEY);
  writeFileSync(manifest, JSON.stringify(keys));
  const seaConfig = join(workDir, "sea-config.json");
  const blob = join(workDir, "sea-prep.blob");
  writeFileSync(
    seaConfig,
    JSON.stringify(
      {
        main: bundle,
        output: blob,
        disableExperimentalSEAWarning: true,
        assets: {
          ...Object.fromEntries(keys.map((key) => [key, resolve("dist", key)])),
          [MANIFEST_KEY]: manifest,
        },
      },
      null,
      2,
    ),
  );

  const cacheDir = join(workDir, "node");
  const { archive, dirName } = await downloadNodeArchive({
    version: nodeVersion,
    platform: process.platform,
    arch: process.arch,
    cacheDir,
    fetchFn: fetch,
  });
  const member = windows ? `${dirName}/node.exe` : `${dirName}/bin/node`;
  const officialNode = extractNode(archive, member, cacheDir, runTool);

  // The blob is made by the official binary (never the local node), before its signature is touched.
  step("generate SEA blob", runTool, officialNode, ["--experimental-sea-config", seaConfig]);

  mkdirSync("bin", { recursive: true });
  const output = resolve("bin", `synapse-horizon-${version}-${target}${windows ? ".exe" : ""}`);
  rmSync(output, { force: true });
  copyFileSync(officialNode, output);
  chmodSync(output, 0o755);

  const mac = process.platform === "darwin";
  if (mac) step("codesign --remove-signature", runTool, "codesign", ["--remove-signature", output]);
  const postject = createRequire(import.meta.url).resolve("postject/dist/cli.js");
  step("postject", runTool, process.execPath, [
    postject,
    output,
    BLOB_KEY,
    blob,
    "--sentinel-fuse",
    SENTINEL_FUSE,
    ...(mac ? ["--macho-segment-name", "NODE_SEA"] : []),
  ]);
  if (mac) step("codesign --sign -", runTool, "codesign", ["--sign", "-", output]);
  console.log(`built ${output}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
