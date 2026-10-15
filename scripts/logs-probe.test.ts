import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";

const dir = mkdtempSync(join(tmpdir(), "logs-probe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Values that must never show up in probe output, planted in every place a log can hold text.
const VALUES = [
  "SECRETPROMPTTEXT",
  "/Users/planted/proj",
  "https://example.invalid/leak",
  "PLANTEDBRANCH",
  "SECRETCOMMANDTEXT",
  "9f8e7d6c5b4a39281706f5e4d3c2b1a0",
  "planted-session-id-1234",
  "toolu_01PLANTEDTOOLID",
  "secret-file-name.txt",
  "PLANTEDMODEL",
];

const root = join(dir, "claude");
mkdirSync(join(root, "-proj"), { recursive: true });
const lines = [
  {
    type: "user",
    version: "2.1.999",
    sessionId: "planted-session-id-1234",
    cwd: "/Users/planted/proj",
    gitBranch: "PLANTEDBRANCH",
    timestamp: "2026-10-14T08:00:00.000Z",
    message: { role: "user", content: "SECRETPROMPTTEXT https://example.invalid/leak" },
  },
  {
    type: "assistant",
    version: "2.1.999",
    sessionId: "planted-session-id-1234",
    cwd: "/Users/planted/proj",
    timestamp: "2026-10-14T08:00:01.000Z",
    message: {
      id: "msg_01PLANTED",
      model: "PLANTEDMODEL",
      role: "assistant",
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5 },
      content: [
        { type: "text", text: "SECRETPROMPTTEXT" },
        {
          type: "tool_use",
          id: "toolu_01PLANTEDTOOLID",
          name: "Bash",
          input: { command: "SECRETCOMMANDTEXT 9f8e7d6c5b4a39281706f5e4d3c2b1a0" },
        },
      ],
    },
  },
  {
    type: "user",
    version: "2.1.999",
    sessionId: "planted-session-id-1234",
    cwd: "/Users/planted/proj",
    timestamp: "2026-10-14T08:00:02.000Z",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_01PLANTEDTOOLID",
          content: "SECRETPROMPTTEXT",
          is_error: true,
        },
      ],
    },
  },
  {
    type: "file-history-snapshot",
    snapshot: { trackedFileBackups: { "secret-file-name.txt": { version: 1 } } },
    byId: { toolu_01PLANTEDTOOLID: { cwd: "/Users/planted/proj" } },
  },
  {
    type: "SomeVeryLongMixedCase12345TypeNameThatLooksLikeAnId",
    version: "not a version SECRETPROMPTTEXT",
  },
];
writeFileSync(
  join(root, "-proj", "s.jsonl"),
  lines.map((l) => JSON.stringify(l)).join("\n") + "\n{broken SECRETPROMPTTEXT\n",
);
writeFileSync(
  join(root, "-proj", "s.meta.json"),
  JSON.stringify({ agentType: "SECRETPROMPTTEXT" }),
);
// An old file: outside the 24 h window the server uses.
writeFileSync(join(root, "-proj", "old.jsonl"), JSON.stringify({ type: "oldtype" }) + "\n");
const long = new Date(Date.now() - 3 * 24 * 3600 * 1000);
utimesSync(join(root, "-proj", "old.jsonl"), long, long);

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ["scripts/logs-probe.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe("what the probe prints", () => {
  test("line types, content block types, key sets and versions, with counts", () => {
    const res = run(["--log-root", root]);
    expect(res.status).toBe(0);
    const out = res.stdout;
    expect(out).toContain("root ");
    expect(out).toMatch(/1 files, 6 lines, 1 not JSON/);
    expect(out).toMatch(/2\s+user\b/);
    expect(out).toMatch(/1\s+assistant\b/);
    expect(out).toContain("file-history-snapshot");
    expect(out).toContain("assistant.tool_use");
    expect(out).toContain("user.tool_result is_error");
    expect(out).toContain("assistant stop_reason=end_turn");
    expect(out).toMatch(/3\s+2\.1\.999/);
    expect(out).toContain(
      "assistant message.usage: cache_read_input_tokens,input_tokens,output_tokens",
    );
    expect(out).toContain("user message: content,role");
  });

  test("prints no value from any log line", () => {
    const res = run(["--log-root", root]);
    for (const value of VALUES) expect(res.stdout, value).not.toContain(value);
    expect(res.stderr).toBe("");
  });

  test("--json is valid JSON and holds no value either", () => {
    const res = run(["--log-root", root, "--json"]);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      files: number;
      types: Record<string, number>;
      keys: Record<string, string[]>;
    }[];
    expect(parsed[0].files).toBe(1);
    expect(parsed[0].types.user).toBe(2);
    expect(parsed[0].keys["assistant message.usage"]).toEqual([
      "cache_read_input_tokens",
      "input_tokens",
      "output_tokens",
    ]);
    for (const value of VALUES) expect(res.stdout, value).not.toContain(value);
  });

  test("a type name that looks like an id, and a version that is not a version, are placeholders", () => {
    const out = run(["--log-root", root]).stdout;
    expect(out).toContain("<other>");
    expect(out).not.toContain("SomeVeryLongMixedCase");
  });

  test("names keyed by data (a tool id, a file name) print as <key>, not as the name", () => {
    const out = run(["--log-root", root]).stdout;
    expect(out).toContain("<key>");
  });

  test("--all also reads files older than 24 h", () => {
    const out = run(["--log-root", root, "--all"]).stdout;
    expect(out).toMatch(/2 files/);
    expect(out).toContain("oldtype");
  });

  test("the roots come from the same resolver as the server (SYNAPSE_LOG_ROOTS)", () => {
    const res = run([], { SYNAPSE_LOG_ROOTS: root });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("(env,");
  });

  test("a root that does not exist is reported with zero files, not an error", () => {
    const res = run(["--log-root", join(dir, "missing")]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/0 files, 0 lines/);
  });
});

describe("--file", () => {
  const file = join(root, "-proj", "s.jsonl");

  test("prints the parser's health counters and token totals, no values", () => {
    const res = run(["--file", file]);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/lines: 6/);
    expect(res.stdout).toMatch(/malformed: 1 {2}unknown: 1/);
    expect(res.stdout).toMatch(/ignored: 1/);
    expect(res.stdout).toMatch(/tokens: in 3 {2}out 4 {2}cacheRead 5 {2}cacheWrite 0/);
    expect(res.stdout).toContain("versions: 2.1.999");
    expect(res.stdout).toMatch(/first malformed at byte \d+/);
    for (const value of VALUES) expect(res.stdout, value).not.toContain(value);
  });

  test("--json prints the same counters as JSON", () => {
    const res = run(["--file", file, "--json"]);
    const health = JSON.parse(res.stdout) as {
      lines: number;
      tokens: { out: number };
      unknownTypes: Record<string, number>;
    };
    expect(health.lines).toBe(6);
    expect(health.tokens.out).toBe(4);
    expect(Object.keys(health.unknownTypes)).toEqual(["<other>"]);
    for (const value of VALUES) expect(res.stdout, value).not.toContain(value);
  });
});

describe("--file does not print where the file is", () => {
  const uuid = "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
  const folder = join(dir, `planteduser-secretrepo-${uuid}`);
  mkdirSync(folder, { recursive: true });
  const file = join(folder, `${uuid}.jsonl`);
  writeFileSync(file, JSON.stringify(lines[0]) + "\n");

  test.each([[[]], [["--json"]]])(
    "with %j neither the path, the user, the repo nor the id appear",
    (extra) => {
      const res = run(["--file", file, ...extra]);
      expect(res.status).toBe(0);
      for (const planted of ["planteduser", "secretrepo", uuid, dir]) {
        expect(res.stdout, planted).not.toContain(planted);
      }
    },
  );
});

describe("bad invocations", () => {
  test.each([
    [["--bogus"], "--bogus"],
    [["--log-root"], "--log-root needs a value"],
    [["--file"], "--file needs a value"],
  ])("%j exits non-zero naming the problem", (args, word) => {
    const res = run(args);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(word);
  });

  test("an unusable config file is an error naming it, as in the server", () => {
    const config = join(dir, "cfg", "synapse-horizon");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "config.json"), "{ not json");
    const res = run([], { XDG_CONFIG_HOME: join(dir, "cfg"), SYNAPSE_LOG_ROOTS: "" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("invalid config file");
  });
});
