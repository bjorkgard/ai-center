import { expect, test } from "vite-plus/test";
import { AgentEvent, MAX_BATCH } from "./schema.ts";

const valid = {
  id: "e1",
  vendor: "claude",
  projectKey: "/work/orbit-api",
  sessionId: "s1",
  parentKnown: true,
  agentKind: "main",
  ts: "2026-01-01T09:00:00.000Z",
  type: "tool_call",
  status: "tool",
  toolName: "Read",
  tokens: { in: 1, out: 2, cacheRead: 0, cacheWrite: 0 },
  provenance: { toolName: "real" },
};

test("a full event parses and an event without its optional fields parses", () => {
  expect(AgentEvent.safeParse(valid).success).toBe(true);
  const { status, toolName, tokens, ...bare } = valid;
  void status;
  void toolName;
  void tokens;
  expect(AgentEvent.safeParse(bare).success).toBe(true);
});

test("an unknown type, a missing field and a bad timestamp are rejected with their path", () => {
  const paths = (input: unknown) => {
    const result = AgentEvent.safeParse(input);
    return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
  };
  expect(paths({ ...valid, type: "nope" })).toEqual(["type"]);
  expect(paths({ ...valid, sessionId: undefined })).toEqual(["sessionId"]);
  expect(paths({ ...valid, ts: "yesterday" })).toEqual(["ts"]);
  expect(paths({ ...valid, tokens: { in: "1" } })).toContain("tokens.in");
});

test("every source delivers at most 500 events a batch", () => {
  expect(MAX_BATCH).toBe(500);
});
