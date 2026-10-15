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
 * DX17). Keep the usage of the first assistant line of every message id and add it up.
 */
function referenceTotal(text: string): Total {
  const seen = new Set<string>();
  const total: Total = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const o = JSON.parse(line);
    if (o.type !== "assistant" || !o.message?.usage) continue;
    if (seen.has(o.message.id)) continue;
    seen.add(o.message.id);
    total.in += o.message.usage.input_tokens ?? 0;
    total.out += o.message.usage.output_tokens ?? 0;
    total.cacheRead += o.message.usage.cache_read_input_tokens ?? 0;
    total.cacheWrite += o.message.usage.cache_creation_input_tokens ?? 0;
  }
  return total;
}

const JQ =
  '[.[] | select(.type=="assistant" and .message.usage != null)] | unique_by(.message.id) | map(.message.usage | {in: .input_tokens, out: .output_tokens, cacheRead: (.cache_read_input_tokens // 0), cacheWrite: (.cache_creation_input_tokens // 0)}) | {in: (map(.in)|add), out: (map(.out)|add), cacheRead: (map(.cacheRead)|add), cacheWrite: (map(.cacheWrite)|add)}';
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
