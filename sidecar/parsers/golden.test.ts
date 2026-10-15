import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import { applyBatch, emptyData } from "../../src/data/reduce.ts";
import { AgentEvent } from "../../src/data/schema.ts";
import { parseClaudeText } from "./claude.ts";
import type { ParserDeps } from "./types.ts";

// `vp test` runs from the repository root.
const FIXTURES = join(process.cwd(), "sidecar/parsers/fixtures");
const names = readdirSync(FIXTURES)
  .filter((n) => n.endsWith(".jsonl"))
  .sort();

const deps: ParserDeps = {
  resolveProjectKey: (_session, cwd) => `key:${cwd}`,
  rootProjectKey: (root) => `key:root:${root}`,
  readMeta: () => undefined,
};

interface Total {
  in: number;
  out: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The reference counter: no parser code, just the rule the `jq` reference command states (PLAN
 * DX17). Per message id, the largest value of each token field over its lines; add them up.
 */
function referenceTotal(text: string): Total {
  const best = new Map<string, Total>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const o = JSON.parse(line);
    if (o.type !== "assistant" || !o.message?.usage) continue;
    const u = o.message.usage;
    const cur = best.get(o.message.id) ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    cur.in = Math.max(cur.in, u.input_tokens ?? 0);
    cur.out = Math.max(cur.out, u.output_tokens ?? 0);
    cur.cacheRead = Math.max(cur.cacheRead, u.cache_read_input_tokens ?? 0);
    cur.cacheWrite = Math.max(cur.cacheWrite, u.cache_creation_input_tokens ?? 0);
    best.set(o.message.id, cur);
  }
  const total: Total = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  for (const t of best.values()) {
    total.in += t.in;
    total.out += t.out;
    total.cacheRead += t.cacheRead;
    total.cacheWrite += t.cacheWrite;
  }
  return total;
}

const JQ =
  '[.[] | select(.type=="assistant" and .message.usage != null)] | group_by(.message.id) | map(map(.message.usage) | {in: (map(.input_tokens // 0)|max), out: (map(.output_tokens // 0)|max), cacheRead: (map(.cache_read_input_tokens // 0)|max), cacheWrite: (map(.cache_creation_input_tokens // 0)|max)}) | {in: (map(.in)|add), out: (map(.out)|add), cacheRead: (map(.cacheRead)|add), cacheWrite: (map(.cacheWrite)|add)}';
const hasJq = spawnSync("jq", ["--version"]).status === 0;

const sumUsage = (events: AgentEvent[]): Total => {
  const total: Total = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  for (const e of events) {
    if (e.type !== "usage" || !e.tokens) continue;
    total.in += e.tokens.in;
    total.out += e.tokens.out;
    total.cacheRead += e.tokens.cacheRead;
    total.cacheWrite += e.tokens.cacheWrite;
  }
  return total;
};

test("the golden fixtures exist", () => {
  expect(names).toEqual(["claude-desktop-plan.jsonl", "claude-todowrite.jsonl"]);
});

describe.each(names)("golden fixture %s", (name) => {
  const text = readFileSync(join(FIXTURES, name), "utf8");
  const path = `/home/user/.claude/projects/-repo/${name}`;
  const parsed = parseClaudeText(text, { path, identity: "1:1" }, deps);

  test("the parser's token total equals the reference counter exactly", () => {
    const reference = referenceTotal(text);
    expect(reference.out).toBeGreaterThan(0);
    expect(sumUsage(parsed.events)).toEqual(reference);
    expect(parsed.state.health.tokens).toEqual(reference);
  });

  test.skipIf(!hasJq)("and equals the jq reference command from the format doc", () => {
    const res = spawnSync("jq", ["-s", JQ, join(FIXTURES, name)], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual(referenceTotal(text));
  });

  test("the store counts the same tokens after applying the events", () => {
    const state = applyBatch(emptyData(), parsed.events);
    expect(state.tokens).toEqual(referenceTotal(text));
  });

  test("every event is valid, ids are unique, nothing is malformed, unknown or oversize", () => {
    for (const e of parsed.events) expect(AgentEvent.safeParse(e).success, e.id).toBe(true);
    expect(new Set(parsed.events.map((e) => e.id)).size).toBe(parsed.events.length);
    const h = parsed.state.health;
    expect([h.malformed, h.unknown, h.oversize, h.drift, h.sidechain, h.noTimestamp]).toEqual([
      0, 0, 0, 0, 0, 0,
    ]);
    expect(h.lines).toBe(text.trimEnd().split("\n").length);
  });

  test("parsing the same bytes again gives the same events", () => {
    const again = parseClaudeText(text, { path, identity: "1:1" }, deps);
    expect(again.events).toEqual(parsed.events);
  });

  test("one session: a single session_start, every event in that session", () => {
    expect(parsed.events.filter((e) => e.type === "session_start")).toHaveLength(1);
    expect(new Set(parsed.events.map((e) => e.sessionId)).size).toBe(1);
  });
});

describe("a message whose usage rises across lines (synthetic)", () => {
  const line = (id: string, n: number, usage: Record<string, number>) =>
    JSON.stringify({
      type: "assistant",
      sessionId: "s",
      cwd: "/repo",
      timestamp: `2026-10-14T08:00:0${n}.000Z`,
      message: {
        id,
        role: "assistant",
        model: "claude-opus-5-5",
        stop_reason: null,
        usage,
        content: [{ type: "text", text: "placeholder" }],
      },
    });
  const u = (inp: number, out: number, cr: number, cw: number) => ({
    input_tokens: inp,
    output_tokens: out,
    cache_read_input_tokens: cr,
    cache_creation_input_tokens: cw,
  });
  const text =
    [
      line("m1", 1, u(3, 10, 100, 7)),
      line("m1", 2, u(3, 250, 100, 7)),
      line("m1", 3, u(2, 40, 120, 7)),
      line("m2", 4, u(1, 5, 0, 0)),
      line("m2", 5, u(1, 9, 0, 3)),
    ].join("\n") + "\n";
  const parsed = parseClaudeText(text, { path: "/x/s.jsonl", identity: "1:1" }, deps);

  test("the parser total is the per-field max, equal to the reference counter", () => {
    expect(referenceTotal(text)).toEqual({ in: 4, out: 259, cacheRead: 120, cacheWrite: 10 });
    expect(sumUsage(parsed.events)).toEqual(referenceTotal(text));
    expect(parsed.state.health.tokens).toEqual(referenceTotal(text));
    expect(applyBatch(emptyData(), parsed.events).tokens).toEqual(referenceTotal(text));
  });

  test.skipIf(!hasJq)("and equals the jq command", () => {
    const res = spawnSync("jq", ["-s", JQ], { input: text, encoding: "utf8" });
    expect(JSON.parse(res.stdout)).toEqual(referenceTotal(text));
  });

  test("the line that fell below the maximum is drift", () => {
    expect(parsed.state.health.drift).toBe(1);
  });
});

describe("what each fixture shows (counts are of events by type)", () => {
  const count = (events: AgentEvent[], type: string) =>
    events.filter((e) => e.type === type).length;
  const parse = (name: string) =>
    parseClaudeText(
      readFileSync(join(FIXTURES, name), "utf8"),
      { path: `/x/${name}`, identity: "1:1" },
      deps,
    );

  test("claude-desktop-plan: update_plan items and advance, failed tool results, no real prompt", () => {
    const { events } = parse("claude-desktop-plan.jsonl");
    expect(count(events, "session_start")).toBe(1);
    expect(count(events, "turn_start")).toBe(0);
    expect(count(events, "status")).toBeGreaterThan(6);
    expect(events.filter((e) => e.toolError).length).toBe(3);
    expect(events.filter((e) => e.type === "status").every((e) => e.status === undefined)).toBe(
      true,
    );
  });

  test("claude-todowrite: prompts, TodoWrite, api_error, end_turn, a failed tool result, file edits", () => {
    const { events, state } = parse("claude-todowrite.jsonl");
    expect(count(events, "turn_start")).toBeGreaterThan(5);
    expect(count(events, "turn_end")).toBeGreaterThan(5);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events.filter((e) => e.toolError)).toHaveLength(1);
    expect(events.some((e) => e.todo?.status === "completed")).toBe(true);
    expect(events.some((e) => (e.filesTouched ?? []).some((f) => f.startsWith("src/")))).toBe(true);
    expect(events.some((e) => e.toolClass === "git_commit")).toBe(true);
    expect(state.health.ignored).toBeGreaterThan(50);
    // The session ends in the error state the api_error set, as the store sees it.
    expect(applyBatch(emptyData(), events).sessions.get(events[0].sessionId)).toBeDefined();
  });
});
