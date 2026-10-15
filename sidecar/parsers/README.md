# Parsers

A parser turns the lines of one vendor's log file into `AgentEvent`s (`src/data/schema.ts`). Parsers run only in Node, never in the browser, and they do no I/O: they are synchronous functions of a line and some state, so a contributor can test one with a fixture on any OS.

This page is the parser contract (DX16). The format each parser reads is in [`docs/log-formats/`](../../docs/log-formats/claude.md). Chunk 15a ships the Claude Code parser alone; nothing calls it from the log server yet (chunk 15b adds the registry and the `events` wire message), and the Codex parser is chunk 16.

## Files

| File           | What it is                                                                             |
| -------------- | -------------------------------------------------------------------------------------- |
| `claude.ts`    | `parseClaudeLine`, `createClaudeState`, `parseClaudeText`; the ignored-type lists      |
| `planTools.ts` | the one table of plan tools (`TodoWrite`, the desktop `update_plan`) and the item diff |
| `toolClass.ts` | `toolClass` of a tool call and the files it touches                                    |
| `redact.ts`    | secrets, paths and the 120 character cut                                               |
| `ids.ts`       | event ids and file identity                                                            |
| `types.ts`     | `ParserDeps`, `ParserHealth`, `TESTED_VERSIONS`, `MAX_LINE_BYTES`                      |
| `fixtures/`    | golden fixtures cut from real sessions (see `vp run logs:fixture`)                     |

## The signature

```ts
parseClaudeLine(
  line: string,        // one complete line, without its newline
  byteOffset: number,  // where the line starts in the file
  state: ClaudeFileState,
  deps: ParserDeps,
): { events: AgentEvent[]; state: ClaudeFileState }
```

- **No I/O, no clock.** The result depends only on the arguments. Anything from outside comes in through `deps`.
- **State belongs to the caller.** `createClaudeState({ path, identity })` makes one per file. It is updated in place and returned, so you can chain calls, and you make a new one when the file is truncated or replaced (14a's tail tells you). It holds the session, the usage seen per `message.id`, the plan items, the health counters and a few other small things. Memory per file is bounded by the file's own size; the server drops the state of a file 2 h after its last append and rebuilds it by reading from 0 (E17).
- **`line` must be a complete line.** The tail (14a) only hands over lines that end in a newline; a partial last line is read again when it is finished.
- **One line, any number of events.** Zero is normal (most lines are ignored types); several is normal too (an assistant line with a `usage` and three `tool_use` blocks).

### `deps`

```ts
interface ParserDeps {
  resolveProjectKey(sessionId: string, cwd: string): string; // main session: the key of its first cwd
  rootProjectKey(rootSessionId: string, cwd: string): string; // subagent: its root session's current key
  readMeta(metaPath: string): { agentType?: string } | undefined; // a subagent's .meta.json, once per file
}
```

The parser asks for the project key at most once per line, so a key that changes between lines (the one-time upgrade of C95, owned by `sessionKeys.ts` in chunk 15b) shows up on the next line's events. Tests pass stubs; the log server will pass the real resolvers.

### Ids

`id` = the first 32 hex characters of sha256 over (vendor, file identity, the line's byte offset, sha256 of the line, index of the event within the line). The file identity is `fileId` from `sidecar/tail.ts` (`dev:ino`); where the inode is `0n` (Windows) `fileIdentity()` in `ids.ts` uses the birth time plus the hash of the file's first complete line, because the tail's own fallback includes the size and that changes on every append. So the same bytes at the same offset give the same ids after a restart or a rename, rewritten bytes give new ones, and two events from one line differ in the last part. Nothing counts a restart or a truncation in an id.

### Health

`state.health` counts what the parser skipped, so silence is visible: `malformed`, `unknown`, `oversize`, `ignored`, `drift`, `sidechain`, `noTimestamp`, the first byte offset of each (`firstOffsets`), unknown type names (`unknownTypes`, bounded to 50 names), versions seen, the token total and the event count. `vp run logs:probe -- --file <path>` prints them for any file.

## A test with a stub resolver

```ts
import { createClaudeState, parseClaudeLine } from "./claude.ts";
import type { ParserDeps } from "./types.ts";

const deps: ParserDeps = {
  resolveProjectKey: (_sessionId, cwd) => `key:${cwd}`,
  rootProjectKey: (rootSessionId) => `key:root:${rootSessionId}`,
  readMeta: () => ({ agentType: "builder" }),
};

let state = createClaudeState({ path: "/logs/s1.jsonl", identity: "1:42" });
const line = JSON.stringify({
  type: "user",
  sessionId: "s1",
  cwd: "/repo",
  timestamp: "2026-10-14T08:00:00.000Z",
  message: { role: "user", content: "add a login page" },
});
const result = parseClaudeLine(line, 0, state, deps);
state = result.state;
// result.events: a session_start and a turn_start whose currentTask is "add a login page",
// both with projectKey "key:/repo".
```

`claude.test.ts` has the same shape at length: a plain session, two subagents (one nested), a failed tool call, `api_error`, every ignored type, malformed and oversize lines, usage over several lines, each plan tool, `currentTask`, `toolClass`, redaction, ids. `golden.test.ts` parses the fixtures and checks their token totals against a counter that shares no code with the parser.

## Rules every parser follows

- **No command text, patch body, file content or tool output leaves the parser.** Events carry `toolClass`, tool names, relative file paths and the redacted, cut task text. A test checks that planted command and patch text appears in no event.
- **Free text goes through `redact`** before it is put in an event (R2, D16).
- **Unknown stays visible.** A line type the parser does not know is counted `unknown`, not guessed at; the ignored lists are explicit.
- **Tolerate unknown fields.** Take what you need by key and ignore the rest; vendors add fields without notice.
- **Import the schema, do not copy it.** `todo`, `toolClass` and `toolError` come from `src/data/schema.ts`.

## Adding a parser

Write `<vendor>.ts` with the same shape (`create<Vendor>State`, `parse<Vendor>Line`), reuse `redact`, `toolClass`, `planTools` and `ids`, add its `TESTED_VERSIONS` entry, write `docs/log-formats/<vendor>.md` from `vp run logs:probe` output first, cut a golden fixture with `vp run logs:fixture`, and add a reference counter for its token total to the golden test.
