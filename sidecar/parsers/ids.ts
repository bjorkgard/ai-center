import { createHash } from "node:crypto";

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

/** The parts of `fs.Stats` (bigint) that identify a file. */
export interface IdentityStat {
  dev: bigint;
  ino: bigint;
  birthtimeMs: number | bigint;
}

/**
 * What names a file in event ids (E4). Normally `dev:ino`, the same as the 14a cursor's file
 * id. Windows reports `ino` 0n; there it is the birth time plus the hash of the file's first
 * complete line, neither of which changes on a rename or an append (the 14a cursor fallback
 * adds the size, which grows on every append, so it cannot serve here). `undefined` means the
 * file has no complete line yet, so it has no events either.
 */
export function fileIdentity(
  stat: IdentityStat,
  firstLine: string | undefined,
): string | undefined {
  if (stat.ino !== 0n) return `${stat.dev}:${stat.ino}`;
  if (firstLine === undefined) return undefined;
  return `b${stat.birthtimeMs}:${sha256(firstLine).slice(0, 16)}`;
}

export const lineHash = (line: string): string => sha256(line);

/**
 * Stable across restarts and renames, new for rewritten content: the id covers the file identity,
 * the line's byte offset, the hash of its bytes and the index of the event within the line.
 */
export function eventId(
  vendor: string,
  identity: string,
  byteOffset: number,
  hashOfLine: string,
  index: number,
): string {
  return sha256([vendor, identity, byteOffset, hashOfLine, index].join("\0")).slice(0, 32);
}

/** Short stable id for a plan item. */
export const shortHash = (...parts: (string | number)[]): string =>
  sha256(parts.join("\0")).slice(0, 16);
