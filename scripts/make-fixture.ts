import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { INJECTED_TAGS } from "../sidecar/parsers/claude.ts";
import { classifyCommand } from "../sidecar/parsers/toolClass.ts";

// `vp run logs:fixture -- --vendor claude --file <path> --out <fixture> [--lines <n>]` cuts one
// real session into a committable fixture (PLAN chunk 15a, X4, C93, DX11, DX15). The output is
// built from an allow-list: ids, timestamps, types, versions, usage numbers and the shape of
// tool inputs survive; every text, path, URL, branch and command is replaced by a placeholder
// that keeps what the parser reads (a prompt stays a prompt, a test command stays a test
// command, a path stays inside or outside the project). What it replaced is printed as counts.
// The privacy scan then runs over the result and the script fails if it finds anything.

export interface Names {
  home: string;
  user: string;
  host: string;
}

export interface Finding {
  file: string;
  line: number;
  token: string;
}

const FIXED_NEEDLES = ["/Users/", "\\Users\\", "github.com", "http://", "https://"];

/**
 * The privacy test (C93, DX15): the home directory, the username, the host name, `/Users/`,
 * `github.com` and URL schemes must not appear anywhere in a committed fixture. Each hit names
 * the file, the 1-based line and the token that matched.
 */
export function privacyFindings(files: { name: string; text: string }[], names: Names): Finding[] {
  const host = names.host.toLowerCase();
  const needles = [
    names.home,
    names.user,
    names.host,
    host.split(".")[0] ?? "",
    ...FIXED_NEEDLES,
  ].filter((n, i, all) => n.length >= 3 && all.indexOf(n) === i);
  const found: Finding[] = [];
  for (const file of files) {
    const lines = file.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i].toLowerCase();
      for (const needle of needles) {
        if (lower.includes(needle.toLowerCase())) {
          found.push({ file: file.name, line: i + 1, token: needle });
        }
      }
    }
  }
  return found;
}

export const formatFinding = (f: Finding): string => `${f.file}:${f.line}: ${f.token}`;

export const localNames = (): Names => ({
  home: homedir(),
  user: userInfo().username,
  host: hostname(),
});

export function scanDirectory(dir: string, names: Names = localNames()): Finding[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl") || name.endsWith(".json"))
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
  return privacyFindings(files, names);
}

type Rec = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

export interface Replaced {
  lines: number;
  skipped: number;
  prompts: number;
  assistantText: number;
  thinking: number;
  toolOutput: number;
  commands: number;
  paths: number;
  planText: number;
  cwd: number;
  branch: number;
  urls: number;
  toolNames: number;
  fieldsDropped: number;
}

const KNOWN_TOOLS = new Set([
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  "Task",
  "Agent",
  "WebFetch",
  "WebSearch",
  "mcp__ccd_turn__update_plan",
  "apply_patch",
]);
const COMMANDS = {
  git_commit: "git commit -m message",
  test: "vitest run",
  lint: "tsc --noEmit",
  other: "ls",
  edit: "ls",
} as const;
const STOP_REASONS = new Set(["end_turn", "tool_use", "stop_sequence", "max_tokens"]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** Cuts text into placeholders; one instance per fixture so equal texts get equal placeholders. */
export class Sanitizer {
  readonly replaced: Replaced = {
    lines: 0,
    skipped: 0,
    prompts: 0,
    assistantText: 0,
    thinking: 0,
    toolOutput: 0,
    commands: 0,
    paths: 0,
    planText: 0,
    cwd: 0,
    branch: 0,
    urls: 0,
    toolNames: 0,
    fieldsDropped: 0,
  };
  #cwd: string | undefined;
  readonly #plan = new Map<string, string>();
  readonly #paths = new Map<string, string>();
  readonly #tools = new Map<string, string>();
  #text = 0;

  #url(value: string): void {
    this.replaced.urls += value.match(/https?:\/\//g)?.length ?? 0;
  }

  #prompt(value: string): string {
    this.#url(value);
    const lead = value.trimStart();
    const tag = INJECTED_TAGS.find((t) => lead.startsWith(t));
    return tag ? `${tag}>injected text ${++this.#text}` : `prompt text ${++this.#text}`;
  }

  #planText(value: string): string {
    this.#url(value);
    let mapped = this.#plan.get(value);
    if (mapped === undefined) {
      mapped = `task ${this.#plan.size + 1}`;
      this.#plan.set(value, mapped);
      this.replaced.planText++;
    }
    return mapped;
  }

  #path(value: string): string {
    let mapped = this.#paths.get(value);
    if (mapped === undefined) {
      const inside =
        this.#cwd !== undefined && (value === this.#cwd || value.startsWith(`${this.#cwd}/`));
      const ext = /\.[A-Za-z0-9]{1,5}$/.exec(value)?.[0] ?? "";
      mapped = `${inside ? "/repo/src" : "/home/user"}/file-${this.#paths.size + 1}${ext}`;
      this.#paths.set(value, mapped);
      this.replaced.paths++;
    }
    return mapped;
  }

  #cwdOf(value: string): string {
    this.#cwd ??= value;
    this.replaced.cwd++;
    if (value === this.#cwd) return "/repo";
    return value.startsWith(`${this.#cwd}/`) ? "/repo/sub" : "/home/user/other";
  }

  #toolName(name: string): string {
    if (KNOWN_TOOLS.has(name)) return name;
    let mapped = this.#tools.get(name);
    if (mapped === undefined) {
      mapped = `mcp__server__tool${this.#tools.size + 1}`;
      this.#tools.set(name, mapped);
      this.replaced.toolNames++;
    }
    return mapped;
  }

  #input(name: string, input: unknown): Rec {
    if (!isRec(input) && typeof input !== "string") return {};
    const rec = isRec(input) ? input : {};
    if (name === "Bash") {
      const command = typeof rec.command === "string" ? rec.command : "";
      this.#url(command);
      this.replaced.commands++;
      return { command: COMMANDS[classifyCommand(command)] };
    }
    if (name === "Edit" || name === "Write" || name === "MultiEdit") {
      return typeof rec.file_path === "string" ? { file_path: this.#path(rec.file_path) } : {};
    }
    if (name === "NotebookEdit") {
      return typeof rec.notebook_path === "string"
        ? { notebook_path: this.#path(rec.notebook_path) }
        : {};
    }
    if (name === "TodoWrite" && Array.isArray(rec.todos)) {
      return {
        todos: rec.todos.filter(isRec).map((t) => ({
          content: this.#planText(text(t.content)),
          status: PLAN_STATUSES.has(String(t.status)) ? t.status : "pending",
          activeForm: this.#planText(text(t.activeForm ?? t.content)),
        })),
      };
    }
    if (name === "mcp__ccd_turn__update_plan") {
      const out: Rec = {};
      if (Array.isArray(rec.items)) {
        out.items = rec.items.filter(isRec).map((t) => ({
          content: this.#planText(text(t.content)),
          status: PLAN_STATUSES.has(String(t.status)) ? t.status : "pending",
        }));
      }
      if (rec.scope === "first_task" || rec.scope === "continuation") out.scope = rec.scope;
      if (typeof rec.advance === "boolean") out.advance = rec.advance;
      if (Array.isArray(rec.done)) out.done = rec.done.filter((n) => typeof n === "number");
      if (typeof rec.start === "number") out.start = rec.start;
      return out;
    }
    return {};
  }

  #content(o: Rec, role: "user" | "assistant"): unknown {
    const message = isRec(o.message) ? o.message : {};
    const content = message.content;
    if (typeof content === "string") {
      this.replaced.prompts++;
      return this.#prompt(content);
    }
    if (!Array.isArray(content)) return [];
    const out: Rec[] = [];
    for (const block of content) {
      if (!isRec(block)) continue;
      if (block.type === "text") {
        const t = typeof block.text === "string" ? block.text : "";
        if (role === "user") {
          this.replaced.prompts++;
          out.push({ type: "text", text: this.#prompt(t) });
        } else {
          this.replaced.assistantText++;
          this.#url(t);
          out.push({ type: "text", text: `assistant text ${++this.#text}` });
        }
      } else if (block.type === "thinking") {
        this.replaced.thinking++;
        out.push({ type: "thinking", thinking: `thinking text ${++this.#text}` });
      } else if (block.type === "image") {
        out.push({ type: "image", source: {} });
      } else if (block.type === "tool_use") {
        const name = typeof block.name === "string" ? block.name : "unknown";
        const entry: Rec = {
          type: "tool_use",
          name: this.#toolName(name),
          input: this.#input(name, block.input),
        };
        if (typeof block.id === "string") entry.id = block.id;
        out.push(entry);
      } else if (block.type === "tool_result") {
        this.replaced.toolOutput++;
        const result: Rec = {
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: `tool output ${++this.#text}`,
        };
        if (typeof block.is_error === "boolean") result.is_error = block.is_error;
        out.push(result);
      }
    }
    return out;
  }

  /** One input line to one output line, or undefined for a line that is not JSON. */
  line(raw: string): Rec | undefined {
    this.replaced.lines++;
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      this.replaced.skipped++;
      return undefined;
    }
    if (!isRec(o)) {
      this.replaced.skipped++;
      return undefined;
    }
    const out: Rec = {};
    for (const key of [
      "type",
      "subtype",
      "uuid",
      "parentUuid",
      "sessionId",
      "agentId",
      "timestamp",
    ]) {
      if (typeof o[key] === "string") out[key] = o[key];
    }
    if (typeof o.version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(o.version)) {
      out.version = o.version;
    }
    for (const key of ["isSidechain", "isMeta", "isCompactSummary"]) {
      if (typeof o[key] === "boolean") out[key] = o[key];
    }
    if (typeof o.cwd === "string") out.cwd = this.#cwdOf(o.cwd);
    if (typeof o.gitBranch === "string") {
      this.replaced.branch++;
      out.gitBranch = "main";
    }
    if (o.type === "system") {
      if (typeof o.level === "string" && /^[a-z]{1,12}$/.test(o.level)) out.level = o.level;
      if (o.subtype === "api_error" && isRec(o.error) && typeof o.error.status === "number") {
        out.error = { status: o.error.status };
      }
    } else if (o.type === "user" || o.type === "assistant") {
      const message = isRec(o.message) ? o.message : {};
      const m: Rec = { role: o.type };
      if (o.type === "assistant") {
        if (typeof message.id === "string") m.id = message.id;
        const model = typeof message.model === "string" ? message.model : "";
        m.model =
          model === "<synthetic>" || /^claude-[a-z0-9.-]{1,40}$/.test(model)
            ? model
            : "claude-model";
        m.stop_reason = STOP_REASONS.has(String(message.stop_reason)) ? message.stop_reason : null;
        if (isRec(message.usage)) {
          const u: Rec = {};
          for (const key of [
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
          ]) {
            if (typeof message.usage[key] === "number") u[key] = message.usage[key];
          }
          m.usage = u;
        }
      }
      m.content = this.#content(o, o.type);
      out.message = m;
    }
    const kept = Object.keys(out).length;
    this.replaced.fieldsDropped += Math.max(0, Object.keys(o).length - kept);
    return out;
  }
}

function fail(message: string): never {
  console.error(`logs-fixture: ${message}`);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
  const given = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!["--vendor", "--file", "--out", "--lines"].includes(flag)) fail(`unknown flag ${flag}`);
    if (argv[i + 1] === undefined) fail(`${flag} needs a value`);
    given.set(flag, argv[i + 1]);
  }
  const vendor = given.get("--vendor") ?? fail("--vendor is required (claude)");
  if (vendor === "codex") fail("codex fixtures arrive with the Codex parser (chunk 16)");
  if (vendor !== "claude") fail(`unknown vendor "${vendor}" (use claude)`);
  const file = given.get("--file") ?? fail("--file is required");
  const out = given.get("--out") ?? fail("--out is required");
  const limit = given.has("--lines") ? Number(given.get("--lines")) : Infinity;
  if (!(limit >= 1)) fail("--lines must be a whole number above 0");

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    fail(`--file: cannot read it: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  const sanitizer = new Sanitizer();
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    if (lines.length >= limit) break;
    if (raw.trim() === "") continue;
    const cleaned = sanitizer.line(raw);
    if (cleaned !== undefined) lines.push(JSON.stringify(cleaned));
  }
  try {
    writeFileSync(out, lines.join("\n") + "\n");
  } catch (error) {
    fail(`--out: cannot write it: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
  }
  console.log(`logs-fixture: ${lines.length} lines written to ${out}; replaced:`);
  for (const [name, count] of Object.entries(sanitizer.replaced))
    console.log(`  ${name}: ${count}`);
  const findings = privacyFindings([{ name: out, text: lines.join("\n") }], localNames());
  for (const f of findings) console.error(`privacy: ${formatFinding(f)}`);
  if (findings.length > 0) fail(`${findings.length} privacy findings; do not commit ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
