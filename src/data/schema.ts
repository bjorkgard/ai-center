import * as z from "zod/mini";
import type { SimClock } from "./clock.ts";

// The normalised event model of PLAN section 2, shared by the log server (Node), the browser
// store and the mock. Only Node-runnable imports here (CEO C30, eng E31).
export const AgentEvent = z.object({
  id: z.string(),
  vendor: z.enum(["claude", "codex"]),
  projectKey: z.string(),
  sessionId: z.string(),
  parentSessionId: z.optional(z.string()),
  parentKnown: z.boolean(),
  agentKind: z.enum(["main", "sub"]),
  model: z.optional(z.string()),
  ts: z.iso.datetime(),
  type: z.enum([
    "session_start",
    "session_end",
    "turn_start",
    "turn_end",
    "tool_call",
    "tool_result",
    "usage",
    "status",
    "error",
  ]),
  status: z.optional(z.enum(["idle", "thinking", "tool", "waiting_user", "error", "done"])),
  currentTask: z.optional(z.string()),
  toolName: z.optional(z.string()),
  // A TodoWrite item (its text goes through currentTask) and the class of a tool call, both set
  // by the Node parsers so raw commands never reach the browser (D16).
  todo: z.optional(
    z.object({ id: z.string(), status: z.enum(["pending", "in_progress", "completed"]) }),
  ),
  toolClass: z.optional(z.enum(["edit", "git_commit", "test", "lint", "other"])),
  filesTouched: z.optional(z.array(z.string())),
  tokens: z.optional(
    z.object({ in: z.number(), out: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
  ),
  raw: z.optional(z.object({ file: z.string(), offset: z.number() })),
  provenance: z.record(z.string(), z.enum(["real", "derived", "estimated"])),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

// Every source delivers batches of at most this many events (eng E32).
export const MAX_BATCH = 500;

export type SourceStatus = "connecting" | "catching_up" | "live" | "closed" | "error";

// A stream of event batches (CEO C34). stop() is idempotent; once it returns, no event or
// status is delivered. Callbacks are set before start().
export interface Source {
  readonly name: string;
  // The source's time base (C48); the store makes a locked 1x live clock when it is absent.
  readonly clock?: SimClock;
  start(): void;
  stop(): void;
  onEvents(callback: (events: unknown[]) => void): void;
  onStatus(callback: (status: SourceStatus, detail?: string) => void): void;
}
