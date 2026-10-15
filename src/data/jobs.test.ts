import { expect, test } from "vite-plus/test";
import { jobKey, type JobStage } from "./jobs.ts";
import { applyBatch, emptyData, type DataState } from "./reduce.ts";
import type { AgentEvent } from "./schema.ts";

const T0 = Date.UTC(2026, 0, 1, 9, 0, 0);
let n = 0;
function ev(over: Partial<AgentEvent> & { sec: number }): AgentEvent {
  n++;
  const { sec, ...rest } = over;
  return {
    id: `j${String(n).padStart(4, "0")}`,
    vendor: "claude",
    projectKey: "/work/orbit-api",
    sessionId: "s1",
    parentKnown: true,
    agentKind: "main",
    ts: new Date(T0 + sec * 1000).toISOString(),
    type: "tool_call",
    provenance: {},
    ...rest,
  };
}
const run = (...events: AgentEvent[]): DataState => applyBatch(emptyData(), events);
// "turn" stands for the session's latest turn job: each turn_start makes its own job.
const stage = (s: DataState, id: string, session = "s1"): JobStage | undefined => {
  if (id !== "turn") return s.jobs.get(jobKey(session, id))?.stage;
  const turns = [...s.jobs.values()].filter((j) => j.sessionId === session && j.kind === "turn");
  return turns.sort((a, b) => b.stageAt - a.stageAt)[0]?.stage;
};

test("a turn without todos is one job: scheduled, running, then done at turn end", () => {
  expect(stage(run(ev({ sec: 0, type: "turn_start" })), "turn")).toBe("scheduled");
  expect(
    stage(run(ev({ sec: 0, type: "turn_start" }), ev({ sec: 1, toolClass: "other" })), "turn"),
  ).toBe("running");
  expect(
    stage(
      run(
        ev({ sec: 0, type: "turn_start" }),
        ev({ sec: 1 }),
        ev({ sec: 2, type: "turn_end", status: "waiting_user" }),
      ),
      "turn",
    ),
  ).toBe("done");
});

test("an edit or a commit is a checkpoint, a test or lint run is evaluating", () => {
  const after = (toolClass: AgentEvent["toolClass"]) =>
    stage(run(ev({ sec: 0, type: "turn_start" }), ev({ sec: 1, toolClass })), "turn");
  expect(after("edit")).toBe("checkpoint");
  expect(after("git_commit")).toBe("checkpoint");
  expect(after("test")).toBe("evaluating");
  expect(after("lint")).toBe("evaluating");
  expect(after("other")).toBe("running");
  expect(after(undefined)).toBe("running");
});

test("the stage follows the latest tool call", () => {
  const s = run(
    ev({ sec: 0, type: "turn_start" }),
    ev({ sec: 1, toolClass: "edit" }),
    ev({ sec: 2, toolClass: "test" }),
    ev({ sec: 3, toolClass: "other" }),
  );
  expect(stage(s, "turn")).toBe("running");
});

test("an event older than the one that set the stage does not move it", () => {
  const s = run(ev({ sec: 5, toolClass: "test" }), ev({ sec: 2, toolClass: "edit" }));
  expect(stage(s, "turn")).toBe("evaluating");
});

test("todo items: pending is queued, in progress is scheduled, completed is done", () => {
  const pending = run(ev({ sec: 0, type: "status", todo: { id: "a", status: "pending" } }));
  expect(stage(pending, "todo:a")).toBe("queued");
  const active = run(
    ev({ sec: 0, type: "status", todo: { id: "a", status: "pending" } }),
    ev({ sec: 1, type: "status", todo: { id: "a", status: "in_progress" } }),
  );
  expect(stage(active, "todo:a")).toBe("scheduled");
  const done = run(
    ev({ sec: 0, type: "status", todo: { id: "a", status: "in_progress" } }),
    ev({ sec: 1, type: "status", todo: { id: "a", status: "completed" } }),
  );
  expect(stage(done, "todo:a")).toBe("done");
});

test("with an active todo the tool calls drive the todo's job, not the turn's", () => {
  const s = run(
    ev({ sec: 0, type: "turn_start" }),
    ev({ sec: 1, type: "status", todo: { id: "a", status: "in_progress" } }),
    ev({ sec: 2, toolClass: "edit" }),
  );
  expect(stage(s, "todo:a")).toBe("checkpoint");
  expect(stage(s, "turn")).toBe("scheduled");
});

test("TodoWrite resending an in-progress item does not reset its stage", () => {
  const s = run(
    ev({ sec: 0, type: "status", todo: { id: "a", status: "in_progress" } }),
    ev({ sec: 1, toolClass: "test" }),
    ev({ sec: 2, type: "status", todo: { id: "a", status: "in_progress" } }),
  );
  expect(stage(s, "todo:a")).toBe("evaluating");
});

test("a completed todo hands tool calls back to the turn", () => {
  const s = run(
    ev({ sec: 0, type: "status", todo: { id: "a", status: "in_progress" } }),
    ev({ sec: 1, type: "status", todo: { id: "a", status: "completed" } }),
    ev({ sec: 2, toolClass: "lint" }),
  );
  expect(stage(s, "todo:a")).toBe("done");
  expect(stage(s, "turn")).toBe("evaluating");
});

test("each turn is its own job: a second turn_start does not overwrite the first", () => {
  const s = run(
    ev({ sec: 0, type: "turn_start" }),
    ev({ sec: 1, toolClass: "test" }),
    ev({ sec: 2, type: "turn_end" }),
    ev({ sec: 3, type: "turn_start" }),
    ev({ sec: 4, toolClass: "edit" }),
  );
  const turns = [...s.jobs.values()].filter((j) => j.kind === "turn");
  expect(turns.map((j) => j.stage).sort()).toEqual(["checkpoint", "done"]);
  // A tool call goes to the turn in progress, not an older one.
  const later = applyBatch(s, [ev({ sec: 5, toolClass: "lint" })]);
  expect(
    [...later.jobs.values()]
      .filter((j) => j.kind === "turn")
      .map((j) => j.stage)
      .sort(),
  ).toEqual(["done", "evaluating"]);
});

test("a stale in-progress or completed todo event does not change the active todo", () => {
  const s = run(
    ev({ sec: 5, type: "status", todo: { id: "b", status: "in_progress" } }),
    // Older: neither takes over nor clears.
    ev({ sec: 2, type: "status", todo: { id: "a", status: "in_progress" } }),
    ev({ sec: 3, type: "status", todo: { id: "b", status: "completed" } }),
    ev({ sec: 6, toolClass: "edit" }),
  );
  expect(stage(s, "todo:b")).toBe("checkpoint");
  // Nothing went to a turn job.
  expect([...s.jobs.values()].some((j) => j.kind === "turn")).toBe(false);
});
