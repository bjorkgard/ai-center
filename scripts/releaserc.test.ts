import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, test } from "vite-plus/test";

type PluginEntry = string | [string, Record<string, unknown>];

const config = JSON.parse(readFileSync(new URL("../.releaserc.json", import.meta.url), "utf8")) as {
  branches: string[];
  plugins: PluginEntry[];
};

const names = config.plugins.map((plugin) => (typeof plugin === "string" ? plugin : plugin[0]));

function options(name: string): Record<string, unknown> {
  const entry = config.plugins.find(
    (plugin) => (typeof plugin === "string" ? plugin : plugin[0]) === name,
  );
  return Array.isArray(entry) ? entry[1] : {};
}

describe(".releaserc.json", () => {
  test("releases from main only", () => {
    expect(config.branches).toEqual(["main"]);
  });

  test("lists the plugins in order", () => {
    expect(names).toEqual([
      "@semantic-release/commit-analyzer",
      "@semantic-release/release-notes-generator",
      "@semantic-release/changelog",
      "@semantic-release/npm",
      "@semantic-release/git",
      "@semantic-release/github",
      "@semantic-release/exec",
    ]);
  });

  test("bumps the version without publishing to npm", () => {
    expect(options("@semantic-release/npm").npmPublish).toBe(false);
  });

  test("commits package.json and CHANGELOG.md with a skip-ci message", () => {
    const git = options("@semantic-release/git");
    expect(git.assets).toEqual(["package.json", "CHANGELOG.md"]);
    expect(git.message).toBe("chore(release): ${nextRelease.version} [skip ci]");
  });

  test("resolves every plugin", () => {
    const require = createRequire(import.meta.url);
    const semanticRelease = require.resolve("semantic-release");
    const fromSemanticRelease = createRequire(semanticRelease);
    for (const name of names) {
      const resolves = () => {
        try {
          require.resolve(name);
          return true;
        } catch {
          fromSemanticRelease.resolve(name);
          return true;
        }
      };
      expect(resolves, name).not.toThrow();
    }
  });

  test("the exec successCmd writes published and version to GITHUB_OUTPUT", () => {
    const template = String(options("@semantic-release/exec").successCmd);
    // semantic-release substitutes ${nextRelease.version} (lodash template) before running in sh.
    const successCmd = template.replace("${nextRelease.version}", "1.2.3");
    const dir = mkdtempSync(join(tmpdir(), "releaserc-"));
    try {
      const output = join(dir, "out");
      execFileSync("sh", ["-c", successCmd], { env: { ...process.env, GITHUB_OUTPUT: output } });
      expect(readFileSync(output, "utf8").split("\n").filter(Boolean)).toEqual([
        "published=true",
        "version=1.2.3",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
