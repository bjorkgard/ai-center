import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { CONFIG_EXAMPLE, configPathFor, resolveRoots, type RootsInput } from "./roots.ts";

const enoent = () => {
  throw Object.assign(new Error("no such file"), { code: "ENOENT" });
};

function input(over: Partial<RootsInput> = {}): RootsInput {
  return {
    flags: [],
    noLogs: false,
    env: {},
    platform: "linux",
    homedir: "/home/u",
    cwd: "/work",
    readConfig: enoent,
    ...over,
  };
}

const paths = (r: ReturnType<typeof resolveRoots>) =>
  r.kind === "roots" ? r.roots.map((root) => root.path) : r;
const sources = (r: ReturnType<typeof resolveRoots>) =>
  r.kind === "roots" ? r.roots.map((root) => root.source) : r;

describe("defaults per OS", () => {
  test.each([
    ["linux", "/home/u", "/home/u/.claude/projects", "/home/u/.codex/sessions"],
    ["darwin", "/Users/u", "/Users/u/.claude/projects", "/Users/u/.codex/sessions"],
    ["win32", "C:\\Users\\u", "C:\\Users\\u\\.claude\\projects", "C:\\Users\\u\\.codex\\sessions"],
  ] as const)("%s uses os.homedir()", (platform, homedir, claude, codex) => {
    const result = resolveRoots(input({ platform, homedir }));
    expect(paths(result)).toEqual([claude, codex]);
    expect(sources(result)).toEqual(["default", "default"]);
  });

  test("CLAUDE_CONFIG_DIR and CODEX_HOME override the defaults", () => {
    const result = resolveRoots(input({ env: { CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" } }));
    expect(paths(result)).toEqual(["/c/projects", "/x/sessions"]);
  });
});

describe("config path per OS", () => {
  test("XDG_CONFIG_HOME wins, else ~/.config", () => {
    expect(configPathFor({}, "linux", "/home/u")).toBe(
      "/home/u/.config/synapse-horizon/config.json",
    );
    expect(configPathFor({ XDG_CONFIG_HOME: "/x" }, "darwin", "/Users/u")).toBe(
      "/x/synapse-horizon/config.json",
    );
  });

  test("Windows uses %APPDATA%, falling back to AppData\\Roaming", () => {
    expect(
      configPathFor({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u"),
    ).toBe("C:\\Users\\u\\AppData\\Roaming\\synapse-horizon\\config.json");
    expect(configPathFor({}, "win32", "C:\\Users\\u")).toBe(
      "C:\\Users\\u\\AppData\\Roaming\\synapse-horizon\\config.json",
    );
  });
});

describe("precedence: first non-empty source wins, sources never merge", () => {
  const config = () => JSON.stringify({ logRoots: ["/from/config"] });

  test("flag plus env gives only the flag roots", () => {
    const result = resolveRoots(
      input({ flags: ["/from/flag"], env: { SYNAPSE_LOG_ROOTS: "/from/env" }, readConfig: config }),
    );
    expect(paths(result)).toEqual(["/from/flag"]);
    expect(sources(result)).toEqual(["flag"]);
  });

  test("env plus config gives only the env roots, split on the OS delimiter", () => {
    const posix = resolveRoots(input({ env: { SYNAPSE_LOG_ROOTS: "/a:/b" }, readConfig: config }));
    expect(paths(posix)).toEqual(["/a", "/b"]);
    expect(sources(posix)).toEqual(["env", "env"]);
    const win = resolveRoots(
      input({
        platform: "win32",
        homedir: "C:\\Users\\u",
        env: { SYNAPSE_LOG_ROOTS: "C:\\a;D:\\b" },
        readConfig: config,
      }),
    );
    expect(paths(win)).toEqual(["C:\\a", "D:\\b"]);
  });

  test("config applies when flags and env are empty; an empty env string is empty", () => {
    const result = resolveRoots(input({ env: { SYNAPSE_LOG_ROOTS: "" }, readConfig: config }));
    expect(paths(result)).toEqual(["/from/config"]);
    expect(sources(result)).toEqual(["config"]);
  });

  test("an empty logRoots list or a missing key falls through to the defaults", () => {
    expect(paths(resolveRoots(input({ readConfig: () => '{"logRoots":[]}' })))).toEqual([
      "/home/u/.claude/projects",
      "/home/u/.codex/sessions",
    ]);
    expect(sources(resolveRoots(input({ readConfig: () => "{}" })))).toEqual([
      "default",
      "default",
    ]);
  });

  test("relative flag roots resolve against the working directory", () => {
    expect(paths(resolveRoots(input({ flags: ["logs/x"] })))).toEqual(["/work/logs/x"]);
  });
});

describe("config errors never fall back to the defaults", () => {
  test.each([
    ["invalid JSON", () => "{nope"],
    ["wrong type for the file", () => "[]"],
    ["wrong type for logRoots", () => '{"logRoots":"/a"}'],
    ["a non-string entry", () => '{"logRoots":["/a",3]}'],
    [
      "an unreadable file",
      () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    ],
  ])("%s is an error naming the config path", (_name, readConfig) => {
    const result = resolveRoots(input({ readConfig }));
    expect(result).toMatchObject({
      kind: "error",
      configPath: "/home/u/.config/synapse-horizon/config.json",
    });
    expect((result as { message: string }).message.length).toBeGreaterThan(5);
  });

  test("flags or env make the config file irrelevant, even a broken one", () => {
    const broken = () => "{nope";
    expect(resolveRoots(input({ flags: ["/a"], readConfig: broken })).kind).toBe("roots");
    expect(resolveRoots(input({ env: { SYNAPSE_LOG_ROOTS: "/a" }, readConfig: broken })).kind).toBe(
      "roots",
    );
  });
});

describe("config.example.json", () => {
  test("is a valid config file, matches the example the CLI prints, and README links it", () => {
    const text = readFileSync("config.example.json", "utf8");
    const result = resolveRoots(input({ readConfig: () => text }));
    expect(result).toEqual({
      kind: "roots",
      roots: [
        { path: "/home/you/.claude/projects", source: "config" },
        { path: "/home/you/.codex/sessions", source: "config" },
      ],
    });
    expect(text).toBe(CONFIG_EXAMPLE);
    expect(readFileSync("README.md", "utf8")).toMatch(/^## Configuration$/m);
    expect(readFileSync("README.md", "utf8")).toContain("(config.example.json)");
  });
});

describe("watching nothing", () => {
  test("--no-logs wins over everything", () => {
    expect(resolveRoots(input({ noLogs: true, flags: ["/a"] }))).toEqual({
      kind: "none",
      reason: "--no-logs",
    });
  });

  test("SYNAPSE_LOG_ROOTS=none watches nothing unless flags are given", () => {
    expect(resolveRoots(input({ env: { SYNAPSE_LOG_ROOTS: "none" } }))).toEqual({
      kind: "none",
      reason: "SYNAPSE_LOG_ROOTS=none",
    });
    expect(
      paths(resolveRoots(input({ flags: ["none"], env: { SYNAPSE_LOG_ROOTS: "none" } }))),
    ).toEqual(["/work/none"]);
  });
});
