import { beforeEach, expect, test, vi } from "vite-plus/test";
import { createLiveSource, type SocketLike } from "../../data/liveSource.ts";
import { mockEvents } from "../../data/mock.ts";
import type { LogMessage, Source, SourceStatus } from "../../data/schema.ts";
import { resetStore, useStore } from "./index.ts";

const store = () => useStore.getState();

class LogSource implements Source {
  name = "live";
  private log: (m: LogMessage) => void = () => {};
  private events: (e: unknown[]) => void = () => {};
  private status: (s: SourceStatus, d?: string) => void = () => {};
  onEvents(cb: (e: unknown[]) => void) {
    this.events = cb;
  }
  onLog(cb: (m: LogMessage) => void) {
    this.log = cb;
  }
  onStatus(cb: (s: SourceStatus, d?: string) => void) {
    this.status = cb;
  }
  start() {}
  stop() {}
  say(m: LogMessage) {
    this.log(m);
  }
  emit(e: unknown[]) {
    this.events(e);
  }
  report(s: SourceStatus, d?: string) {
    this.status(s, d);
  }
}

const lines = (path: string, total: number, fileId = "1:1"): LogMessage => ({
  type: "lines",
  path,
  fileId,
  total,
});

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  resetStore();
});

test("line totals land in logLines keyed by path and fileId, and a re-read replaces the value", () => {
  const source = new LogSource();
  store().connect(source);
  expect(store().logSeen).toBe(false);
  source.say(lines("/a.jsonl", 3));
  expect(store().logSeen).toBe(true);
  source.say(lines("/a.jsonl", 3, "1:2"));
  source.say(lines("/b.jsonl", 7));
  expect(Object.keys(store().logLines).toSorted()).toEqual([
    "/a.jsonl1:1",
    "/a.jsonl1:2",
    "/b.jsonl1:1",
  ]);
  source.say(lines("/a.jsonl", 4));
  expect(store().logLines["/a.jsonl1:1"]).toEqual({ path: "/a.jsonl", fileId: "1:1", total: 4 });
  expect(Object.keys(store().logLines)).toHaveLength(3);
});

test("log messages never go through applyBatch", () => {
  const source = new LogSource();
  store().connect(source);
  const sessions = store().sessions;
  source.say(lines("/a.jsonl", 3));
  source.say({ type: "progress", done: 1, total: 2 });
  source.say({ type: "roots", roots: [{ path: "/r", files: 1, source: "env" }] });
  expect(store().dataHealth.batches).toBe(0);
  expect(store().sessions).toBe(sessions);
  expect(store().logProgress).toEqual({ done: 1, total: 2 });
  expect(store().logRoots).toEqual([{ path: "/r", files: 1, source: "env" }]);
});

test("a new connect and a disconnect clear the log state", () => {
  const source = new LogSource();
  store().connect(source);
  source.say(lines("/a.jsonl", 3));
  source.say({ type: "progress", done: 1, total: 2 });
  store().connect(new LogSource());
  expect(store().logLines).toEqual({});
  expect(store().logProgress).toBeNull();
  expect(store().logRoots).toBeNull();
  expect(store().logSeen).toBe(false);
  source.say(lines("/stale.jsonl", 1));
  expect(store().logLines).toEqual({});
});

test("reconnecting is a status of its own and is not final", () => {
  const source = new LogSource();
  store().connect(source);
  source.report("live");
  source.report("reconnecting");
  expect(store().source.status).toBe("reconnecting");
  source.report("live");
  expect(store().source.status).toBe("live");
});

test("a dropped and restored live socket changes the status only: no connect, same epoch and logs", () => {
  const sockets: (SocketLike & { say(m: unknown): void; drop(): void; open(): void })[] = [];
  const pending: (() => void)[] = [];
  const source = createLiveSource({
    url: "ws://x/api/stream",
    token: () => "t",
    schedule: (fn) => {
      pending.push(fn);
      return () => {};
    },
    createSocket: () => {
      const s = {
        onopen: null as (() => void) | null,
        onmessage: null as ((e: { data: unknown }) => void) | null,
        onclose: null as ((e: { code: number; reason: string }) => void) | null,
        send() {},
        close() {},
        say(m: unknown) {
          s.onmessage?.({ data: JSON.stringify(m) });
        },
        drop() {
          s.onclose?.({ code: 1006, reason: "" });
        },
        open() {
          s.onopen?.();
        },
      };
      sockets.push(s);
      return s;
    },
  });
  store().connect(source);
  const epoch = store().sourceEpoch;
  const last = () => sockets[sockets.length - 1];
  last().open();
  last().say({ type: "progress", done: 1, total: 1 });
  last().say({ type: "lines", path: "/a", fileId: "1:1", total: 3 });
  expect(store().source.status).toBe("live");
  last().drop();
  expect(store().source.status).toBe("reconnecting");
  expect(store().logLines["/a1:1"].total).toBe(3);
  pending.shift()?.();
  last().open();
  last().say({ type: "progress", done: 1, total: 1 });
  last().say({ type: "lines", path: "/a", fileId: "1:1", total: 3 });
  expect(store().source.status).toBe("live");
  expect(store().sourceEpoch).toBe(epoch);
  expect(store().logLines["/a1:1"].total).toBe(3);
});

test("G13: a catch-up batch with 20 errors raises no toast", () => {
  const source = new LogSource();
  store().connect(source);
  source.report("catching_up");
  const errors = mockEvents(1, "errors", 0, 10 * 60_000)
    .filter((e) => e.type === "error")
    .slice(0, 20);
  expect(errors).toHaveLength(20);
  source.emit(errors);
  expect(store().dataHealth.applied).toBe(20);
  expect(store().toasts).toEqual([]);
});
