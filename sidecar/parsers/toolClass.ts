import type { AgentEvent } from "../../src/data/schema.ts";

export type ToolClass = NonNullable<AgentEvent["toolClass"]>;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
// One table from a tool to the input field that names the file it writes (DX18).
const PATH_FIELDS: Record<string, string> = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};
const PATCH_HEADER = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+)$/;

/** Files a tool call writes, as the log names them; patch bodies are read for headers only. */
export function toolPaths(name: string, input: unknown): string[] {
  if (name === "apply_patch") {
    const patch =
      typeof input === "string"
        ? input
        : typeof (input as { input?: unknown } | null)?.input === "string"
          ? (input as { input: string }).input
          : undefined;
    if (patch === undefined) return [];
    const paths: string[] = [];
    for (const line of patch.split("\n")) {
      const header = PATCH_HEADER.exec(line.trimEnd());
      if (header) paths.push(header[1]);
    }
    return paths;
  }
  const field = PATH_FIELDS[name];
  if (field === undefined || typeof input !== "object" || input === null) return [];
  const path = (input as Record<string, unknown>)[field];
  return typeof path === "string" && path !== "" ? [path] : [];
}

export function classifyTool(name: string, input: unknown): ToolClass {
  if (EDIT_TOOLS.has(name)) return "edit";
  if (name === "Bash") {
    const command = (input as { command?: unknown } | null)?.command;
    return typeof command === "string" ? classifyCommand(command) : "other";
  }
  return "other";
}

interface Word {
  text: string;
  quoted: boolean;
}

/** Splits at unquoted `&&`, `||`, `;` and `|`; words keep a flag for any quoting in them. */
function segments(command: string): Word[][] {
  const out: Word[][] = [];
  let words: Word[] = [];
  let text = "";
  let quoted = false;
  let open = false;
  let quote = "";
  const endWord = () => {
    if (open) words.push({ text, quoted });
    text = "";
    quoted = false;
    open = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) out.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) text += command[++i];
      else text += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      quoted = true;
      open = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      text += command[++i];
      open = true;
    } else if (ch === ";" || ch === "\n" || ch === "|" || (ch === "&" && command[i + 1] === "&")) {
      if (ch !== ";" && ch !== "\n" && command[i + 1] === ch) i++;
      endSegment();
    } else if (/\s/.test(ch)) endWord();
    else {
      text += ch;
      open = true;
    }
  }
  endSegment();
  return out;
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const WRAPPERS_ONE = new Set(["npx", "bunx"]);

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** The command words of one segment with env assignments and runner wrappers removed. */
function stripWrappers(words: Word[]): Word[] {
  let rest = words;
  for (let guard = 0; guard < 8; guard++) {
    while (rest.length > 0 && ENV_ASSIGN.test(rest[0].text)) rest = rest.slice(1);
    if (rest.length === 0) return rest;
    const [head, second] = rest;
    if (head.quoted) return rest;
    const name = basename(head.text);
    // `npm run test` is a test run itself, not the wrapper `npm run` around a command `test`.
    if (PACKAGE_MANAGERS.has(name) && isTestScript(packageScript(rest))) return rest;
    let drop = 0;
    if (WRAPPERS_ONE.has(name)) {
      drop = 1;
      while (rest[drop] && !rest[drop].quoted && rest[drop].text.startsWith("-")) drop++;
    } else if (name === "pnpm" && second && !second.quoted && second.text === "exec") drop = 2;
    else if (
      (name === "uv" || name === "poetry" || name === "npm") &&
      second?.text === "run" &&
      !second.quoted
    ) {
      drop = 2;
    } else if (
      (name === "pnpm" || name === "yarn") &&
      second &&
      !second.quoted &&
      !isScript(second.text)
    ) {
      drop = 1;
    }
    if (drop === 0) return rest;
    rest = rest.slice(drop);
  }
  return rest;
}

const isScript = (word: string) => word === "test" || word.startsWith("test:") || word === "run";
const isTestScript = (script: string | undefined) =>
  script !== undefined && (script === "test" || script.startsWith("test:"));

/** The script a package manager command names: `npm run test` and `npm test` both give `test`. */
function packageScript(words: Word[]): string | undefined {
  const at = (i: number) => (words[i] && !words[i].quoted ? words[i].text : undefined);
  return at(1) === "run" ? at(2) : at(1);
}

const TEST_RUNNERS = new Set(["vitest", "jest", "pytest"]);
const CHECKERS = new Set(["eslint", "tsc", "ruff", "biome"]);
// `<tool> test` pairs: the second word makes it a test run.
const TEST_PAIRS = new Set(["vp", "go", "cargo", "playwright", "deno", "make", "just", "bun"]);

function classifySegment(words: Word[]): ToolClass {
  // A subshell `(cd app && vitest)`: the opening bracket belongs to the first command word.
  const head = words[0];
  const unwrapped =
    head && !head.quoted && head.text.startsWith("(") && head.text.length > 1
      ? [{ ...head, text: head.text.replace(/^\(+/, "").replace(/\)+$/, "") }, ...words.slice(1)]
      : words;
  const rest = stripWrappers(unwrapped);
  if (rest.length === 0 || rest[0].quoted) return "other";
  const name = basename(rest[0].text);
  const args = rest.slice(1);
  const arg = (i: number) => (args[i] && !args[i].quoted ? args[i].text : undefined);

  if (name === "git") {
    let i = 0;
    // Global options that take a value, then bare flags, before the subcommand.
    while (i < args.length && !args[i].quoted && args[i].text.startsWith("-")) {
      i += args[i].text === "-C" || args[i].text === "-c" ? 2 : 1;
    }
    return arg(i) === "commit" ? "git_commit" : "other";
  }
  if (PACKAGE_MANAGERS.has(name)) {
    return isTestScript(packageScript(rest)) ? "test" : "other";
  }
  if (TEST_RUNNERS.has(name)) return "test";
  if (TEST_PAIRS.has(name) && arg(0) === "test") return "test";
  if (name === "vp" && arg(0) === "check") return "lint";
  if (CHECKERS.has(name)) return "lint";
  if (name === "prettier" && args.some((a) => !a.quoted && a.text === "--check")) return "lint";
  return "other";
}

const RANK: Record<ToolClass, number> = { git_commit: 3, test: 2, lint: 1, other: 0, edit: 0 };

/**
 * Class of a shell command (DX18): split on `&&`, `||`, `;`, `|`, then per segment drop env
 * assignments and runner wrappers and match the command word; quoted words never match. The
 * strongest class of any segment wins (git_commit, test, lint). The text itself is never kept.
 * Not looked into (v1 limits): `bash -c '...'`, `$(...)` and heredoc bodies.
 */
export function classifyCommand(command: string): ToolClass {
  let best: ToolClass = "other";
  for (const words of segments(command)) {
    const found = classifySegment(words);
    if (RANK[found] > RANK[best]) best = found;
  }
  return best;
}
