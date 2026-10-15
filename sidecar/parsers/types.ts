import type { AgentEvent } from "../../src/data/schema.ts";

/** Longest line the parsers accept; a longer one is skipped and counted `oversize` (C99). */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Inclusive version range each vendor's rules were checked against (n=1 machine, see the format docs). */
export const TESTED_VERSIONS = {
  claude: { from: "2.1.260", to: "2.1.295" },
} as const;

/**
 * Everything a parser needs from outside. The parsers do no I/O; the log server (chunk 15b)
 * supplies these, fixture tests pass stubs.
 */
export interface ParserDeps {
  /** The project key of a main session, from the working directory it first reported. */
  resolveProjectKey(sessionId: string, cwd: string): string;
  /** The current project key of a subagent's root session (`cwd` is the subagent's own). */
  rootProjectKey(rootSessionId: string, cwd: string): string;
  /** Reads a subagent's `.meta.json`; called once per file. */
  readMeta(metaPath: string): { agentType?: string } | undefined;
}

/** Counters that make a parser's silence visible: what it skipped and the first place it did. */
export interface ParserHealth {
  lines: number;
  malformed: number;
  unknown: number;
  oversize: number;
  ignored: number;
  /** Lines whose usage differed from the first line of the same message (the first is kept). */
  drift: number;
  /** Lines in a main file that belong to an in-file sidechain (ignored, a known gap). */
  sidechain: number;
  /** Lines with no usable timestamp and no earlier one to borrow (E19); their events are dropped. */
  noTimestamp: number;
  events: number;
  /** Byte offset of the first line of each class above (DX14). */
  firstOffsets: Record<string, number>;
  /** Unknown type names with counts (names are cut to 40 characters). */
  unknownTypes: Record<string, number>;
  versions: string[];
  tokens: { in: number; out: number; cacheRead: number; cacheWrite: number };
}

export type ParseResult<S> = { events: AgentEvent[]; state: S };
