import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { parseClaudeText } from "../sidecar/parsers/claude.ts";
import type { ParserDeps } from "../sidecar/parsers/types.ts";
import {
  Sanitizer,
  formatFinding,
  localNames,
  privacyFindings,
  scanDirectory,
} from "./make-fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "make-fixture-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const FIXTURES = new URL("../sidecar/parsers/fixtures/", import.meta.url).pathname;

const NAMES = { home: "/home/plantedhome", user: "plantedperson", host: "plantedhost.local" };

describe("the privacy test (C93, DX15)", () => {
  test("the committed fixtures are clean for this machine's home directory, username and host name", () => {
    expect(scanDirectory(FIXTURES, localNames())).toEqual([]);
  });

  test("it fails on a planted home directory, naming file, line and token", () => {
    const planted = join(dir, "planted");
    mkdirSync(planted);
    writeFileSync(
      join(planted, "bad.jsonl"),
      `{"ok":1}\n{"cwd":"${homedir()}/project"}\n{"ok":3}\n`,
    );
    const findings = scanDirectory(planted, localNames());
    expect(findings).toContainEqual({ file: "bad.jsonl", line: 2, token: homedir() });
    expect(formatFinding(findings[0])).toMatch(/^bad\.jsonl:2: /);
  });

  test.each([
    ["the home directory", `x ${NAMES.home}/y`, NAMES.home],
    ["the username", `by ${NAMES.user}`, NAMES.user],
    ["the host name", `on ${NAMES.host}`, NAMES.host],
    ["the short host name", "on plantedhost", "plantedhost"],
    ["/Users/", "/Users/anyone/x", "/Users/"],
    ["a Windows profile", "C:\\Users\\anyone", "\\Users\\"],
    ["github.com", "git@github.com:a/b", "github.com"],
    ["an http URL", "see http://x.test", "http://"],
    ["an https URL", "see https://x.test", "https://"],
  ])("finds %s", (_name, line, token) => {
    const found = privacyFindings([{ name: "f.jsonl", text: `clean\n${line}\nclean` }], NAMES);
    expect(found).toContainEqual({ file: "f.jsonl", line: 2, token });
  });

  test("matching ignores case, and clean text has no findings", () => {
    expect(
      privacyFindings([{ name: "f", text: "PLANTEDPERSON" }], NAMES).map((f) => f.token),
    ).toEqual([NAMES.user]);
    expect(
      privacyFindings([{ name: "f", text: '{"cwd":"/repo","gitBranch":"main"}' }], NAMES),
    ).toEqual([]);
  });

  test("names shorter than 3 characters are not searched (they would match everything)", () => {
    expect(
      privacyFindings([{ name: "f", text: "ab" }], { home: "", user: "ab", host: "a" }),
    ).toEqual([]);
  });

  test("this machine's real names are what localNames reports", () => {
    expect(localNames()).toEqual({ home: homedir(), user: userInfo().username, host: hostname() });
  });
});

const RAW = [
  {
    type: "user",
    uuid: "u1",
    sessionId: "s1",
    version: "2.1.295",
    timestamp: "2026-10-14T08:00:00.000Z",
    isSidechain: false,
    cwd: "/Users/planted/work/secret-repo",
    gitBranch: "feature/secret-branch",
    userType: "external",
    slug: "witty-fox",
    message: {
      role: "user",
      content:
        "fix https://github.com/org/secret-repo/issues/1 in /Users/planted/work/secret-repo/src/a.ts",
    },
  },
  {
    type: "user",
    uuid: "u2",
    sessionId: "s1",
    timestamp: "2026-10-14T08:00:01.000Z",
    cwd: "/Users/planted/work/secret-repo/pkg",
    isSidechain: false,
    message: { role: "user", content: "<system-reminder>private reminder text" },
  },
  {
    type: "assistant",
    uuid: "a1",
    sessionId: "s1",
    timestamp: "2026-10-14T08:00:02.000Z",
    cwd: "/Users/planted/work/secret-repo",
    isSidechain: false,
    requestId: "req_secret",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-opus-5-5",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 3,
        output_tokens: 7,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 13,
        service_tier: "standard",
      },
      content: [
        { type: "thinking", thinking: "private thoughts about /Users/planted", signature: "sig" },
        { type: "text", text: "reply with https://example.invalid/secret" },
        {
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: {
            command: "git commit -m 'SECRET message' && git push git@github.com:org/secret.git",
            description: "secret",
          },
        },
        {
          type: "tool_use",
          id: "t2",
          name: "Bash",
          input: { command: "cd /Users/planted && pnpm exec vitest run" },
        },
        {
          type: "tool_use",
          id: "t3",
          name: "Edit",
          input: {
            file_path: "/Users/planted/work/secret-repo/src/secret-file.ts",
            old_string: "SECRET OLD",
            new_string: "SECRET NEW",
          },
        },
        {
          type: "tool_use",
          id: "t4",
          name: "Write",
          input: { file_path: "/etc/secret.conf", content: "SECRET BODY" },
        },
        {
          type: "tool_use",
          id: "t5",
          name: "mcp__acme-internal__deploy",
          input: { target: "prod" },
        },
        {
          type: "tool_use",
          id: "t6",
          name: "TodoWrite",
          input: {
            todos: [
              {
                content: "ship SECRET feature",
                status: "in_progress",
                activeForm: "shipping SECRET feature",
              },
              { content: "ship SECRET feature", status: "pending", activeForm: "x" },
            ],
          },
        },
        {
          type: "tool_use",
          id: "t7",
          name: "mcp__ccd_turn__update_plan",
          input: {
            items: [{ content: "ship SECRET feature", status: "completed" }],
            scope: "continuation",
          },
        },
      ],
    },
  },
  {
    type: "user",
    uuid: "u3",
    sessionId: "s1",
    timestamp: "2026-10-14T08:00:03.000Z",
    cwd: "/Users/planted/work/secret-repo",
    isSidechain: false,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "SECRET OUTPUT", is_error: true },
      ],
    },
    toolUseResult: { stdout: "SECRET OUTPUT" },
  },
  {
    type: "system",
    subtype: "api_error",
    uuid: "e1",
    sessionId: "s1",
    timestamp: "2026-10-14T08:00:04.000Z",
    cwd: "/Users/planted/work/secret-repo",
    level: "error",
    error: { status: 529, message: "SECRET detail", headers: { host: "api.example.invalid" } },
  },
  {
    type: "attachment",
    uuid: "x1",
    sessionId: "s1",
    timestamp: "2026-10-14T08:00:05.000Z",
    cwd: "/Users/planted/work/secret-repo",
    attachment: { content: "SECRET ATTACHMENT" },
  },
  { type: "custom-title", customTitle: "SECRET TITLE", sessionId: "s1" },
];
const rawText = RAW.map((l) => JSON.stringify(l)).join("\n") + "\n{broken SECRET\n";
const SECRETS = [
  "planted",
  "secret",
  "SECRET",
  "github",
  "https",
  "http://",
  "feature/",
  "witty-fox",
  "req_",
  "example.invalid",
  "acme-internal",
  "private",
  "thoughts",
  "sig",
  "/Users",
  "external",
];

function sanitized() {
  const s = new Sanitizer();
  const out = rawText
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => s.line(l))
    .filter((o) => o !== undefined);
  return { s, out, text: out.map((o) => JSON.stringify(o)).join("\n") + "\n" };
}

describe("the sanitiser", () => {
  test("nothing from the raw text survives", () => {
    const { text } = sanitized();
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
    expect(
      privacyFindings([{ name: "f", text }], {
        home: "/Users/planted",
        user: "planted",
        host: "plantedhost",
      }),
    ).toEqual([]);
  });

  test("ids, timestamps, types, versions and usage numbers are kept", () => {
    const { out } = sanitized();
    const assistant = out.find((o) => o!.type === "assistant")! as {
      uuid: string;
      timestamp: string;
      message: { id: string; usage: Record<string, number>; model: string; stop_reason: string };
    };
    expect(assistant.uuid).toBe("a1");
    expect(assistant.timestamp).toBe("2026-10-14T08:00:02.000Z");
    expect(assistant.message.id).toBe("msg_1");
    expect(assistant.message.model).toBe("claude-opus-5-5");
    expect(assistant.message.stop_reason).toBe("tool_use");
    expect(assistant.message.usage).toEqual({
      input_tokens: 3,
      output_tokens: 7,
      cache_read_input_tokens: 11,
      cache_creation_input_tokens: 13,
    });
    expect(out[0]).toMatchObject({ version: "2.1.295", type: "user", isSidechain: false });
  });

  test("working directories and branches become /repo and main; a subdirectory stays inside", () => {
    const { out } = sanitized();
    expect(out.map((o) => o!.cwd).filter(Boolean)).toEqual([
      "/repo",
      "/repo/sub",
      "/repo",
      "/repo",
      "/repo",
      "/repo",
    ]);
    expect(out[0]).toMatchObject({ gitBranch: "main" });
  });

  test("commands keep their class and nothing else; paths keep inside versus outside", () => {
    const { out } = sanitized();
    const blocks = (
      out[2] as { message: { content: { name?: string; input?: Record<string, unknown> }[] } }
    ).message.content;
    const commands = blocks.filter((b) => b.name === "Bash").map((b) => b.input!.command);
    expect(commands).toEqual(["git commit -m message", "vitest run"]);
    const edit = blocks.find((b) => b.name === "Edit")!.input!;
    expect(edit).toEqual({ file_path: "/repo/src/file-1.ts" });
    expect(blocks.find((b) => b.name === "Write")!.input).toEqual({
      file_path: "/home/user/file-2.conf",
    });
  });

  test("equal plan text gets an equal placeholder, so ids and rewording survive", () => {
    const { out } = sanitized();
    const blocks = (
      out[2] as {
        message: {
          content: {
            name?: string;
            input?: { todos?: { content: string }[]; items?: { content: string }[] };
          }[];
        };
      }
    ).message.content;
    const todos = blocks.find((b) => b.name === "TodoWrite")!.input!.todos!;
    expect(todos[0].content).toBe(todos[1].content);
    const items = blocks.find((b) => b.name === "mcp__ccd_turn__update_plan")!.input!.items!;
    expect(items[0].content).toBe(todos[0].content);
  });

  test("unknown tool names are replaced, known ones kept", () => {
    const { out } = sanitized();
    const names = (out[2] as { message: { content: { name?: string }[] } }).message.content
      .map((b) => b.name)
      .filter(Boolean);
    expect(names).toContain("mcp__server__tool1");
    expect(names).toContain("Bash");
    expect(names).not.toContain("mcp__acme-internal__deploy");
  });

  test("an injected tag keeps its tag word so the parser still skips it; a prompt stays a prompt", () => {
    const { out } = sanitized();
    expect((out[0] as { message: { content: string } }).message.content).toMatch(/^prompt text/);
    expect((out[1] as { message: { content: string } }).message.content).toMatch(
      /^<system-reminder>injected text/,
    );
  });

  test("the tool result keeps is_error and the api_error keeps its status code", () => {
    const { out } = sanitized();
    const result = (
      out[3] as { message: { content: { is_error?: boolean; tool_use_id: string }[] } }
    ).message.content[0];
    expect(result).toMatchObject({ is_error: true, tool_use_id: "t1" });
    expect(out[4]).toMatchObject({ subtype: "api_error", error: { status: 529 }, level: "error" });
    expect(out[3]).not.toHaveProperty("toolUseResult");
  });

  test("ignored line types keep only their type and ids", () => {
    const { out } = sanitized();
    expect(out[5]).toEqual({
      type: "attachment",
      uuid: "x1",
      sessionId: expect.any(String),
      timestamp: "2026-10-14T08:00:05.000Z",
      cwd: "/repo",
    });
    expect(Object.keys(out[6]!).sort()).toEqual(["sessionId", "type"]);
  });

  test("the real session id becomes a generated UUID, the same on every line", () => {
    const { out, text } = sanitized();
    const ids = new Set(out.map((o) => o!.sessionId));
    expect(ids.size).toBe(1);
    const [id] = [...ids] as string[];
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).not.toBe("s1");
    expect(text).not.toContain('"s1"');
    // Another run makes another one, so the fixture holds nothing from the original.
    expect(new Sanitizer().line(JSON.stringify(RAW[0]))!.sessionId).not.toBe(id);
  });

  test("a line that is not JSON is skipped and counted", () => {
    const { s } = sanitized();
    expect(s.replaced.skipped).toBe(1);
  });

  test("it reports what it replaced", () => {
    const { s } = sanitized();
    expect(s.replaced).toMatchObject({
      lines: 8,
      skipped: 1,
      commands: 2,
      paths: 2,
      toolNames: 1,
      branch: 1,
      thinking: 1,
      toolOutput: 1,
    });
    expect(s.replaced.urls).toBe(2);
  });

  test("the parser reads the sanitised session the same way as the raw one", () => {
    const deps: ParserDeps = {
      resolveProjectKey: () => "k",
      rootProjectKey: () => "k",
      readMeta: () => undefined,
    };
    const opts = { path: "/x/s.jsonl", identity: "1:1" };
    const raw = parseClaudeText(rawText, opts, deps).events;
    const clean = parseClaudeText(sanitized().text, opts, deps).events;
    const shape = (events: typeof raw) =>
      events.map((e) => [
        e.type,
        e.tokens,
        e.toolClass,
        e.toolError,
        e.status,
        e.todo?.status,
        e.model,
      ]);
    expect(shape(clean)).toEqual(shape(raw));
  });
});

describe("the command line", () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/make-fixture.ts", ...args], { encoding: "utf8" });
  const source = join(dir, "raw.jsonl");
  writeFileSync(source, rawText);

  test("cuts a session, prints what it replaced and passes the privacy scan", () => {
    const out = join(dir, "out.jsonl");
    const res = run("--vendor", "claude", "--file", source, "--out", out);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("7 lines written");
    expect(res.stdout).toMatch(/commands: 2/);
    expect(readFileSync(out, "utf8")).not.toContain("SECRET");
  });

  test("--lines keeps the first n lines", () => {
    const out = join(dir, "three.jsonl");
    expect(run("--vendor", "claude", "--file", source, "--out", out, "--lines", "3").status).toBe(
      0,
    );
    expect(readFileSync(out, "utf8").trimEnd().split("\n")).toHaveLength(3);
  });

  test("the plan's `--` separator from vp run is accepted", () => {
    const out = join(dir, "sep.jsonl");
    expect(run("--", "--vendor", "claude", "--file", source, "--out", out).status).toBe(0);
  });

  test.each([
    [["--file", "a", "--out", "b"], "--vendor is required"],
    [["--vendor", "claude", "--out", "b"], "--file is required"],
    [["--vendor", "claude", "--file", "a"], "--out is required"],
    [["--vendor", "nope", "--file", "a", "--out", "b"], 'unknown vendor "nope"'],
    [["--vendor", "codex", "--file", "a", "--out", "b"], "chunk 16"],
    [["--vendor", "claude", "--file", "/nonexistent/x", "--out", "b"], "--file: cannot read"],
    [
      ["--vendor", "claude", "--file", source, "--out", "/nonexistent-dir/x"],
      "--out: cannot write",
    ],
    [["--vendor", "claude", "--file", source, "--out", "b", "--lines", "0"], "--lines"],
    [["--bogus"], "unknown flag --bogus"],
  ])("%j exits non-zero saying %s", (args, message) => {
    const res = run(...args);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(message);
  });
});
