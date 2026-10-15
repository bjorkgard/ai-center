import { shortHash } from "./ids.ts";

export type PlanStatus = "pending" | "in_progress" | "completed";

export interface PlanItem {
  id: string;
  text: string;
  status: PlanStatus;
}

/** One item whose state changed; `cancelled` means a new full list dropped it. */
export interface PlanChange {
  id: string;
  text: string;
  status: PlanStatus | "cancelled";
}

interface Entry {
  text: string;
  status: PlanStatus;
}

interface PlanTool {
  /** The list after the call, or undefined when the input is not a plan change of this tool. */
  next(input: unknown, current: readonly PlanItem[]): Entry[] | undefined;
  /** A full list replaces the old one, so items missing from it are cancelled. */
  replaces(input: unknown): boolean;
}

const STATUSES = new Set<string>(["pending", "in_progress", "completed"]);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function entries(list: unknown): Entry[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: Entry[] = [];
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.content !== "string" || raw.content.trim() === "") continue;
    const status =
      typeof raw.status === "string" && STATUSES.has(raw.status) ? raw.status : "pending";
    out.push({ text: raw.content, status: status as PlanStatus });
  }
  return out;
}

const copy = (list: readonly PlanItem[]): Entry[] =>
  list.map((i) => ({ text: i.text, status: i.status }));

/** Positions in update_plan are 1-based (measured: `done: [1, 2], start: 3`). */
function patch(input: Record<string, unknown>, current: readonly PlanItem[]): Entry[] | undefined {
  if (current.length === 0) return undefined;
  const list = copy(current);
  if (input.advance === true) {
    const active = list.findIndex((i) => i.status === "in_progress");
    if (active >= 0) list[active].status = "completed";
    const from = active >= 0 ? active + 1 : 0;
    const next = list.findIndex((i, at) => at >= from && i.status === "pending");
    if (next >= 0) list[next].status = "in_progress";
    return list;
  }
  if (Array.isArray(input.done) || typeof input.start === "number") {
    if (Array.isArray(input.done)) {
      for (const n of input.done) {
        if (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= list.length) {
          list[(n as number) - 1].status = "completed";
        }
      }
    }
    const start = input.start;
    if (
      typeof start === "number" &&
      Number.isInteger(start) &&
      start >= 1 &&
      start <= list.length
    ) {
      list[start - 1].status = "in_progress";
    }
    return list;
  }
  return undefined;
}

// The one table from a plan tool to its list semantics (C82, X5). The desktop tool is best
// effort: its shapes come from one machine.
export const PLAN_TOOLS: Record<string, PlanTool> = {
  TodoWrite: {
    next: (input) => (isRecord(input) ? entries(input.todos) : undefined),
    replaces: () => true,
  },
  mcp__ccd_turn__update_plan: {
    next: (input, current) => {
      if (!isRecord(input)) return undefined;
      return Array.isArray(input.items) ? entries(input.items) : patch(input, current);
    },
    replaces: (input) => isRecord(input) && Array.isArray(input.items),
  },
};

const normalise = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** Ids come from the session, tool, normalised text and which duplicate of that text it is. */
function build(sessionId: string, tool: string, list: Entry[]): PlanItem[] {
  const seen = new Map<string, number>();
  return list.map((e) => {
    const key = normalise(e.text);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return { id: shortHash(sessionId, tool, key, occurrence), text: e.text, status: e.status };
  });
}

/**
 * Applies one plan tool call. `changes` lists items that are new, changed status, or (for a full
 * list) were dropped while still open, in list order with the dropped ones last. Items that were
 * already completed are not cancelled when a new list leaves them out.
 */
export function applyPlan(
  sessionId: string,
  tool: string,
  input: unknown,
  current: readonly PlanItem[],
): { list: PlanItem[]; changes: PlanChange[] } | undefined {
  const def = Object.hasOwn(PLAN_TOOLS, tool) ? PLAN_TOOLS[tool] : undefined;
  const entriesAfter = def?.next(input, current);
  if (!def || entriesAfter === undefined) return undefined;
  const list = build(sessionId, tool, entriesAfter);
  const before = new Map(current.map((i) => [i.id, i]));
  const changes: PlanChange[] = [];
  for (const item of list) {
    if (before.get(item.id)?.status !== item.status) {
      changes.push({ id: item.id, text: item.text, status: item.status });
    }
  }
  if (def.replaces(input)) {
    const kept = new Set(list.map((i) => i.id));
    for (const old of current) {
      if (!kept.has(old.id) && old.status !== "completed") {
        changes.push({ id: old.id, text: old.text, status: "cancelled" });
      }
    }
  }
  return { list, changes };
}

/** The text of the item in progress, if any: what the agent is working on. */
export function activeText(list: readonly PlanItem[]): string | undefined {
  return list.find((i) => i.status === "in_progress")?.text;
}
