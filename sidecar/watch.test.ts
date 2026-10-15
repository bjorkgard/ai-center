import { EventEmitter } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vite-plus/test";
import { createWatcher, type Watcher, type WatchOptions } from "./watch.ts";

const base = mkdtempSync(join(tmpdir(), "sh-watch-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const freshRoot = () => {
  const root = join(base, `r${n++}`);
  mkdirSync(root, { recursive: true });
  return root;
};

const watchers: Watcher[] = [];
afterEach(() => {
  while (watchers.length > 0) watchers.pop()!.stop();
});

/** Concurrent tests pass their own `onTestFinished`: the shared afterEach would stop their neighbours. */
function setup(
  roots: string[],
  options: Partial<WatchOptions> = {},
  onFinished?: (fn: () => void) => void,
) {
  const seen: string[] = [];
  const logs: string[] = [];
  const watcher = createWatcher({
    roots,
    onFile: (path) => seen.push(path),
    log: (line) => logs.push(line),
    ...options,
  });
  if (onFinished) onFinished(() => watcher.stop());
  else watchers.push(watcher);
  const waitFor = async (path: string, ms: number) => {
    const started = Date.now();
    while (Date.now() - started < ms) {
      if (seen.includes(path)) return Date.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`${path} not seen within ${ms} ms (seen: ${seen.join(", ")})`);
  };
  return { watcher, seen, logs, waitFor };
}

const err = (code: string) => Object.assign(new Error(`${code}: limit`), { code });

describe("with watch events", () => {
  test("append and create are seen within 1 s", async () => {
    const root = freshRoot();
    const file = join(root, "a.jsonl");
    writeFileSync(file, "x\n");
    const { watcher, waitFor, seen } = setup([root]);
    await watcher.start();
    expect(watcher.files()).toEqual([file]);
    expect(watcher.roots()[0]).toMatchObject({ path: root, state: "watching", files: 1 });
    appendFileSync(file, "y\n");
    await waitFor(file, 1000);
    const created = join(root, "sub", "b.jsonl");
    mkdirSync(join(root, "sub"));
    writeFileSync(created, "z\n");
    await waitFor(created, 1000);
    expect(seen.every((p) => p.endsWith(".jsonl"))).toBe(true);
  });

  test("files that are not .jsonl are ignored", async () => {
    const root = freshRoot();
    const { watcher, seen } = setup([root]);
    await watcher.start();
    writeFileSync(join(root, "notes.txt"), "x\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual([]);
  });

  test("a file older than 24 h at startup is not listed", async () => {
    const root = freshRoot();
    const old = join(root, "old.jsonl");
    writeFileSync(old, "x\n");
    const past = new Date(Date.now() - 25 * 3600_000);
    utimesSync(old, past, past);
    const { watcher } = setup([root]);
    await watcher.start();
    expect(watcher.files()).toEqual([]);
    expect(watcher.roots()[0].files).toBe(0);
  });
});

describe("rescan only (events disabled): seen within 6 s", () => {
  test.concurrent("append, create, truncate and rotate", async ({ onTestFinished }) => {
    const root = freshRoot();
    const appended = join(root, "append.jsonl");
    const truncated = join(root, "truncate.jsonl");
    const rotated = join(root, "rotate.jsonl");
    for (const f of [appended, truncated, rotated]) writeFileSync(f, "1\n2\n3\n");
    const { watcher, waitFor } = setup([root], { events: false }, onTestFinished);
    await watcher.start();
    expect(watcher.roots()[0]).toMatchObject({ state: "polling" });
    appendFileSync(appended, "4\n");
    truncateSync(truncated, 0);
    const created = join(root, "deep", "created.jsonl");
    mkdirSync(join(root, "deep"));
    writeFileSync(created, "x\n");
    const next = join(root, "next.tmp");
    writeFileSync(next, "n\n");
    renameSync(next, rotated);
    await Promise.all([appended, truncated, created, rotated].map((f) => waitFor(f, 6000)));
  }, 15_000);

  test.concurrent("a root created after start is picked up", async ({ onTestFinished }) => {
    const root = join(base, `late${n++}`);
    const { watcher, waitFor, logs } = setup([root], {}, onTestFinished);
    await watcher.start();
    expect(watcher.roots()[0]).toMatchObject({ path: root, state: "missing" });
    mkdirSync(root);
    const file = join(root, "late.jsonl");
    writeFileSync(file, "x\n");
    await waitFor(file, 6000);
    expect(watcher.roots()[0]).toMatchObject({ state: "watching", files: 1 });
    expect(logs.filter((l) => l.startsWith("[logs]") && l.includes(root))).not.toHaveLength(0);
  }, 15_000);
});

describe("watcher failures fall back to rescan-only", () => {
  test.concurrent("ENOSPC thrown by watch()", async ({ onTestFinished }) => {
    const root = freshRoot();
    const file = join(root, "a.jsonl");
    writeFileSync(file, "x\n");
    const { watcher, waitFor, logs } = setup(
      [root],
      {
        watch: () => {
          throw err("ENOSPC");
        },
      },
      onTestFinished,
    );
    await watcher.start();
    expect(watcher.roots()[0]).toMatchObject({ state: "polling" });
    expect(logs.join("\n")).toMatch(
      /\[logs\] cannot watch .*ENOSPC.*polling every 5 s.*max_user_watches.*#configuration/s,
    );
    appendFileSync(file, "y\n");
    await waitFor(file, 6000);
  }, 15_000);

  // Regression: a shared afterEach used to stop every concurrent test's watcher as soon as the
  // first of them finished, starving the rescan tests (seen on Linux CI).
  test.concurrent("a quick concurrent test does not stop its neighbours", async ({
    onTestFinished,
  }) => {
    const { watcher } = setup([freshRoot()], {}, onTestFinished);
    await watcher.start();
  });

  // A watch that never reports (a dropped or late event, as seen on a loaded runner) must not
  // hide a new file for good: the rescan of a watched root also lists it.
  test.concurrent("a file created while events are lost is found by the rescan", async ({
    onTestFinished,
  }) => {
    const root = freshRoot();
    const emitter = Object.assign(new EventEmitter(), { close: () => {} });
    const { watcher, waitFor } = setup([root], { watch: () => emitter as never }, onTestFinished);
    await watcher.start();
    expect(watcher.roots()[0]).toMatchObject({ state: "watching" });
    const file = join(root, "lost.jsonl");
    writeFileSync(file, "x\n");
    await waitFor(file, 6000);
    expect(watcher.roots()[0].files).toBe(1);
  }, 15_000);

  test.concurrent("ENOSPC emitted later as an 'error' event", async ({ onTestFinished }) => {
    const root = freshRoot();
    const file = join(root, "a.jsonl");
    writeFileSync(file, "x\n");
    const emitter = Object.assign(new EventEmitter(), { close: () => {} });
    const { watcher, waitFor, logs } = setup(
      [root],
      { watch: () => emitter as never },
      onTestFinished,
    );
    await watcher.start();
    expect(watcher.roots()[0]).toMatchObject({ state: "watching" });
    emitter.emit("error", err("ENOSPC"));
    expect(watcher.roots()[0]).toMatchObject({ state: "polling" });
    expect(logs.join("\n")).toContain("ENOSPC");
    appendFileSync(file, "y\n");
    await waitFor(file, 6000);
  }, 15_000);

  test("another watch error names its code", async () => {
    const root = freshRoot();
    const { watcher, logs } = setup([root], {
      watch: () => {
        throw err("EMFILE");
      },
    });
    await watcher.start();
    expect(watcher.roots()[0]).toMatchObject({ state: "polling" });
    expect(logs.join("\n")).toContain("EMFILE");
  });
});

test("a file added to or removed from a running root notifies root subscribers", async () => {
  const root = freshRoot();
  let notified = 0;
  const { watcher } = setup([root], { onRoots: () => notified++ });
  await watcher.start();
  const before = notified;
  const file = join(root, "new.jsonl");
  writeFileSync(file, "x\n");
  const started = Date.now();
  // Events normally report this at once; a lost one is caught by the 5 s rescan.
  while (notified === before && Date.now() - started < 6500) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(notified).toBeGreaterThan(before);
  expect(watcher.roots()[0].files).toBe(1);
  const afterAdd = notified;
  rmSync(file);
  // The removal is seen by the event or, at the latest, the 5 s rescan.
  const removed = Date.now();
  while (notified === afterAdd && Date.now() - removed < 6500) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(notified).toBeGreaterThan(afterAdd);
  expect(watcher.roots()[0].files).toBe(0);
}, 15_000);

test("stop() closes every handle", async () => {
  const root = freshRoot();
  let closed = 0;
  const emitter = Object.assign(new EventEmitter(), { close: () => closed++ });
  const { watcher } = setup([root], { watch: () => emitter as never });
  await watcher.start();
  watcher.stop();
  expect(closed).toBe(1);
});
