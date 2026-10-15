import { describe, expect, test } from "vite-plus/test";
import { PLAN_TOOLS, applyPlan, activeText, type PlanItem } from "./planTools.ts";

const todo = (...entries: [string, string][]) => ({
  todos: entries.map(([content, status]) => ({ content, status, activeForm: `${content}ing` })),
});
const items = (...entries: [string, string][]) => ({
  items: entries.map(([content, status]) => ({ content, status })),
  scope: "first_task",
});
const run = (tool: string, input: unknown, current: PlanItem[] = []) =>
  applyPlan("s1", tool, input, current);

describe("the table", () => {
  test("names TodoWrite and the desktop plan tool", () => {
    expect(Object.keys(PLAN_TOOLS).sort()).toEqual(["TodoWrite", "mcp__ccd_turn__update_plan"]);
  });
});

describe("TodoWrite", () => {
  test("a first list gives one change per item with its status", () => {
    const r = run("TodoWrite", todo(["write tests", "in_progress"], ["ship it", "pending"]));
    expect(r?.list.map((i) => [i.text, i.status])).toEqual([
      ["write tests", "in_progress"],
      ["ship it", "pending"],
    ]);
    expect(r?.changes.map((c) => c.status)).toEqual(["in_progress", "pending"]);
  });

  test("a resent identical list changes nothing", () => {
    const first = run("TodoWrite", todo(["a", "pending"], ["b", "in_progress"]))!;
    const again = run("TodoWrite", todo(["a", "pending"], ["b", "in_progress"]), first.list)!;
    expect(again.changes).toEqual([]);
  });

  test("a status change is one change for that item only", () => {
    const first = run("TodoWrite", todo(["a", "in_progress"], ["b", "pending"]))!;
    const next = run("TodoWrite", todo(["a", "completed"], ["b", "in_progress"]), first.list)!;
    expect(next.changes.map((c) => [c.id === first.list[0].id, c.status])).toEqual([
      [true, "completed"],
      [false, "in_progress"],
    ]);
    expect(next.changes[1].id).toBe(first.list[1].id);
  });

  test("an item inserted at index 0 keeps every other id and adds one change", () => {
    const first = run("TodoWrite", todo(["a", "pending"], ["b", "pending"]))!;
    const next = run(
      "TodoWrite",
      todo(["new first", "pending"], ["a", "pending"], ["b", "pending"]),
      first.list,
    )!;
    expect(next.list.slice(1).map((i) => i.id)).toEqual(first.list.map((i) => i.id));
    expect(next.changes).toHaveLength(1);
    expect(next.changes[0].id).toBe(next.list[0].id);
  });

  test("a reworded item gives one cancelled and one new item, never a completion", () => {
    const first = run("TodoWrite", todo(["fix the bug", "in_progress"], ["b", "pending"]))!;
    const next = run(
      "TodoWrite",
      todo(["fix the login bug", "in_progress"], ["b", "pending"]),
      first.list,
    )!;
    expect(next.changes.map((c) => c.status).sort()).toEqual(["cancelled", "in_progress"]);
    expect(next.changes.find((c) => c.status === "cancelled")?.id).toBe(first.list[0].id);
    expect(next.changes.some((c) => c.status === "completed")).toBe(false);
  });

  test("a completed item dropped from the list is not cancelled", () => {
    const first = run("TodoWrite", todo(["a", "completed"], ["b", "pending"]))!;
    const next = run("TodoWrite", todo(["b", "pending"]), first.list)!;
    expect(next.changes).toEqual([]);
  });

  test("duplicate texts get distinct ids by occurrence; case and spacing do not matter", () => {
    const r = run("TodoWrite", todo(["Same", "pending"], ["same  ", "pending"]))!;
    expect(new Set(r.list.map((i) => i.id)).size).toBe(2);
    const other = run("TodoWrite", todo(["  SAME", "pending"]))!;
    expect(other.list[0].id).toBe(r.list[0].id);
  });

  test("ids depend on the session and the tool", () => {
    const a = applyPlan("s1", "TodoWrite", todo(["a", "pending"]), [])!;
    const b = applyPlan("s2", "TodoWrite", todo(["a", "pending"]), [])!;
    expect(a.list[0].id).not.toBe(b.list[0].id);
  });

  test("unknown statuses become pending; entries without text are skipped", () => {
    const r = run("TodoWrite", {
      todos: [{ content: "a", status: "weird" }, { status: "pending" }, "x", null],
    })!;
    expect(r.list.map((i) => [i.text, i.status])).toEqual([["a", "pending"]]);
  });

  test("bad input is not a plan change", () => {
    expect(run("TodoWrite", { todos: "no" })).toBeUndefined();
    expect(run("TodoWrite", null)).toBeUndefined();
    expect(run("Other", todo(["a", "pending"]))).toBeUndefined();
  });
});

describe("update_plan", () => {
  const tool = "mcp__ccd_turn__update_plan";

  test("items replaces the list", () => {
    const first = run(tool, items(["a", "in_progress"], ["b", "pending"]))!;
    expect(first.list).toHaveLength(2);
    const next = run(tool, items(["a", "completed"], ["c", "in_progress"]), first.list)!;
    expect(next.changes.map((c) => c.status).sort()).toEqual([
      "cancelled",
      "completed",
      "in_progress",
    ]);
  });

  test("advance completes the active item and starts the next pending one", () => {
    const first = run(tool, items(["a", "in_progress"], ["b", "pending"], ["c", "pending"]))!;
    const next = run(tool, { advance: true }, first.list)!;
    expect(next.list.map((i) => i.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(next.changes).toHaveLength(2);
  });

  test("advance with nothing active starts the first pending item", () => {
    const first = run(tool, items(["a", "pending"], ["b", "pending"]))!;
    const next = run(tool, { advance: true }, first.list)!;
    expect(next.list.map((i) => i.status)).toEqual(["in_progress", "pending"]);
  });

  test("advance on the last item completes it and starts nothing", () => {
    const first = run(tool, items(["a", "completed"], ["b", "in_progress"]))!;
    const next = run(tool, { advance: true }, first.list)!;
    expect(next.list.map((i) => i.status)).toEqual(["completed", "completed"]);
    expect(next.changes).toHaveLength(1);
  });

  test("done and start use 1-based positions", () => {
    const first = run(tool, items(["a", "pending"], ["b", "pending"], ["c", "pending"]))!;
    const next = run(tool, { done: [1, 2], start: 3 }, first.list)!;
    expect(next.list.map((i) => i.status)).toEqual(["completed", "completed", "in_progress"]);
    expect(next.changes).toHaveLength(3);
  });

  test("done alone, and out-of-range positions, are tolerated", () => {
    const first = run(tool, items(["a", "in_progress"], ["b", "pending"]))!;
    const next = run(tool, { done: [1, 9, "x", 0] }, first.list)!;
    expect(next.list.map((i) => i.status)).toEqual(["completed", "pending"]);
    expect(run(tool, { start: 99 }, first.list)?.changes).toEqual([]);
  });

  test("advance with no list, or an unknown shape, is not a plan change", () => {
    expect(run(tool, { advance: true })).toBeUndefined();
    expect(run(tool, { nothing: 1 })).toBeUndefined();
    expect(run(tool, "text")).toBeUndefined();
  });

  test("start leaves the other items alone", () => {
    const first = run(tool, items(["a", "in_progress"], ["b", "pending"]))!;
    const next = run(tool, { start: 2 }, first.list)!;
    expect(next.list.map((i) => i.status)).toEqual(["in_progress", "in_progress"]);
  });
});

describe("activeText", () => {
  test("is the first in-progress item's text, or undefined", () => {
    const r = run("TodoWrite", todo(["a", "pending"], ["doing b", "in_progress"]))!;
    expect(activeText(r.list)).toBe("doing b");
    expect(activeText(run("TodoWrite", todo(["a", "pending"]))!.list)).toBeUndefined();
  });
});
