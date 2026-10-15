import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { posix, win32 } from "node:path";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { homeLabel } from "./home-label.ts";

describe("homeLabel is separator-aware", () => {
  test("Windows: a path under the home directory becomes ~ with backslashes", () => {
    const home = "C:\\Users\\Alice";
    expect(homeLabel("C:\\Users\\Alice\\.claude\\projects", home, win32)).toBe(
      "~\\.claude\\projects",
    );
    expect(homeLabel("C:\\Users\\Alice", home, win32)).toBe("~");
    expect(homeLabel("c:\\users\\alice\\x", home, win32)).toBe("~\\x");
    expect(homeLabel("C:/Users/Alice/x", home, win32)).toBe("~\\x");
  });

  test("Windows: a sibling that merely starts with the same letters is not home", () => {
    expect(homeLabel("C:\\Users\\Alice2\\x", "C:\\Users\\Alice", win32)).toBe(
      "C:\\Users\\Alice2\\x",
    );
    expect(homeLabel("D:\\Users\\Alice\\x", "C:\\Users\\Alice", win32)).toBe("D:\\Users\\Alice\\x");
  });

  test("POSIX: the same rules with slashes", () => {
    expect(homeLabel("/home/a/.claude", "/home/a", posix)).toBe("~/.claude");
    expect(homeLabel("/home/a", "/home/a", posix)).toBe("~");
    expect(homeLabel("/home/ab/x", "/home/a", posix)).toBe("/home/ab/x");
    expect(homeLabel("/home/a/../b/x", "/home/a", posix)).toBe("/home/a/../b/x");
  });

  test("a home directory with a trailing separator works", () => {
    expect(homeLabel("C:\\Users\\Alice\\x", "C:\\Users\\Alice\\", win32)).toBe("~\\x");
    expect(homeLabel("/home/a/x", "/home/a/", posix)).toBe("~/x");
  });

  test("an empty or root home never rewrites everything", () => {
    expect(homeLabel("/etc/x", "/", posix)).toBe("/etc/x");
    expect(homeLabel("/etc/x", "", posix)).toBe("/etc/x");
  });
});

describe("the probe uses it in text and --json", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "home-label-")));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, ".claude", "projects");
  mkdirSync(root, { recursive: true });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/logs-probe.ts", "--log-root", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: dir, USERPROFILE: dir },
    });

  test("text", () => {
    const out = run().stdout;
    expect(out).toContain("root ~/.claude/projects");
    expect(out).not.toContain(dir);
  });

  test("json", () => {
    const out = run("--json").stdout;
    expect((JSON.parse(out) as { root: string }[])[0].root).toBe("~/.claude/projects");
    expect(out).not.toContain(dir);
  });
});
