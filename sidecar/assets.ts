import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAsset, isSea } from "node:sea";
import { contentTypeFor, type AssetMap } from "./server.ts";

/** SEA asset holding the JSON list of embedded asset keys; written by scripts/build-bin.ts. */
export const MANIFEST_KEY = "__manifest__.json";

export type AssetMode = "sea" | "dist";

function walk(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walk(join(dir, entry.name), rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/** Reads every file under `distDir` into memory. A missing directory yields an empty map. */
export function loadDiskAssets(distDir: string): AssetMap {
  const keys: string[] = [];
  try {
    walk(distDir, "", keys);
  } catch {
    return new Map();
  }
  const assets: AssetMap = new Map();
  for (const key of keys) {
    const urlPath = `/${key}`;
    assets.set(urlPath, {
      bytes: readFileSync(join(distDir, key)),
      contentType: contentTypeFor(urlPath),
    });
  }
  return assets;
}

/** Reads the embedded assets named by the manifest asset. Only valid when `isSea()` is true. */
export function loadSeaAssets(): AssetMap {
  const keys = JSON.parse(Buffer.from(getAsset(MANIFEST_KEY)).toString("utf8")) as string[];
  const assets: AssetMap = new Map();
  for (const key of keys) {
    const urlPath = `/${key}`;
    assets.set(urlPath, {
      bytes: new Uint8Array(getAsset(key)),
      contentType: contentTypeFor(urlPath),
    });
  }
  return assets;
}

export function loadAssets(distDir: string): { assets: AssetMap; mode: AssetMode } {
  return isSea()
    ? { assets: loadSeaAssets(), mode: "sea" }
    : { assets: loadDiskAssets(distDir), mode: "dist" };
}
