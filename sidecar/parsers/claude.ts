import type { AgentEvent } from "../../src/data/schema.ts";
import { eventId, lineHash } from "./ids.ts";
import { activeText, applyPlan, PLAN_TOOLS, type PlanItem } from "./planTools.ts";
import { redact, redactPath } from "./redact.ts";
import { classifyTool, toolPaths } from "./toolClass.ts";
import { MAX_LINE_BYTES, type ParserDeps, type ParserHealth, type ParseResult } from "./types.ts";

// Line types the parser knows it does not map (C90). Anything else that is not mapped is
// counted `unknown`, so "unknown" means "new".
export const IGNORED_TYPES = [
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
  "fork-context-ref",
] as const;
export const IGNORED_SYSTEM_SUBTYPES = [
  "stop_hook_summary",
  "turn_duration",
  "away_summary",
  "local_command",
  "compact_boundary",
  "informational",
  "scheduled_task_fire",
] as const;
// A user line starting with one of these is the harness talking, not the person (C82).
export const INJECTED_TAGS = [
  "<task-notification",
  "<command-message",
  "<command-name",
  "<ci-monitor-event",
  "<bash-input",
  "<system-reminder",
  "<local-command-stdout",
  "<bash-stdout",
] as const;

const IGNORED = new Set<string>(IGNORED_TYPES);
const IGNORED_SUBTYPES = new Set<string>(IGNORED_SYSTEM_SUBTYPES);
const SUBAGENT_FILE = /[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/;
const NAME_LIMIT = 64;
const TOOL_MEMORY = 2000;
const MAX_VERSIONS = 20;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

type Record_ = Record<string, unknown>;
type Tokens = NonNullable<AgentEvent["tokens"]>;
type Provenance = AgentEvent["provenance"];

/**
 * Everything the parser remembers about one file. The caller owns it: it is updated in place and
 * returned from each call, and a new one is made when the file is truncated or replaced.
 */
export interface ClaudeFileState {
  readonly path: string;
  /** The file's base name, the only part of the path that ends up in events. */
  readonly label: string;
  /** The file identity ids are built from (`fileIdentity` in ids.ts). */
  readonly identity: string;
  /** Set for `<session>/subagents/agent-<id>.jsonl`. */
  readonly subagent: { agentId: string; metaPath: string } | undefined;
  agentType: string | undefined;
  metaRead: boolean;
  session: { id: string; parentId: string | undefined; cwd: string } | undefined;
  lastTs: string | undefined;
  /** Counts what happened last among prompts and plan items, so "newest" needs no clock. */
  seq: number;
  usage: Map<string, Tokens>;
  ended: Set<string>;
  tools: Map<string, string>;
  plans: Record<string, PlanItem[]>;
  planActive: { tool: string; text: string; seq: number } | undefined;
  prompt: { text: string; seq: number } | undefined;
  health: ParserHealth;
}

export function createClaudeState(options: { path: string; identity: string }): ClaudeFileState {
  const { path, identity } = options;
  const sub = SUBAGENT_FILE.exec(path);
  return {
    path,
    label: path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1),
    identity,
    subagent: sub
      ? { agentId: sub[1], metaPath: path.replace(/\.jsonl$/, ".meta.json") }
      : undefined,
    agentType: undefined,
    metaRead: false,
    session: undefined,
    lastTs: undefined,
    seq: 0,
    usage: new Map(),
    ended: new Set(),
    tools: new Map(),
    plans: {},
    planActive: undefined,
    prompt: undefined,
    health: {
      lines: 0,
      malformed: 0,
      unknown: 0,
      oversize: 0,
      ignored: 0,
      drift: 0,
      sidechain: 0,
      noTimestamp: 0,
      events: 0,
      firstOffsets: {},
      unknownTypes: {},
      versions: [],
      tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
}

const isRecord = (v: unknown): v is Record_ =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

type Counter = "malformed" | "unknown" | "oversize" | "drift" | "sidechain" | "noTimestamp";
function note(state: ClaudeFileState, counter: Counter, offset: number): void {
  state.health[counter]++;
  state.health.firstOffsets[counter] ??= offset;
}

// A type name is printed in health rows and probe output, so only plain lowercase words pass;
// anything shaped like an id prints as a placeholder.
const typeLabel = (v: unknown): string => {
  if (v === undefined) return "-";
  const name = typeof v === "string" ? v.slice(0, 40) : "";
  return /^[a-z][a-z0-9_.:-]*$/.test(name) && (name.match(/\d/g)?.length ?? 0) <= 2
    ? name
    : "<other>";
};

function tokensOf(usage: Record_): Tokens {
  return {
    in: num(usage.input_tokens),
    out: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
  };
}

const sameTokens = (a: Tokens, b: Tokens) =>
  a.in === b.in && a.out === b.out && a.cacheRead === b.cacheRead && a.cacheWrite === b.cacheWrite;

const lowerAnywhere = (counted: Tokens, line: Tokens) =>
  line.in < counted.in ||
  line.out < counted.out ||
  line.cacheRead < counted.cacheRead ||
  line.cacheWrite < counted.cacheWrite;

const isInjected = (text: string) => INJECTED_TAGS.some((tag) => text.startsWith(tag));

/** The text of a real prompt, or undefined when the line is a tool result, meta or injected. */
function promptText(o: Record_, content: unknown): string | undefined {
  if (o.isMeta === true || o.isCompactSummary === true) return undefined;
  let raw: string;
  if (typeof content === "string") raw = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => isRecord(b) && b.type === "tool_result")) return undefined;
    raw = content
      .filter((b): b is Record_ => isRecord(b) && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n");
  } else return undefined;
  const text = raw.trim();
  return text === "" || isInjected(text) ? undefined : text;
}

/**
 * Parses one complete line of a Claude Code session file. Pure: no I/O, no clock; everything
 * outside the line comes in through `state` and `deps`. `byteOffset` is where the line starts in
 * the file. Returns the events the line makes and the (same, updated) state.
 */
export function parseClaudeLine(
  line: string,
  byteOffset: number,
  state: ClaudeFileState,
  deps: ParserDeps,
): ParseResult<ClaudeFileState> {
  const health = state.health;
  health.lines++;
  const none = { events: [] as AgentEvent[], state };
  if (
    line.length > MAX_LINE_BYTES ||
    (line.length * 3 > MAX_LINE_BYTES && Buffer.byteLength(line) > MAX_LINE_BYTES)
  ) {
    note(state, "oversize", byteOffset);
    return none;
  }
  if (line.trim() === "") return none;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    note(state, "malformed", byteOffset);
    return none;
  }
  if (!isRecord(value)) {
    note(state, "malformed", byteOffset);
    return none;
  }
  const o = value;

  const version = str(o.version);
  if (
    version !== undefined &&
    VERSION.test(version) &&
    health.versions.length < MAX_VERSIONS &&
    !health.versions.includes(version)
  ) {
    health.versions.push(version);
  }
  const parsedTs = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
  const lineTs = Number.isNaN(parsedTs) ? undefined : new Date(parsedTs).toISOString();
  if (lineTs !== undefined) state.lastTs = lineTs;
  const ts = lineTs ?? state.lastTs;

  const out: AgentEvent[] = [];
  let hash: string | undefined;
  let key: string | undefined;
  const emit = (type: AgentEvent["type"], fields: Partial<AgentEvent>, provenance: Provenance) => {
    const s = state.session;
    if (!s || ts === undefined) return;
    hash ??= lineHash(line);
    key ??=
      s.parentId === undefined
        ? deps.resolveProjectKey(s.id, s.cwd)
        : deps.rootProjectKey(s.parentId, s.cwd);
    const event: AgentEvent = {
      id: eventId("claude", state.identity, byteOffset, hash, out.length),
      vendor: "claude",
      projectKey: key,
      sessionId: s.id,
      parentKnown: true,
      agentKind: s.parentId === undefined ? "main" : "sub",
      ts,
      type,
      ...fields,
      raw: { file: state.label, offset: byteOffset },
      provenance: { projectKey: "derived", ...provenance },
    };
    if (s.parentId !== undefined) event.parentSessionId = s.parentId;
    out.push(event);
  };

  // The session starts on the first line that names a session, a time and a directory,
  // whatever its type.
  if (!state.session) {
    const sessionId = str(o.sessionId);
    const cwd = str(o.cwd);
    if (sessionId !== undefined && cwd !== undefined && lineTs !== undefined) {
      const sub = state.subagent;
      state.session = {
        id: sub ? sub.agentId : sessionId,
        parentId: sub ? sessionId : undefined,
        cwd,
      };
      if (sub && !state.metaRead) {
        state.metaRead = true;
        state.agentType = deps.readMeta(sub.metaPath)?.agentType;
      }
      emit("session_start", {}, { sessionId: "real" });
    }
  }

  const type = o.type;
  const subtype = str(o.subtype);
  if (type === "user" || type === "assistant" || type === "system") {
    if (!state.subagent && o.isSidechain === true) {
      note(state, "sidechain", byteOffset);
    } else if (ts === undefined) {
      note(state, "noTimestamp", byteOffset);
    } else if (!state.session) {
      health.ignored++;
    } else if (type === "user") {
      mapUser(o, state, emit);
    } else if (type === "assistant") {
      mapAssistant(o, state, byteOffset, emit);
    } else if (subtype === "api_error") {
      emit("error", { status: "error" }, { status: "real" });
    } else if (subtype !== undefined && IGNORED_SUBTYPES.has(subtype)) {
      health.ignored++;
    } else {
      countUnknown(state, `system/${typeLabel(subtype ?? undefined)}`, byteOffset);
    }
  } else if (typeof type === "string" && IGNORED.has(type)) {
    health.ignored++;
  } else {
    countUnknown(state, typeLabel(type), byteOffset);
  }

  health.events += out.length;
  return { events: out, state };
}

function countUnknown(state: ClaudeFileState, name: string, offset: number): void {
  note(state, "unknown", offset);
  const names = state.health.unknownTypes;
  // Names are bounded so a hostile log cannot grow the counters.
  if (name in names || Object.keys(names).length < 50) names[name] = (names[name] ?? 0) + 1;
}

type Emit = (type: AgentEvent["type"], fields: Partial<AgentEvent>, provenance: Provenance) => void;

/** The newer of the in-progress plan item and the latest prompt. */
function currentTaskOf(state: ClaudeFileState): string | undefined {
  const plan = state.planActive;
  const prompt = state.prompt;
  if (plan && (!prompt || plan.seq > prompt.seq)) return plan.text;
  return prompt?.text;
}

function mapUser(o: Record_, state: ClaudeFileState, emit: Emit): void {
  const message = isRecord(o.message) ? o.message : {};
  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue;
      const id = str(block.tool_use_id);
      const toolName = id === undefined ? undefined : state.tools.get(id);
      if (id !== undefined) state.tools.delete(id);
      const fields: Partial<AgentEvent> = {};
      const provenance: Provenance = {};
      if (toolName !== undefined) {
        fields.toolName = toolName;
        provenance.toolName = "real";
      }
      if (block.is_error === true) {
        fields.toolError = true;
        provenance.toolError = "real";
      }
      emit("tool_result", fields, provenance);
    }
  }
  const text = promptText(o, content);
  if (text === undefined || !state.session) return;
  const task = redact(text, state.session.cwd);
  state.prompt = { text: task, seq: ++state.seq };
  emit("turn_start", { currentTask: task }, { currentTask: "derived" });
}

function mapAssistant(o: Record_, state: ClaudeFileState, byteOffset: number, emit: Emit): void {
  const session = state.session;
  if (!session) return;
  const message = isRecord(o.message) ? o.message : {};
  const messageId = str(message.id);
  const rawModel = str(message.model);
  const model =
    rawModel === undefined || rawModel === "<synthetic>"
      ? undefined
      : redact(rawModel.slice(0, NAME_LIMIT), undefined);
  const modelFields: Partial<AgentEvent> = model === undefined ? {} : { model };
  const modelProvenance: Provenance = model === undefined ? {} : { model: "real" };

  if (messageId !== undefined && isRecord(message.usage)) {
    const tokens = tokensOf(message.usage);
    const seen = state.usage.get(messageId);
    // The counted value of each field is its largest over the message's lines: the first line
    // is counted whole, a later line adds only what it raises, a smaller value is drift.
    const base = seen ?? { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    const grown: Tokens = {
      in: Math.max(base.in, tokens.in),
      out: Math.max(base.out, tokens.out),
      cacheRead: Math.max(base.cacheRead, tokens.cacheRead),
      cacheWrite: Math.max(base.cacheWrite, tokens.cacheWrite),
    };
    if (seen !== undefined && lowerAnywhere(seen, tokens)) note(state, "drift", byteOffset);
    if (seen === undefined || !sameTokens(seen, grown)) {
      const delta: Tokens = {
        in: grown.in - base.in,
        out: grown.out - base.out,
        cacheRead: grown.cacheRead - base.cacheRead,
        cacheWrite: grown.cacheWrite - base.cacheWrite,
      };
      state.usage.set(messageId, grown);
      const total = state.health.tokens;
      total.in += delta.in;
      total.out += delta.out;
      total.cacheRead += delta.cacheRead;
      total.cacheWrite += delta.cacheWrite;
      emit("usage", { ...modelFields, tokens: delta }, { ...modelProvenance, tokens: "real" });
    }
  }

  const content = Array.isArray(message.content) ? message.content : [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const rawName = str(block.name);
    if (rawName === undefined) continue;
    const toolName = redact(rawName.slice(0, NAME_LIMIT), session.cwd);
    const id = str(block.id);
    if (id !== undefined) {
      if (state.tools.size >= TOOL_MEMORY) state.tools.delete(state.tools.keys().next().value!);
      state.tools.set(id, toolName);
    }
    const files = [
      ...new Set(toolPaths(rawName, block.input).map((p) => redactPath(p, session.cwd))),
    ];
    emit(
      "tool_call",
      {
        ...modelFields,
        toolName,
        toolClass: classifyTool(rawName, block.input),
        ...(files.length > 0 ? { filesTouched: files } : {}),
      },
      {
        ...modelProvenance,
        toolName: "real",
        toolClass: "derived",
        ...(files.length > 0 ? { filesTouched: "derived" } : {}),
      },
    );
    if (Object.hasOwn(PLAN_TOOLS, rawName)) mapPlan(rawName, block.input, state, emit);
  }

  if (
    messageId !== undefined &&
    message.stop_reason === "end_turn" &&
    !state.ended.has(messageId)
  ) {
    state.ended.add(messageId);
    emit("turn_end", modelFields, modelProvenance);
  }
}

/** One `status` event per plan item that changed, carrying `todo` and no status value (C82). */
function mapPlan(tool: string, input: unknown, state: ClaudeFileState, emit: Emit): void {
  const session = state.session;
  if (!session) return;
  const applied = applyPlan(session.id, tool, input, state.plans[tool] ?? []);
  if (!applied) return;
  state.plans[tool] = applied.list;
  if (applied.changes.length === 0) return;
  const active = activeText(applied.list);
  if (active !== undefined) {
    state.planActive = { tool, text: redact(active, session.cwd), seq: ++state.seq };
  } else if (state.planActive?.tool === tool) {
    state.planActive = undefined;
  }
  const task = currentTaskOf(state);
  // The task rides on the event of the item now in progress, else on the last change.
  let carrier = applied.changes.findIndex((c) => c.status === "in_progress");
  if (carrier < 0) carrier = applied.changes.length - 1;
  applied.changes.forEach((change, i) => {
    const withTask = i === carrier && task !== undefined;
    emit(
      "status",
      {
        todo: { id: change.id, status: change.status },
        ...(withTask ? { currentTask: task } : {}),
      },
      { todo: "derived", ...(withTask ? { currentTask: "derived" } : {}) },
    );
  });
}

/**
 * Parses a whole file's text, a line at a time, the way the log server will. A last line
 * without a newline is a partial write and is left out. Meant for tools and tests; the server
 * feeds lines as they arrive.
 */
export function parseClaudeText(
  text: string,
  options: { path: string; identity: string },
  deps: ParserDeps,
): { events: AgentEvent[]; state: ClaudeFileState } {
  let state = createClaudeState(options);
  const events: AgentEvent[] = [];
  let offset = 0;
  let start = 0;
  for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
    const line = text.slice(start, end);
    const result = parseClaudeLine(line, offset, state, deps);
    state = result.state;
    for (const event of result.events) events.push(event);
    offset += Buffer.byteLength(line) + 1;
    start = end + 1;
  }
  return { events, state };
}
