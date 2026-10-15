import { createHash } from "node:crypto";
import { open, stat, type FileHandle } from "node:fs/promises";

/** Files are read in chunks of this many bytes, yielding to the event loop between chunks. */
export const CHUNK_BYTES = 64 * 1024;

export interface StatLike {
  dev: bigint;
  ino: bigint;
  birthtimeMs: number | bigint;
  size: number | bigint;
}

/**
 * `dev:ino` as a string so inodes above 2^53 stay exact. Windows reports ino 0n; there the id
 * is the birth time plus the size.
 */
export function fileIdOf(s: StatLike): string {
  if (s.ino === 0n) return `${s.dev}:b${s.birthtimeMs}:${s.size}`;
  return `${s.dev}:${s.ino}`;
}

export type PollResult =
  | { kind: "missing" }
  | { kind: "ok"; fileId: string; total: number; changed: boolean };

export interface FileTailOptions {
  /** Called with the size of every read (a test hook for the 64 KiB bound). */
  onRead?: (bytes: number) => void;
}

const PRINT_BYTES = 4096;

/** Hash of the first bytes before `offset` plus the byte at `offset - 1`, which must end a line. */
async function fingerprint(handle: FileHandle, offset: number): Promise<string> {
  if (offset === 0) return "";
  const head = Buffer.alloc(Math.min(offset, PRINT_BYTES));
  const last = Buffer.alloc(1);
  await handle.read(head, 0, head.length, 0);
  await handle.read(last, 0, 1, offset - 1);
  return `${createHash("sha1").update(head).digest("hex")}:${last[0]}`;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Tails one file by byte offset. `offset` is always the byte after the last complete newline,
 * never bytes read, so a partial line is read again once it is finished. A changed file id or a
 * file shorter than `offset` is re-read from 0. Every `poll()` goes through one serial queue, so
 * a watch event, the rescan and a resume that overlap give the same total.
 */
export class FileTail {
  readonly path: string;
  #fileId = "";
  #offset = 0;
  #lines = 0;
  #print = "";
  #queue: Promise<unknown> = Promise.resolve();
  readonly #onRead: ((bytes: number) => void) | undefined;

  constructor(path: string, options: FileTailOptions = {}) {
    this.path = path;
    this.#onRead = options.onRead;
  }

  get fileId(): string {
    return this.#fileId;
  }
  get offset(): number {
    return this.#offset;
  }
  get lines(): number {
    return this.#lines;
  }

  poll(): Promise<PollResult> {
    const run = () => this.#poll();
    const next = this.#queue.then(run, run);
    this.#queue = next;
    return next;
  }

  async #poll(): Promise<PollResult> {
    let info;
    try {
      info = await stat(this.path, { bigint: true });
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { kind: "missing" };
      throw error;
    }
    const fileId = fileIdOf(info);
    const size = Number(info.size);
    let changed = false;
    // The birth-time fallback id includes the size, so appends alone change it there; the
    // offset then still holds and only a shrink forces a re-read.
    const sameFile = fileId === this.#fileId || (info.ino === 0n && size >= this.#offset);
    const handle = await open(this.path, "r");
    // A copy-truncate keeps the inode and may regrow past the old offset, so the bytes before
    // the offset must still be the ones the offset was counted over.
    let rewritten = false;
    if (sameFile && size >= this.#offset && this.#offset > 0 && this.#fileId !== "") {
      try {
        rewritten = (await fingerprint(handle, this.#offset)) !== this.#print;
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    if (this.#fileId !== "" && (!sameFile || size < this.#offset || rewritten)) {
      this.#offset = 0;
      this.#lines = 0;
      changed = true;
    }
    if (this.#fileId === "") changed = true;
    this.#fileId = fileId;

    try {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      let position = this.#offset;
      let lines = this.#lines;
      let consumed = this.#offset;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, position);
        if (bytesRead === 0) break;
        this.#onRead?.(bytesRead);
        for (let i = 0; i < bytesRead; i++) {
          if (buffer[i] === 0x0a) {
            lines++;
            consumed = position + i + 1;
          }
        }
        position += bytesRead;
        await yieldToLoop();
      }
      if (lines !== this.#lines || consumed !== this.#offset) changed = true;
      this.#lines = lines;
      this.#offset = consumed;
      this.#print = await fingerprint(handle, consumed);
    } finally {
      await handle.close();
    }
    return { kind: "ok", fileId: this.#fileId, total: this.#lines, changed };
  }
}
