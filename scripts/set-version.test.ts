import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { setVersion } from "./set-version.ts";

const source = new URL("../package.json", import.meta.url);
const script = new URL("./set-version.ts", import.meta.url).pathname;

function withCopy(run: (file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "set-version-"));
  try {
    const file = join(dir, "package.json");
    copyFileSync(source, file);
    run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("setVersion", () => {
  test("updates the version and leaves every other byte alone", () => {
    withCopy((file) => {
      const before = readFileSync(file, "utf8");
      setVersion("9.9.9", file);
      const after = readFileSync(file, "utf8");
      expect((JSON.parse(after) as { version: string }).version).toBe("9.9.9");
      expect(after.replace('"version": "9.9.9"', "")).toBe(
        before.replace(/"version": "[^"]*"/, ""),
      );
    });
  });

  test("accepts a prerelease version", () => {
    withCopy((file) => {
      setVersion("1.0.0-beta.1", file);
      expect((JSON.parse(readFileSync(file, "utf8")) as { version: string }).version).toBe(
        "1.0.0-beta.1",
      );
    });
  });

  test.each(["abc", "", "1.2"])("rejects %j", (bad) => {
    withCopy((file) => {
      const before = readFileSync(file, "utf8");
      expect(() => setVersion(bad, file)).toThrow();
      expect(readFileSync(file, "utf8")).toBe(before);
    });
  });
});

describe("set-version CLI", () => {
  test("exits 0 and writes the version", () => {
    withCopy((file) => {
      execFileSync("node", [script, "9.9.9", file]);
      expect((JSON.parse(readFileSync(file, "utf8")) as { version: string }).version).toBe("9.9.9");
    });
  });

  test("exits 1 on bad input", () => {
    withCopy((file) => {
      const result = spawnSync("node", [script, "bad", file], { encoding: "utf8" });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("bad");
    });
  });
});
