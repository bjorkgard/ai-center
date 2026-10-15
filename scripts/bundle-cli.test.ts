import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { expect, test } from "vite-plus/test";
import { bundleCli, EXTERNAL } from "./bundle-cli.ts";

const OPTIONAL = new Set(["bufferutil", "utf-8-validate"]);
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

test("the CLI bundle has no unresolved require besides ws's two optional native add-ons", async () => {
  // ws loads both in a try/catch and falls back to its JS paths when they are missing.
  expect([...EXTERNAL].sort()).toEqual([...OPTIONAL].sort());
  const bundle = readFileSync(await bundleCli(), "utf8");
  const required = new Set(
    [...bundle.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((match) =>
      match[1].replace(/^node:/, ""),
    ),
  );
  const unresolved = [...required].filter((name) => !BUILTINS.has(name.split("/")[0]));
  expect(unresolved.sort()).toEqual([...OPTIONAL].sort());
  // ws is bundled, not left to be resolved at run time.
  expect(bundle).toContain("WebSocketServer");
  expect(required.has("ws")).toBe(false);
}, 30_000);
