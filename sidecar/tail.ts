import { open, stat } from "node:fs/promises";

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
    if (this.#fileId !== "" && (!sameFile || size < this.#offset)) {
      this.#offset = 0;
      this.#lines = 0;
      changed = true;
    }
    if (this.#fileId === "") changed = true;
    this.#fileId = fileId;

    const handle = await open(this.path, "r");
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
    } finally {
      await handle.close();
    }
    return { kind: "ok", fileId: this.#fileId, total: this.#lines, changed };
  }
}
