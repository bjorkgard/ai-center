# Claude Code log format

What the Claude Code parser (`sidecar/parsers/claude.ts`) reads, how each line becomes an `AgentEvent`, and what it ignores. Everything here comes from one machine (n=1, macOS, one user) and was checked with `vp run logs:probe` first; the rules are not vendor documentation. Claude Code does not promise this format, so [When a vendor updates](#when-a-vendor-updates) says what to do when it moves.

- **Tested versions:** Claude Code 2.1.260 to 2.1.295 (`TESTED_VERSIONS.claude` in `sidecar/parsers/types.ts`). Versions seen on the machine across all history: 2.1.128 to 2.1.295 (31 distinct). The last 24 h held only 2.1.295.
- **Evidence base:** 3,218 `.jsonl` files and 454,186 lines under `~/.claude/projects` (14 lines were not JSON), probed on 2026-10-15. The last 24 h: 167 files, 45,962 lines.
- **Status of the rules:** the parser is pure and tested on synthetic lines and on two golden fixtures cut from real sessions (`sidecar/parsers/fixtures/`). Nothing in the app reads it yet (chunk 15b).

## Where the files are

```text
~/.claude/projects/<project>/<session-id>.jsonl                          a main session
~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.jsonl     a subagent of that session
~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.meta.json agentType, description, spawnDepth, toolUseId, ...
~/.claude/projects/<project>/<session-id>/subagents/agent-<id>.prefix.json   not read
~/.claude/projects/<project>/archive/<session-id>/subagents/...          the same, archived
```

The root is the one the log server resolves (`--log-root`, `SYNAPSE_LOG_ROOTS`, the config file, `$CLAUDE_CONFIG_DIR/projects`; README #configuration). Only `*.jsonl` is tailed. A main file holds one `sessionId` for all its lines and the file name is that id (checked on 106 recent files). 3,012 of the 3,218 files are subagent files; their lines all have `isSidechain: true` and an `agentId`, and their `sessionId` is the root session's id (checked on 60 of 60). Nested subagents are flat siblings in the same folder with `spawnDepth` above 1 in their meta, and they too name the root session.

## Line types

Measured with `vp run logs:probe -- --all` (every file, counts are lines):

| Type | Lines | Parser |
| --- | ---: | --- |
| `assistant` | 130,734 | mapped |
| `user` | 85,538 | mapped |
| `system` / `api_error` | 2 | mapped to an `error` event with `status: "error"` |
| `system` / `stop_hook_summary` | 2,213 | ignored |
| `system` / `turn_duration` | 342 | ignored |
| `system` / `away_summary`, `local_command`, `compact_boundary`, `informational`, `scheduled_task_fire` | 22, 20, 17, 14, 4 | ignored |
| `attachment` | 172,254 | ignored |
| `last-prompt`, `custom-title`, `agent-name`, `atis-latch`, `bridge-session`, `queue-operation`, `mode`, `permission-mode`, `pr-link`, `ai-title`, `cost-state`, `file-history-snapshot`, `file-history-delta`, `fork-context-ref` | 10,765 / 8,329 / 7,779 / 10,477 / 9,043 / 9,992 / 2,310 / 717 / 1,042 / 826 / 190 / 902 / 634 / 6 | ignored |
| anything else | - | counted `unknown` (`W-UNKNOWN-TYPE`) |

**Mapped:** `user`, `assistant`, and `system` with `subtype: "api_error"`.

**Known-ignored types** (`IGNORED_TYPES`, C90): `attachment`, `custom-title`, `ai-title`, `last-prompt`, `agent-name`, `queue-operation`, `atis-latch`, `bridge-session`, `mode`, `permission-mode`, `pr-link`, `cost-state`, `file-history-snapshot`, `file-history-delta`, `fork-context-ref` (added after the plan's list, on a user decision, when 6 such lines turned up).

**Known-ignored `system` subtypes** (`IGNORED_SYSTEM_SUBTYPES`): `stop_hook_summary`, `turn_duration`, `away_summary`, `local_command`, `compact_boundary`, `informational`, `scheduled_task_fire`.

Also ignored, as a known gap: in a **main** file, a `user`/`assistant`/`system` line with `isSidechain: true` (an in-file sidechain). It is counted `sidechain` and makes no event. In a subagent file `isSidechain` is true on every line and means nothing.

A line that is not JSON (or is JSON but not an object) is counted `malformed` (`W-MALFORMED`). A line over 32 MiB is skipped and counted `oversize` (`W-OVERSIZE`); the longest line measured is 1.36 MB. A blank line is skipped without a count. The health counters (`lines`, `malformed`, `unknown`, `oversize`, `ignored`, `drift`, `sidechain`, `noTimestamp`, the first byte offset of each class, unknown type names) are on the file state: `vp run logs:probe -- --file <path>` prints them with the token totals.

## From lines to events

One line can make several events. Each event's `id` includes the index of the event within its line, so they are distinct.

| Event | When | Fields |
| --- | --- | --- |
| `session_start` | once per file, on the first line with `sessionId`, `timestamp` and `cwd`, whatever its type | no status |
| `turn_start` | a real user prompt (below) | `currentTask` = the redacted prompt |
| `usage` | the first line of each `message.id` that has `message.usage`, and any later line of it that raises a field | `tokens` is the increase over what was counted for that message (the whole usage for the first line):  `tokens` {`in` = `input_tokens`, `out` = `output_tokens`, `cacheRead` = `cache_read_input_tokens`, `cacheWrite` = `cache_creation_input_tokens`}, `model` |
| `tool_call` | every `tool_use` block | `toolName`, `toolClass`, `filesTouched` for edit tools, `model` |
| `tool_result` | every `tool_result` block in a user line | `toolName` of the call it answers; `toolError: true` when `is_error` is true; never a `status` |
| `status` | a plan tool call changed a plan item | `todo` {`id`, `status`}, no `status` value; `currentTask` on one of them |
| `turn_end` | the first line of a `message.id` whose `stop_reason` is `end_turn` | |
| `error` | `system` / `api_error` | `status: "error"` |

Only the `api_error` event carries a session `status`. A failed tool call does not: 206 of 13,109 tool results had `is_error: true` in the 100 sessions the plan measured (185 of 7,392 in the last 24 h here), and a session that turned `error` for each would flash red on routine failed searches.

`raw` is `{ file, offset }` with the file's base name only (never the directory) and the byte offset of the line.

### Usage once per message (C80)

Claude Code writes one line per content block and repeats `message.usage` on each. Counting every line over-counts about 1.8 times (measured). The counted value of each token field is its **largest** value over the lines of a `message.id` (decided after measuring, below). The first line gives a `usage` event with its whole usage. A later line that raises a field gives one more `usage` event carrying only the increase (its id comes from that line, so it is stable). A later line with a smaller value in any field is counted `drift` (`W-USAGE-DRIFT`) and adds nothing.

**Why max, measured on this machine, last 24 h:** in 151 of 6,822 messages (2.2%) a later line carried a larger `output_tokens` (the other three fields never differed); on those messages the first line holds 2,113 output tokens and the last line 218,415. The first-line rule of the plan would have left out about 216,000 of 2.84 million output tokens (about 8%).

Total, 167 files of the last 24 h (163 MB of text, parsed in 1.5 s, files still growing): input 13,740, output 2,840,547, cache read 1,620,510,575, cache write 27,318,599, equal to an independent per-field-max counter in all four fields, with 0 drift lines, 0 malformed, 0 unknown, 0 oversize.

### Prompts, turns and `currentTask` (C82, X5, E10, E12)

A **real prompt** is a `user` line whose `message.content` is a string, or an array with `text` blocks and no `tool_result` block, whose text is not empty, and that is not `isMeta`, not `isCompactSummary` and does not start with one of these tags: `<task-notification`, `<command-message`, `<command-name`, `<ci-monitor-event`, `<bash-input`, `<system-reminder`, `<local-command-stdout`, `<bash-stdout` (`INJECTED_TAGS`).

`currentTask` is the **newer** of the item in progress in a plan and the latest real prompt. "Newer" is the order of the lines, not the clock. A plan with no item in progress hands it back to the prompt. Task text goes through the redaction below before the 120 character cut.

### Plan tools (C82, X5, E12)

One table (`PLAN_TOOLS` in `planTools.ts`) maps two tools to plan items:

- `TodoWrite`: `input.todos[]` of `{content, status, activeForm}`; each call is the full list. Statuses: `pending`, `in_progress`, `completed`.
- `mcp__ccd_turn__update_plan` (the desktop app's tool; **best effort**, its shapes come from one machine): `input.items[]` of `{content, status}` plus `scope` (`first_task` or `continuation`) replaces the list; `{advance: true}` completes the item in progress and starts the next pending one; `{done: [n, ...], start: n}` completes and starts items by **1-based** position (measured: `done: [1, 2], start: 3`; the smallest `done` value seen is 1).

Each item has an id: a hash of the session, the tool, the item's text (trimmed, whitespace collapsed, lower-cased) and which duplicate of that text it is. So inserting an item at the top keeps every other id. Each changed item is one `status` event with `todo: {id, status}` and **no** `status` value. An item missing from a new full list while still open gets `todo.status: "cancelled"` (so a reworded item is one `cancelled` plus one new item, never a completion); an already `completed` item that drops out of the list is left alone. A resend of an identical list makes no event. TodoWrite appeared in 20 of 204 sessions and the desktop tool in 64 calls (measured by the plan); the desktop tool is why X5 exists.

### Tool calls, files and `toolClass` (DX18)

`toolClass` is set on every `tool_call` so raw commands never leave Node.

- `Edit`, `Write`, `MultiEdit`, `NotebookEdit` (and Codex `apply_patch`) are `edit`.
- For `Bash`, the command is split on `&&`, `||`, `;` and `|`. In each piece, leading `VAR=value` assignments are dropped, then the wrappers `npx`, `bunx`, `pnpm exec`, `pnpm`, `yarn`, `npm run`, `uv run`, `poetry run`; then the command word (a path is reduced to its last segment) decides: `git commit` (after `-C <dir>` / `-c k=v` / flags) is `git_commit`; `vp test`, `vitest`, `jest`, `pytest`, `go test`, `cargo test`, `playwright test`, `deno test`, and `npm`/`pnpm`/`yarn`/`bun` `test` or `run test` (or `test:*`), `make test`, `just test` are `test`; `vp check`, `eslint`, `tsc`, `ruff`, `biome`, `prettier --check` are `lint`; anything else is `other`. If several pieces match, `git_commit` beats `test` beats `lint`.
- **Quoted words never match**: `echo "git commit"`, `'git' commit` and `"vitest" run` are `other`.
- Everything else (`Read`, `Grep`, MCP tools, ...) is `other`.

**toolClass v1 limits (E15):** it does not look inside `bash -c '...'`, `$(...)` or heredoc bodies, does not split on newlines, and is not user-extendable (X10: the trigger is a first missed-runner report). A runner it does not list is `other`.

`filesTouched` comes from one tool-to-path table: `file_path` (`Edit`, `Write`, `MultiEdit`), `notebook_path` (`NotebookEdit`) and the `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` headers of an `apply_patch` body. Only the headers are read; the body is not kept. Paths use the path rule below.

### Subagents (C83)

A file `<session>/subagents/agent-<id>.jsonl` gives `sessionId` = `<id>` (the `agentId`), `parentSessionId` = the line's `sessionId` (the root session, also for nested subagents), `agentKind: "sub"`, `parentKnown: true`. The project key is the root session's current key (`deps.rootProjectKey`), never its own. `agent-<id>.meta.json` is read once per file through `deps.readMeta`; its `agentType` (`general-purpose`, `builder`, `refuter`, `researcher`, `Plan`, ... on this machine) is kept on the file state. `AgentEvent` has no field for it yet.

### Redaction (R2, D16, C101, E10, E11)

Free text that reaches an event (`currentTask`, tool names, model names) goes through `redact`; `filesTouched` goes through `redactPath`. It looks at the first 4 KiB only and every pattern is linear (a 1 MiB adversarial string takes under 50 ms), then cuts to 120 characters.

- Words are split at whitespace, quotes, brackets, `,`, `;` and `=` (so `KEY=value` judges the value).
- Becomes `[redacted]`: a known key prefix (`sk-`/`pk-`/`rk-` keys, GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` and `github_pat_`, Slack `xox*-`, AWS `AKIA`/`ASIA`, Google `AIza`, GitLab `glpat-`, npm `npm_`, JWTs), the word after `Bearer`, a **hex string of 32 or more characters except exactly 40 or 64** (git SHA-1 and SHA-256 lengths), and any word of 32 or more characters that mixes letters and digits with Shannon entropy of at least 4.0 bits per character.
- **Residual risk (E11):** a 40-hex legacy token is not redacted, because 40 hex characters is also a git SHA. So is any 64-hex secret.
- An absolute path outside the session's working root becomes `[outside project]`; inside it, it is made relative to it. The working root is the first `cwd` the file reports (a monorepo subdirectory as `cwd` makes sibling packages "outside": known gap, X11). `~/...` and `C:\...` count as outside. A lone `/commit` is a command, not a path.

### Ids (E4)

`id` is the first 32 hex characters of sha256 over (vendor, file identity, line byte offset, sha256 of the line, index of the event in the line). It is the same after a restart or a rename, and new if the content at that offset is rewritten. The file identity is the 14a `fileId` (`dev:ino`). Where `ino` is `0n` (Windows) it is the file's `birthtimeMs` plus the hash of its first complete line; the 14a cursor fallback also adds the size, which changes on every append, so it cannot be used for ids. A file with no complete line yet has no identity and makes no events.

### Timestamps (E19)

A line without a usable `timestamp` takes the previous line's. With none before it, the line makes no events and is counted `noTimestamp`. The 24 h window itself is the log server's (chunk 15b).

## Reproduce the numbers

```bash
vp run logs:probe -- --log-root ~/.claude/projects            # last 24 h: types, versions, key sets, counts, no values
vp run logs:probe -- --log-root ~/.claude/projects --all      # every file
vp run logs:probe -- --log-root ~/.claude/projects --json     # the same as JSON
vp run logs:probe -- --file <session.jsonl>                   # that file's parser counters and token totals
```

The probe prints counts of line types, content block types, key paths and versions. A type name is printed only if it is a plain lowercase word; key names that look like ids or file names print as `<key>`; a path with more than 80 distinct names prints a count. It never prints a prompt, command, path or id, so its output is safe to paste into an issue. A test runs it over a planted fixture and checks that no planted value appears.

The reference token count (DX17), which is also the golden-fixture check (`golden.test.ts` runs it against `jq` when `jq` is installed):

```bash
jq -s '[.[] | select(.type=="assistant" and .message.usage != null)] | group_by(.message.id) | map(map(.message.usage) | {in: (map(.input_tokens // 0)|max), out: (map(.output_tokens // 0)|max), cacheRead: (map(.cache_read_input_tokens // 0)|max), cacheWrite: (map(.cache_creation_input_tokens // 0)|max)}) | {in: (map(.in)|add), out: (map(.out)|add), cacheRead: (map(.cacheRead)|add), cacheWrite: (map(.cacheWrite)|add)}' <file>
```

On one real 1,812-line session the parser, `jq` and `vp run logs:probe -- --file` gave the same four numbers (in 464, out 206,617, cache read 87,067,706, cache write 508,665). `group_by` takes the largest value of each field per message id, the same rule as the parser. Run it per file: message ids are only unique within a file.

## Fixtures

`vp run logs:fixture -- --vendor claude --file <session.jsonl> --out <fixture.jsonl> [--lines <n>]` cuts a real session into a committable fixture. It builds the output from an allow-list: ids, timestamps, types, versions, the four usage numbers, and the shape of tool inputs stay; every prompt, reply, thinking block, tool output, command, path, URL, branch and repo name is replaced. A command is replaced by a representative one of the same `toolClass` (`git commit -m message`, `vitest run`, `tsc --noEmit`, `ls`); a path by `/repo/src/file-N.ext` (inside the project) or `/home/user/file-N.ext` (outside); plan text by `task N`, equal text getting equal placeholders; an unknown tool name by `mcp__server__toolN`; an injected tag keeps its tag word so it is still skipped. It prints what it replaced as counts, then runs the privacy scan and exits non-zero on any hit. The privacy test (`scripts/make-fixture.test.ts`) fails, printing file, line and token, on this machine's home directory, username or host name, `/Users/`, `github.com`, `http://` or `https://` in any committed fixture; a test plants each of them to prove it fails.

| Fixture | Source | Shows |
| --- | --- | --- |
| `claude-desktop-plan.jsonl` | 300 lines of a 2.1.295 session | `update_plan` items and `advance`, three failed tool results, injected prompts, a working directory that moves into a subfolder |
| `claude-todowrite.jsonl` | 290 lines of a 2.1.138 session (outside the tested range) | prompts, `TodoWrite`, an `api_error`, `end_turn`, a failed tool result, file edits, a `git commit` |

Every line of both was read before they were committed. Their token totals equal the reference counter exactly.

## Fixed v1 limits (DX20)

- **24 h backfill:** only files modified in the last 24 h are read at startup (TODOS `--since`).
- **32 MiB line cap:** a longer line is skipped and counted `oversize`.
- **Tested range:** 2.1.260 to 2.1.295. A version outside it is not refused; the app says so (chunk 15b).
- toolClass is not user-extendable; one working root per session; in-file sidechains are ignored; the desktop plan tool is best effort; output tokens are the largest value over a message's lines.

## When a vendor updates

1. Run `vp run logs:probe -- --log-root <your root>` and read the line types, content block types and versions.
2. Compare the type list with the tables above. A new type is counted `unknown` until you add it to `IGNORED_TYPES` (or map it in `claude.ts`) and to this page.
3. If a mapped line changed shape, find it with `vp run logs:probe -- --file <path>` (first byte offset of each class) and fix the parser with a test line that has the new shape.
4. Update `TESTED_VERSIONS` in `sidecar/parsers/types.ts` to the range you checked, and the range in this page.
5. Run `vp test run sidecar/parsers`; the golden fixtures and the reference counter must still agree. If the format moved, cut a fresh fixture with `vp run logs:fixture`.
6. Report the probe output in an issue; it holds no values.
