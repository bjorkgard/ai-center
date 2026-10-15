import type { AgentEvent } from "./schema.ts";

// The job model of PLAN section 2 (derived): a job is the active TodoWrite item when there is
// one, otherwise one user-prompt turn. Stage names follow the plan's order.
export type JobStage = "queued" | "scheduled" | "running" | "checkpoint" | "evaluating" | "done";

export interface JobAgg {
  sessionId: string;
  projectKey: string;
  kind: "todo" | "turn";
  stage: JobStage;
  // The event that set the stage, so an older event never overwrites a newer one.
  stageAt: number;
  stageId: string;
}

// The slice of a session the job rules read and write.
export interface JobSession {
  activeTodo?: string;
}

const TURN = "turn";
export const jobKey = (sessionId: string, id: string): string => `${sessionId}\u0000${id}`;
const todoId = (id: string): string => `todo:${id}`;

const STAGE_OF_TOOL: Record<NonNullable<AgentEvent["toolClass"]>, JobStage> = {
  edit: "checkpoint",
  git_commit: "checkpoint",
  test: "evaluating",
  lint: "evaluating",
  other: "running",
};

// Applies one event to a jobs map the caller owns (copy-on-write happens there).
export function applyJobEvent(
  jobs: Map<string, JobAgg>,
  session: JobSession,
  e: AgentEvent,
  at: number,
): void {
  const set = (id: string, kind: JobAgg["kind"], stage: JobStage) => {
    const key = jobKey(e.sessionId, id);
    const cur = jobs.get(key);
    if (cur && !(at > cur.stageAt || (at === cur.stageAt && e.id > cur.stageId))) return;
    jobs.set(key, {
      sessionId: e.sessionId,
      projectKey: e.projectKey,
      kind,
      stage,
      stageAt: at,
      stageId: e.id,
    });
  };

  if (e.todo) {
    const id = todoId(e.todo.id);
    const cur = jobs.get(jobKey(e.sessionId, id));
    if (e.todo.status === "completed") {
      set(id, "todo", "done");
      if (session.activeTodo === e.todo.id) session.activeTodo = undefined;
    } else if (e.todo.status === "in_progress") {
      session.activeTodo = e.todo.id;
      // TodoWrite resends the whole list: an item already past Scheduled stays where it is.
      if (!cur || cur.stage === "queued") set(id, "todo", "scheduled");
    } else if (!cur) {
      set(id, "todo", "queued");
    }
  }

  if (e.type === "turn_start") set(TURN, "turn", "scheduled");
  else if (e.type === "turn_end") set(TURN, "turn", "done");
  else if (e.type === "tool_call") {
    const stage = STAGE_OF_TOOL[e.toolClass ?? "other"];
    if (session.activeTodo !== undefined) set(todoId(session.activeTodo), "todo", stage);
    else set(TURN, "turn", stage);
  }
}

export function dropJobsOf(jobs: Map<string, JobAgg>, sessionIds: ReadonlySet<string>): void {
  for (const [key, job] of jobs) if (sessionIds.has(job.sessionId)) jobs.delete(key);
}
