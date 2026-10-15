import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { applyBatch, emptyData } from "../../src/data/reduce.ts";
import { AgentEvent } from "../../src/data/schema.ts";
import {
  IGNORED_SYSTEM_SUBTYPES,
  IGNORED_TYPES,
  INJECTED_TAGS,
  createClaudeState,
  parseClaudeLine,
  type ClaudeFileState,
} from "./claude.ts";
import { fileIdentity } from "./ids.ts";
import { MAX_LINE_BYTES, TESTED_VERSIONS, type ParserDeps } from "./types.ts";

const T0 = Date.UTC(2026, 9, 14, 8, 0, 0);
const ts = (n: number) => new Date(T0 + n * 1000).toISOString();
const MAIN = "/home/u/.claude/projects/-repo/sess-1.jsonl";
const SUB = "/home/u/.claude/projects/-repo/sess-1/subagents/agent-a1.jsonl";

const base = (n: number, over: Record<string, unknown> = {}) => ({
  sessionId: "sess-1",
  cwd: "/repo",
  timestamp: ts(n),
  version: "2.1.295",
  uuid: `u${n}`,
  isSidechain: false,
  ...over,
});
const user = (n: number, content: unknown, over: Record<string, unknown> = {}) => ({
  type: "user",
  ...base(n),
  message: { role: "user", content },
  ...over,
});
const USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 100,
  cache_creation_input_tokens: 7,
};
const assistant = (
  n: number,
  id: string,
  content: unknown[],
  message: Record<string, unknown> = {},
  over: Record<string, unknown> = {},
) => ({
  type: "assistant",
  ...base(n),
  message: {
    id,
    role: "assistant",
    model: "claude-opus-5-5",
    stop_reason: null,
    usage: USAGE,
    content,
    ...message,
  },
  ...over,
});
const text = (t = "ok") => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: unknown) => ({
  type: "tool_use",
  id,
  name,
  input,
});
const toolResult = (id: string, isError?: boolean) => ({
  type: "tool_result",
  tool_use_id: id,
  content: "result body",
  ...(isError === undefined ? {} : { is_error: isError }),
});

interface Stub extends ParserDeps {
  calls: { meta: string[]; key: string[]; root: string[] };
}
function stubDeps(meta: { agentType?: string } | null = { agentType: "refuter" }): Stub {
  const calls = { meta: [] as string[], key: [] as string[], root: [] as string[] };
  return {
    calls,
    resolveProjectKey: (sessionId, cwd) => {
      calls.key.push(`${sessionId}@${cwd}`);
      return `key:${cwd}`;
    },
    rootProjectKey: (rootSessionId, cwd) => {
      calls.root.push(`${rootSessionId}@${cwd}`);
      return `key:root:${rootSessionId}`;
    },
    readMeta: (path) => {
      calls.meta.push(path);
      return meta ?? undefined;
    },
  };
}

function run(
  lines: (object | string)[],
  opts: { path?: string; identity?: string; deps?: ParserDeps; state?: ClaudeFileState } = {},
) {
  const deps = opts.deps ?? stubDeps();
  let state =
    opts.state ?? createClaudeState({ path: opts.path ?? MAIN, identity: opts.identity ?? "1:42" });
  const events: AgentEvent[] = [];
  const perLine: AgentEvent[][] = [];
  let offset = 0;
  for (const line of lines) {
    const raw = typeof line === "string" ? line : JSON.stringify(line);
    const r = parseClaudeLine(raw, offset, state, deps);
    state = r.state;
    events.push(...r.events);
    perLine.push(r.events);
    offset += Buffer.byteLength(raw) + 1;
  }
  return { events, perLine, state };
}
const types = (events: AgentEvent[]) => events.map((e) => e.type);

describe("a plain session", () => {
  const lines = [
    user(1, "add a login page"),
    assistant(2, "m1", [text(), toolUse("t1", "Read", { file_path: "/repo/a.ts" })], {
      stop_reason: "tool_use",
    }),
    user(3, [toolResult("t1")]),
    assistant(4, "m2", [text("done")], { stop_reason: "end_turn" }),
  ];

  test("maps to session_start, turn_start, usage, tool_call, tool_result, usage, turn_end", () => {
    const { events } = run(lines);
    expect(types(events)).toEqual([
      "session_start",
      "turn_start",
      "usage",
      "tool_call",
      "tool_result",
      "usage",
      "turn_end",
    ]);
  });

  test("every event is a valid AgentEvent with the expected common fields", () => {
    const { events } = run(lines);
    for (const e of events) {
      expect(AgentEvent.safeParse(e).success, JSON.stringify(e)).toBe(true);
      expect(e.vendor).toBe("claude");
      expect(e.sessionId).toBe("sess-1");
      expect(e.agentKind).toBe("main");
      expect(e.parentKnown).toBe(true);
      expect(e.parentSessionId).toBeUndefined();
      expect(e.projectKey).toBe("key:/repo");
      expect(e.raw?.file).toBe("sess-1.jsonl");
    }
    expect(events[0].ts).toBe(ts(1));
    expect(events.map((e) => e.raw?.offset)).toEqual([
      0,
      0,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  test("usage maps in, out, cacheRead and cacheWrite, and carries the model", () => {
    const usage = run(lines).events.filter((e) => e.type === "usage");
    expect(usage[0].tokens).toEqual({ in: 10, out: 5, cacheRead: 100, cacheWrite: 7 });
    expect(usage[0].model).toBe("claude-opus-5-5");
    expect(usage[0].provenance.tokens).toBe("real");
  });

  test("the turn_start carries the prompt as currentTask; session_start has no status", () => {
    const { events } = run(lines);
    expect(events[1].currentTask).toBe("add a login page");
    expect(events[1].provenance.currentTask).toBe("derived");
    expect(events[0].status).toBeUndefined();
  });

  test("tool_call carries the name and class; tool_result names the call's tool", () => {
    const { events } = run(lines);
    const call = events.find((e) => e.type === "tool_call")!;
    expect(call.toolName).toBe("Read");
    expect(call.toolClass).toBe("other");
    expect(events.find((e) => e.type === "tool_result")!.toolName).toBe("Read");
  });

  test("the file state counts lines and tokens for the health row", () => {
    const { state } = run(lines);
    expect(state.health.lines).toBe(4);
    expect(state.health.tokens).toEqual({ in: 20, out: 10, cacheRead: 200, cacheWrite: 14 });
    expect(state.health.versions).toEqual(["2.1.295"]);
    expect(state.health.events).toBe(7);
  });
});

describe("session_start", () => {
  test("is emitted once, on the first line with sessionId, timestamp and cwd, even if its type is ignored", () => {
    const { events, perLine } = run([
      { type: "custom-title", customTitle: "x" },
      { type: "attachment", ...base(1) },
      user(2, "hello"),
      user(3, "again"),
    ]);
    expect(types(events).filter((t) => t === "session_start")).toHaveLength(1);
    expect(perLine[1][0].type).toBe("session_start");
    expect(perLine[1][0].ts).toBe(ts(1));
  });
});

describe("subagents (C83)", () => {
  const subLine = (n: number, c: unknown) => ({
    ...user(n, c),
    isSidechain: true,
    agentId: "a1",
  });

  test("a subagent file maps to sessionId = agentId, parent = the root session", () => {
    const deps = stubDeps();
    const { events } = run(
      [
        subLine(1, "do the task"),
        { ...assistant(2, "m1", [text()]), isSidechain: true, agentId: "a1" },
      ],
      {
        path: SUB,
        deps,
      },
    );
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.sessionId).toBe("a1");
      expect(e.parentSessionId).toBe("sess-1");
      expect(e.agentKind).toBe("sub");
      expect(e.parentKnown).toBe(true);
      expect(e.projectKey).toBe("key:root:sess-1");
      expect(AgentEvent.safeParse(e).success).toBe(true);
    }
    expect(deps.calls.key).toEqual([]);
    expect(types(events)).toContain("turn_start");
  });

  test("isSidechain lines inside a subagent file are the subagent's own work, not ignored", () => {
    const { state } = run([subLine(1, "task")], { path: SUB });
    expect(state.health.sidechain).toBe(0);
    expect(state.health.ignored).toBe(0);
  });

  test(".meta.json is read once per file for agentType", () => {
    const deps = stubDeps({ agentType: "builder" });
    const { state } = run([subLine(1, "a"), subLine(2, "b"), subLine(3, "c")], { path: SUB, deps });
    expect(deps.calls.meta).toEqual([
      "/home/u/.claude/projects/-repo/sess-1/subagents/agent-a1.meta.json",
    ]);
    expect(state.agentType).toBe("builder");
  });

  test("a missing meta file is tolerated", () => {
    const { events, state } = run([subLine(1, "a")], { path: SUB, deps: stubDeps(null) });
    expect(events.length).toBeGreaterThan(0);
    expect(state.agentType).toBeUndefined();
  });

  test("two subagents, one nested, both name the root session", () => {
    const deps = stubDeps();
    const first = run([subLine(1, "a")], { path: SUB, deps });
    const nestedPath = "/home/u/.claude/projects/-repo/sess-1/subagents/agent-b2.jsonl";
    const nested = run([{ ...subLine(2, "b"), agentId: "b2" }], { path: nestedPath, deps });
    expect(first.events[0].sessionId).toBe("a1");
    expect(nested.events[0].sessionId).toBe("b2");
    expect(nested.events[0].parentSessionId).toBe("sess-1");
    expect(deps.calls.root).toEqual(["sess-1@/repo", "sess-1@/repo"]);
  });

  test("a main file's in-file sidechain lines are ignored and counted", () => {
    const { events, state } = run([user(1, "hi"), { ...user(2, "side"), isSidechain: true }]);
    expect(types(events)).toEqual(["session_start", "turn_start"]);
    expect(state.health.sidechain).toBe(1);
    expect(state.health.firstOffsets.sidechain).toBeGreaterThan(0);
  });
});

describe("tool errors (E1) and api_error (C90)", () => {
  const call = assistant(2, "m1", [toolUse("t1", "Bash", { command: "grep nothing ." })], {
    stop_reason: "tool_use",
  });

  test("a failed tool result is a tool_result with toolError and no status", () => {
    const { events } = run([user(1, "go"), call, user(3, [toolResult("t1", true)])]);
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.toolError).toBe(true);
    expect(result.status).toBeUndefined();
    expect(result.provenance.toolError).toBe("real");
    expect(AgentEvent.safeParse(result).success).toBe(true);
  });

  test("a successful tool result has no toolError", () => {
    const { events } = run([user(1, "go"), call, user(3, [toolResult("t1", false)])]);
    expect(events.find((e) => e.type === "tool_result")!.toolError).toBeUndefined();
  });

  test("a session's status does not change for a failed tool call", () => {
    const { events } = run([user(1, "go"), call, user(3, [toolResult("t1", true)])]);
    const before = applyBatch(emptyData(), events.slice(0, -1)).sessions.get("sess-1")?.status;
    const after = applyBatch(emptyData(), events).sessions.get("sess-1")?.status;
    expect(after).toBe(before);
    expect(after).not.toBe("error");
  });

  test("a result for a call this file never saw still maps, without a tool name", () => {
    const { events } = run([user(1, [toolResult("unseen", true)])]);
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result.toolName).toBeUndefined();
    expect(result.toolError).toBe(true);
  });

  test("system api_error gives an error event with status error, and the session turns error", () => {
    const { events } = run([
      user(1, "go"),
      { type: "system", subtype: "api_error", ...base(5), level: "error", error: { status: 529 } },
    ]);
    const err = events.find((e) => e.type === "error")!;
    expect(err.status).toBe("error");
    expect(err.provenance.status).toBe("real");
    expect(applyBatch(emptyData(), events).sessions.get("sess-1")?.status).toBe("error");
  });
});

describe("line classes (C90, C99)", () => {
  test("malformed JSON, non-objects and unknown types are counted with first offsets, no events", () => {
    const { events, state } = run([
      user(1, "hi"),
      "{not json",
      "[1,2]",
      "42",
      { type: "brand-new-thing", ...base(2) },
      { type: "brand-new-thing", ...base(3) },
      { type: "system", subtype: "brand-new-subtype", ...base(4) },
      { nothing: true },
    ]);
    expect(types(events)).toEqual(["session_start", "turn_start"]);
    expect(state.health.malformed).toBe(3);
    expect(state.health.unknown).toBe(4);
    expect(state.health.unknownTypes).toEqual({
      "brand-new-thing": 2,
      "system/brand-new-subtype": 1,
      "-": 1,
    });
    expect(state.health.firstOffsets.malformed).toBeGreaterThan(0);
    expect(state.health.firstOffsets.unknown).toBeGreaterThan(state.health.firstOffsets.malformed);
    expect(state.health.lines).toBe(8);
  });

  test("unknown type names are cut to 40 characters and cannot carry a secret shape through", () => {
    const { state } = run([{ type: "x".repeat(100), ...base(1) }]);
    expect(Object.keys(state.health.unknownTypes)[0]).toHaveLength(40);
  });

  test("a blank line is skipped without a count", () => {
    const { state } = run(["", "   ", user(1, "hi")]);
    expect(state.health.malformed).toBe(0);
    expect(state.health.lines).toBe(3);
  });

  test("a line over 32 MiB is skipped, counted oversize, and the next line parses", () => {
    const big = "x".repeat(MAX_LINE_BYTES + 1);
    const { events, state } = run([big, user(1, "hi")]);
    expect(state.health.oversize).toBe(1);
    expect(state.health.firstOffsets.oversize).toBe(0);
    expect(types(events)).toEqual(["session_start", "turn_start"]);
  });

  test("a line of exactly 32 MiB is accepted as a line (and here is malformed JSON)", () => {
    const edge = "x".repeat(MAX_LINE_BYTES);
    const { state } = run([edge]);
    expect(state.health.oversize).toBe(0);
    expect(state.health.malformed).toBe(1);
  });

  test("a multibyte line whose bytes pass 32 MiB is oversize though its length does not", () => {
    const wide = "é".repeat(MAX_LINE_BYTES / 2 + 1);
    expect(wide.length).toBeLessThan(MAX_LINE_BYTES);
    const { state } = run([wide]);
    expect(state.health.oversize).toBe(1);
  });

  test.each(IGNORED_TYPES)(
    "known-ignored type %s gives no event and is counted ignored",
    (type) => {
      const { events, state } = run([{ type, ...base(1) }]);
      // The line may still start the session; nothing else comes from it.
      expect(types(events).filter((t) => t !== "session_start")).toEqual([]);
      expect(state.health.ignored).toBe(1);
      expect(state.health.unknown).toBe(0);
    },
  );

  test.each(IGNORED_SYSTEM_SUBTYPES)("system/%s is ignored", (subtype) => {
    const { events, state } = run([{ type: "system", subtype, ...base(1) }]);
    expect(types(events).filter((t) => t !== "session_start")).toEqual([]);
    expect(state.health.ignored).toBe(1);
  });

  test("the plan's ignored lists are exactly these", () => {
    expect([...IGNORED_TYPES].sort()).toEqual(
      [
        "attachment",
        "custom-title",
        "ai-title",
        "last-prompt",
        "agent-name",
        "queue-operation",
        "atis-latch",
        "bridge-session",
        "mode",
        "permission-mode",
        "pr-link",
        "cost-state",
        "file-history-snapshot",
        "file-history-delta",
      ].sort(),
    );
    expect([...IGNORED_SYSTEM_SUBTYPES].sort()).toEqual(
      [
        "stop_hook_summary",
        "turn_duration",
        "away_summary",
        "local_command",
        "compact_boundary",
        "informational",
        "scheduled_task_fire",
      ].sort(),
    );
  });
});

describe("usage once per message (C80)", () => {
  const blocks = [
    assistant(2, "m1", [{ type: "thinking", thinking: "..." }]),
    assistant(3, "m1", [text("hello")]),
    assistant(4, "m1", [toolUse("t1", "Read", {})], { stop_reason: "tool_use" }),
  ];

  test("a message over 3 content-block lines counts its tokens once", () => {
    const { events, state } = run([user(1, "go"), ...blocks]);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
    expect(state.health.tokens).toEqual({ in: 10, out: 5, cacheRead: 100, cacheWrite: 7 });
    expect(state.health.drift).toBe(0);
  });

  test("the first line's usage is kept and a later different one is flagged as drift", () => {
    const changed = assistant(4, "m1", [text("x")], { usage: { ...USAGE, output_tokens: 99 } });
    const { events, state } = run([user(1, "go"), blocks[0], blocks[1], changed]);
    const usage = events.filter((e) => e.type === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0].tokens?.out).toBe(5);
    expect(state.health.drift).toBe(1);
    expect(state.health.firstOffsets.drift).toBeGreaterThan(0);
  });

  test("distinct messages each count once", () => {
    const { state } = run([assistant(1, "m1", [text()]), assistant(2, "m2", [text()])]);
    expect(state.health.tokens.in).toBe(20);
  });

  test("a line without usage or message id makes no usage event", () => {
    const noUsage = assistant(1, "m1", [text()], { usage: undefined });
    const noId = assistant(2, "m2", [text()], { id: undefined });
    const { events } = run([noUsage, noId]);
    expect(events.filter((e) => e.type === "usage")).toEqual([]);
  });

  test("missing usage fields count as 0", () => {
    const line = assistant(1, "m1", [text()], { usage: { input_tokens: 4 } });
    const { events } = run([line]);
    expect(events.find((e) => e.type === "usage")!.tokens).toEqual({
      in: 4,
      out: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  test("the synthetic model is not reported as a model", () => {
    const { events } = run([assistant(1, "m1", [text()], { model: "<synthetic>" })]);
    expect(events.find((e) => e.type === "usage")!.model).toBeUndefined();
  });

  test("end_turn over 2 lines gives one turn_end", () => {
    const { events } = run([
      assistant(1, "m1", [text("a")], { stop_reason: "end_turn" }),
      assistant(2, "m1", [text("b")], { stop_reason: "end_turn" }),
    ]);
    expect(events.filter((e) => e.type === "turn_end")).toHaveLength(1);
  });

  test("other stop reasons and null give no turn_end", () => {
    const { events } = run([
      assistant(1, "m1", [text()], { stop_reason: "tool_use" }),
      assistant(2, "m2", [text()], { stop_reason: "stop_sequence" }),
      assistant(3, "m3", [text()]),
    ]);
    expect(events.filter((e) => e.type === "turn_end")).toEqual([]);
  });
});

describe("timestamps (E19)", () => {
  test("a line without a timestamp takes the previous line's", () => {
    const noTs = { ...assistant(2, "m1", [text()]), timestamp: undefined };
    const { events } = run([user(1, "hi"), noTs]);
    expect(events.filter((e) => e.type === "usage")[0].ts).toBe(ts(1));
  });

  test("a bad timestamp is treated as missing", () => {
    const bad = { ...assistant(2, "m1", [text()]), timestamp: "yesterday" };
    const { events } = run([user(1, "hi"), bad]);
    expect(events.filter((e) => e.type === "usage")[0].ts).toBe(ts(1));
  });

  test("with no earlier timestamp the events are suppressed and counted", () => {
    const noTs = { ...assistant(1, "m1", [text()]), timestamp: undefined };
    const { events, state } = run([noTs, user(2, "hi")]);
    expect(types(events)).toEqual(["session_start", "turn_start"]);
    expect(state.health.noTimestamp).toBe(1);
  });

  test("timestamps are normalised to ISO with milliseconds", () => {
    const { events } = run([user(1, "hi", { timestamp: "2026-10-14T08:00:01Z" })]);
    expect(events[0].ts).toBe("2026-10-14T08:00:01.000Z");
  });
});

describe("plan tools (C82, X5, E12)", () => {
  const todoWrite = (n: number, id: string, todos: [string, string][]) =>
    assistant(
      n,
      id,
      [
        toolUse(`tw${n}`, "TodoWrite", {
          todos: todos.map(([content, status]) => ({ content, status, activeForm: content })),
        }),
      ],
      { stop_reason: "tool_use" },
    );
  const plan = (n: number, input: unknown) =>
    assistant(n, `p${n}`, [toolUse(`pl${n}`, "mcp__ccd_turn__update_plan", input)], {
      stop_reason: "tool_use",
    });
  const statusEvents = (events: AgentEvent[]) => events.filter((e) => e.type === "status");

  test("TodoWrite gives one status event per changed item, carrying todo and no status value", () => {
    const { events } = run([
      todoWrite(1, "a", [
        ["write tests", "in_progress"],
        ["ship it", "pending"],
      ]),
    ]);
    const s = statusEvents(events);
    expect(s).toHaveLength(2);
    for (const e of s) {
      expect(e.status).toBeUndefined();
      expect(e.todo).toBeDefined();
      expect(AgentEvent.safeParse(e).success).toBe(true);
    }
    expect(s.map((e) => e.todo?.status)).toEqual(["in_progress", "pending"]);
    expect(types(events)).toContain("tool_call");
  });

  test("currentTask is the in-progress item, on that item's event", () => {
    const { events } = run([
      todoWrite(1, "a", [
        ["write tests", "in_progress"],
        ["ship it", "pending"],
      ]),
    ]);
    const s = statusEvents(events);
    expect(s[0].currentTask).toBe("write tests");
    expect(s[1].currentTask).toBeUndefined();
  });

  test("an unchanged resend gives no status events", () => {
    const list: [string, string][] = [
      ["a", "in_progress"],
      ["b", "pending"],
    ];
    const { perLine } = run([todoWrite(1, "x", list), todoWrite(2, "y", list)]);
    expect(statusEvents(perLine[1])).toEqual([]);
  });

  test("an item inserted at index 0 keeps the ids of the others", () => {
    const { events } = run([
      todoWrite(1, "x", [
        ["a", "in_progress"],
        ["b", "pending"],
      ]),
      todoWrite(2, "y", [
        ["brand new", "pending"],
        ["a", "in_progress"],
        ["b", "pending"],
      ]),
    ]);
    const s = statusEvents(events);
    expect(s).toHaveLength(3);
    const ids = s.map((e) => e.todo!.id);
    expect(new Set(ids).size).toBe(3);
  });

  test("a reworded item gives one cancelled and one new in_progress item", () => {
    const { events, perLine } = run([
      todoWrite(1, "x", [["fix the bug", "in_progress"]]),
      todoWrite(2, "y", [["fix the login bug", "in_progress"]]),
    ]);
    const second = statusEvents(perLine[1]);
    expect(second.map((e) => e.todo?.status ?? "").sort()).toEqual(["cancelled", "in_progress"]);
    const first = statusEvents(perLine[0]);
    expect(second.find((e) => e.todo?.status === "cancelled")!.todo!.id).toBe(first[0].todo!.id);
    expect(events.some((e) => e.todo?.status === "completed")).toBe(false);
  });

  test("update_plan items, advance, and done/start give status events", () => {
    const { perLine, state } = run([
      plan(1, {
        items: [
          { content: "one", status: "in_progress" },
          { content: "two", status: "pending" },
          { content: "three", status: "pending" },
        ],
        scope: "first_task",
      }),
      plan(2, { advance: true }),
      plan(3, { done: [2], start: 3 }),
    ]);
    expect(statusEvents(perLine[0]).map((e) => e.todo?.status)).toEqual([
      "in_progress",
      "pending",
      "pending",
    ]);
    expect(statusEvents(perLine[1]).map((e) => e.todo?.status)).toEqual([
      "completed",
      "in_progress",
    ]);
    expect(statusEvents(perLine[2]).map((e) => e.todo?.status)).toEqual([
      "completed",
      "in_progress",
    ]);
    expect(Object.keys(state.plans)).toEqual(["mcp__ccd_turn__update_plan"]);
  });

  test("todo ids are stable on re-parse", () => {
    const lines = [todoWrite(1, "x", [["a", "in_progress"]])];
    const a = run(lines).events.filter((e) => e.type === "status")[0];
    const b = run(lines).events.filter((e) => e.type === "status")[0];
    expect(a.todo!.id).toBe(b.todo!.id);
    expect(a.id).toBe(b.id);
  });

  test("a plan call that is not a plan change gives only the tool_call", () => {
    const { events } = run([plan(1, { advance: true })]);
    expect(statusEvents(events)).toEqual([]);
  });
});

describe("currentTask (C82, E10)", () => {
  const todo = (n: number, text: string, status = "in_progress") =>
    assistant(n, `t${n}`, [toolUse(`x${n}`, "TodoWrite", { todos: [{ content: text, status }] })], {
      stop_reason: "tool_use",
    });
  const current = (events: AgentEvent[]) =>
    [...events].reverse().find((e) => e.currentTask !== undefined)?.currentTask;

  test("without a plan it falls back to the latest real prompt", () => {
    expect(current(run([user(1, "first"), user(2, "second")]).events)).toBe("second");
  });

  test("a newer plan item beats the older prompt", () => {
    expect(current(run([user(1, "do things"), todo(2, "step one")]).events)).toBe("step one");
  });

  test("a newer prompt beats the older plan item", () => {
    expect(current(run([todo(1, "step one"), user(2, "actually do this")]).events)).toBe(
      "actually do this",
    );
  });

  test("when the plan has nothing in progress the prompt shows again", () => {
    const { events } = run([
      user(1, "the prompt"),
      todo(2, "step", "in_progress"),
      todo(3, "step", "completed"),
    ]);
    expect(current(events)).toBe("the prompt");
  });

  test.each(INJECTED_TAGS)("a prompt starting with %s is not a prompt", (tag) => {
    const { events } = run([user(1, `${tag}>injected</x>`), user(2, `  ${tag} a="b">more`)]);
    expect(types(events)).toEqual(["session_start"]);
  });

  test("tool_result content, isMeta and isCompactSummary lines are not prompts", () => {
    const { events } = run([
      user(1, [toolResult("t1")]),
      user(2, "meta text", { isMeta: true }),
      user(3, "summary text", { isCompactSummary: true }),
    ]);
    expect(types(events).filter((t) => t === "turn_start")).toEqual([]);
  });

  test("a text block array is a prompt; an image-only one is not", () => {
    const { events } = run([
      user(1, [
        { type: "text", text: "see this" },
        { type: "image", source: {} },
      ]),
      user(2, [{ type: "image", source: {} }]),
      user(3, "   "),
    ]);
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(1);
    expect(events.find((e) => e.type === "turn_start")!.currentTask).toBe("see this");
  });

  test("paths and secrets in a prompt are redacted before the 120 character cut", () => {
    const secret = "9f8e7d6c5b4a39281706f5e4d3c2b1a0";
    const { events } = run([
      user(1, `look at /repo/src/a.ts and /etc/passwd with ${secret} ${"y".repeat(200)}`),
    ]);
    const task = events.find((e) => e.type === "turn_start")!.currentTask!;
    expect(task.startsWith("look at src/a.ts and [outside project] with [redacted]")).toBe(true);
    expect(task.length).toBeLessThanOrEqual(120);
  });
});

describe("tool calls", () => {
  const call = (name: string, input: unknown) =>
    run([
      assistant(1, "m1", [toolUse("t1", name, input)], { stop_reason: "tool_use" }),
    ]).events.find((e) => e.type === "tool_call")!;

  test.each([
    ["Edit", { file_path: "/repo/a.ts", old_string: "x", new_string: "y" }, "edit"],
    ["Write", { file_path: "/repo/a.ts", content: "body" }, "edit"],
    ["Bash", { command: "git commit -m x" }, "git_commit"],
    ["Bash", { command: "pnpm exec vitest run" }, "test"],
    ["Bash", { command: "vp check" }, "lint"],
    ["Bash", { command: 'echo "vitest"' }, "other"],
    ["Grep", { pattern: "x" }, "other"],
  ])("%s gets class %s", (name, input, expected) => {
    expect(call(name, input).toolClass).toBe(expected);
  });

  test("filesTouched are project-relative for edits, [outside project] otherwise", () => {
    expect(call("Edit", { file_path: "/repo/src/a.ts" }).filesTouched).toEqual(["src/a.ts"]);
    expect(call("Write", { file_path: "/etc/hosts" }).filesTouched).toEqual(["[outside project]"]);
    expect(call("Bash", { command: "ls" }).filesTouched).toBeUndefined();
  });

  test("unknown tool names are cut to 64 characters and redacted (E14)", () => {
    expect(call("mcp__" + "a".repeat(100), {}).toolName).toHaveLength(64);
    expect(call("9f8e7d6c5b4a39281706f5e4d3c2b1a0", {}).toolName).toBe("[redacted]");
  });

  test("a tool call without a name is skipped", () => {
    const { events } = run([assistant(1, "m1", [{ type: "tool_use", id: "t", input: {} }])]);
    expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
  });

  test("no command text, patch body, file content or tool result text appears in any event", () => {
    const secretCommand = "curl --data SECRETCOMMANDTEXT https://example.invalid";
    const patch = "*** Begin Patch\n*** Update File: src/p.ts\n+PATCHBODYTEXT\n*** End Patch";
    const { events } = run([
      user(1, "start"),
      assistant(2, "m1", [
        toolUse("t1", "Bash", { command: secretCommand, description: "DESCRIPTIONTEXT" }),
        toolUse("t2", "apply_patch", patch),
        toolUse("t3", "Write", { file_path: "/repo/w.ts", content: "FILECONTENTTEXT" }),
        toolUse("t4", "Edit", {
          file_path: "/repo/e.ts",
          old_string: "OLDTEXT",
          new_string: "NEWTEXT",
        }),
      ]),
      user(3, [{ ...toolResult("t1"), content: "TOOLRESULTTEXT" }]),
    ]);
    const all = JSON.stringify(events);
    for (const needle of [
      "SECRETCOMMANDTEXT",
      "DESCRIPTIONTEXT",
      "PATCHBODYTEXT",
      "FILECONTENTTEXT",
      "OLDTEXT",
      "NEWTEXT",
      "TOOLRESULTTEXT",
      "curl",
    ]) {
      expect(all).not.toContain(needle);
    }
    expect(events.find((e) => e.toolName === "apply_patch")!.filesTouched).toEqual(["src/p.ts"]);
  });
});

describe("ids (E4)", () => {
  const lines = [
    user(1, "go"),
    assistant(2, "m1", [text(), toolUse("t1", "Read", {}), toolUse("t2", "Read", {})], {
      stop_reason: "end_turn",
    }),
  ];

  test("are stable when the same bytes are parsed again", () => {
    const a = run(lines).events.map((e) => e.id);
    const b = run(lines).events.map((e) => e.id);
    expect(a).toEqual(b);
  });

  test("two events from one line are distinct", () => {
    const { perLine } = run(lines);
    expect(perLine[1].length).toBeGreaterThanOrEqual(4);
    expect(new Set(perLine[1].map((e) => e.id)).size).toBe(perLine[1].length);
  });

  test("a different file identity, offset or content gives new ids", () => {
    const base = run(lines).events.map((e) => e.id);
    expect(run(lines, { identity: "1:43" }).events.map((e) => e.id)).not.toEqual(base);
    const edited = [user(1, "go!"), lines[1]];
    expect(run(edited).events[1].id).not.toBe(base[1]);
    const shifted = ["", ...lines];
    expect(run(shifted).events[0].id).not.toBe(base[0]);
  });

  test("with ino mocked to 0n, renaming a file keeps every id and nothing is counted twice", () => {
    const stat = { dev: 5n, ino: 0n, birthtimeMs: 1_700_000_000_123 };
    const first = JSON.stringify(lines[0]);
    const before = fileIdentity(stat, first)!;
    // After the rename the stat is the same (no inode, same birth time) and the first line is too.
    const after = fileIdentity({ ...stat }, first)!;
    expect(after).toBe(before);
    // The file also grows between the two observations: the size must not enter the identity.
    const a = run(lines, { identity: before, path: "/p/old-name.jsonl" }).events;
    const b = run(lines, { identity: after, path: "/p/new-name.jsonl" }).events;
    expect(b.map((e) => e.id)).toEqual(a.map((e) => e.id));
    const seen = new Set([...a, ...b].map((e) => e.id));
    expect(seen.size).toBe(a.length);
    // The store dedupes by id, so applying both parses counts every token once.
    const once = applyBatch(emptyData(), a);
    const twice = applyBatch(applyBatch(emptyData(), a), b);
    expect(twice.tokens).toEqual(once.tokens);
  });
});

describe("purity and the file state", () => {
  test("the module imports no I/O", () => {
    const source = readFileSync(join(process.cwd(), "sidecar/parsers/claude.ts"), "utf8");
    expect(source).not.toMatch(/from "node:(fs|net|http|child_process)/);
  });

  test("the returned state is usable for the next line (stub-resolver example from the README)", () => {
    const deps = stubDeps();
    let state = createClaudeState({ path: MAIN, identity: "1:42" });
    const out: AgentEvent[] = [];
    for (const [i, line] of [user(1, "hello"), assistant(2, "m1", [text()])].entries()) {
      const r = parseClaudeLine(JSON.stringify(line), i * 1000, state, deps);
      state = r.state;
      out.push(...r.events);
    }
    expect(out.map((e) => e.type)).toEqual(["session_start", "turn_start", "usage"]);
  });

  test("TESTED_VERSIONS names the checked range", () => {
    expect(TESTED_VERSIONS.claude).toEqual({ from: "2.1.260", to: "2.1.295" });
  });
});
