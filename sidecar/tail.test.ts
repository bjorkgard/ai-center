import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { CHUNK_BYTES, FileTail, fileIdOf } from "./tail.ts";

const dir = mkdtempSync(join(tmpdir(), "sh-tail-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(dir, `f${n++}.jsonl`);

async function total(tail: FileTail): Promise<number> {
  const r = await tail.poll();
  if (r.kind !== "ok") throw new Error("file is missing");
  return r.total;
}

describe("partial lines, truncation, rotation (G1)", () => {
  test("counts complete lines and holds a partial one until it is finished", async () => {
    const file = fresh();
    writeFileSync(file, "a\nb\npartial");
    const tail = new FileTail(file);
    expect(await total(tail)).toBe(2);
    expect(tail.offset).toBe(4); // the byte after the last newline, never bytes read
    appendFileSync(file, " line\n");
    expect(await total(tail)).toBe(3);
    expect(tail.offset).toBe(Buffer.byteLength("a\nb\npartial line\n"));
    expect(await total(tail)).toBe(3);
  });

  test("a truncated file is re-read from 0 and the total replaces the old one", async () => {
    const file = fresh();
    writeFileSync(file, "1\n2\n3\n4\n");
    const tail = new FileTail(file);
    expect(await total(tail)).toBe(4);
    truncateSync(file, 0);
    appendFileSync(file, "x\n");
    const r = await tail.poll();
    expect(r).toMatchObject({ kind: "ok", total: 1, changed: true });
  });

  test("a rotated file (new file id at the same path) is re-read from 0", async () => {
    const file = fresh();
    writeFileSync(file, "1\n2\n3\n");
    const tail = new FileTail(file);
    const before = await tail.poll();
    const next = fresh();
    writeFileSync(next, "a\nb\nc\nd\ne\n");
    renameSync(next, file);
    const after = await tail.poll();
    expect(before).toMatchObject({ kind: "ok", total: 3 });
    expect(after).toMatchObject({ kind: "ok", total: 5, changed: true });
    expect((after as { fileId: string }).fileId).not.toBe((before as { fileId: string }).fileId);
  });

  test("a file replaced by a shorter one while the server was down is read from 0", async () => {
    const file = fresh();
    writeFileSync(file, "1\n2\n3\n4\n5\n6\n");
    const tail = new FileTail(file);
    expect(await total(tail)).toBe(6);
    const next = fresh();
    writeFileSync(next, "only\n");
    renameSync(next, file);
    expect(await total(tail)).toBe(1);
  });

  test("a missing file reports missing", async () => {
    expect(await new FileTail(join(dir, "nope.jsonl")).poll()).toEqual({ kind: "missing" });
  });

  test("bytes outside UTF-8 are counted by newline only", async () => {
    const file = fresh();
    writeFileSync(file, Buffer.from([0xff, 0xfe, 0x0a, 0xc3, 0x0a]));
    expect(await total(new FileTail(file))).toBe(2);
  });
});

describe("chunked reads and the serial queue", () => {
  test("reads in chunks of at most 64 KiB", async () => {
    const file = fresh();
    writeFileSync(file, "0123456789\n".repeat(30_000));
    const reads: number[] = [];
    const tail = new FileTail(file, { onRead: (bytes) => reads.push(bytes) });
    expect(await total(tail)).toBe(30_000);
    expect(reads.length).toBeGreaterThan(4);
    expect(Math.max(...reads)).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  test("overlapping polls (a watch event racing a rescan) give one correct total", async () => {
    const file = fresh();
    writeFileSync(file, "a\nb\nc\n");
    const tail = new FileTail(file);
    const results = await Promise.all([tail.poll(), tail.poll(), tail.poll()]);
    expect(results.map((r) => (r.kind === "ok" ? r.total : -1))).toEqual([3, 3, 3]);
    expect(results.filter((r) => r.kind === "ok" && r.changed)).toHaveLength(1);
  });
});

describe("fileId", () => {
  test("is dev:ino, exact for an inode above 2^53", () => {
    const ino = 2n ** 60n + 1n;
    expect(fileIdOf({ dev: 16777231n, ino, birthtimeMs: 1, size: 5n })).toBe(`16777231:${ino}`);
  });

  test("falls back to birthtime plus size when ino is 0n (Windows)", () => {
    const id = fileIdOf({ dev: 3n, ino: 0n, birthtimeMs: 1700000000123.5, size: 42n });
    expect(id).toContain("1700000000123.5");
    expect(id).toContain("42");
    expect(id).not.toBe(fileIdOf({ dev: 3n, ino: 0n, birthtimeMs: 1700000000999, size: 42n }));
  });
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "an unreadable file rejects with EACCES",
  async () => {
    const file = fresh();
    writeFileSync(file, "a\n");
    chmodSync(file, 0o000);
    await expect(new FileTail(file).poll()).rejects.toMatchObject({ code: "EACCES" });
    chmodSync(file, 0o600);
  },
);
