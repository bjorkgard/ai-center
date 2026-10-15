import { expect, test } from "vite-plus/test";
import {
  BACKOFF_MS,
  SESSION_EXPIRED,
  WIRE_MISMATCH,
  SessionRejected,
  createLiveSource,
  type SocketLike,
} from "./liveSource.ts";
import type { LogMessage, SourceStatus } from "./schema.ts";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sent: unknown[] = [];
  closed = false;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
  }
  // Server side.
  open(): void {
    this.onopen?.();
  }
  say(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006): void {
    this.onclose?.({ code, reason: "" });
  }
}

const roots = (files: number) => ({
  type: "roots",
  roots: [{ path: "/logs", files, source: "env" }],
});
const lines = (path: string, total: number) => ({ type: "lines", path, fileId: "1:1", total });

interface Rig {
  sockets: FakeSocket[];
  statuses: SourceStatus[];
  details: (string | undefined)[];
  logs: LogMessage[];
  delays: number[];
  fetched: number;
  fire(): void;
  last(): FakeSocket;
  source: ReturnType<typeof createLiveSource>;
}

function rig(options: { token?: string | null; fetchSession?: () => Promise<string> } = {}): Rig {
  const pending: (() => void)[] = [];
  const r: Rig = {
    sockets: [],
    statuses: [],
    details: [],
    logs: [],
    delays: [],
    fetched: 0,
    fire: () => pending.shift()?.(),
    last: () => r.sockets[r.sockets.length - 1],
    source: createLiveSource({
      url: "ws://127.0.0.1:1/api/stream",
      token: () => (options.token === undefined ? "tok-1" : options.token),
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        r.sockets.push(socket);
        return socket;
      },
      fetchSession:
        options.fetchSession ??
        (async () => {
          r.fetched++;
          return "tok-2";
        }),
      schedule: (fn, ms) => {
        r.delays.push(ms);
        const run = () => fn();
        pending.push(run);
        return () => {
          const at = pending.indexOf(run);
          if (at !== -1) pending.splice(at, 1);
        };
      },
    }),
  };
  r.source.onEvents(() => {});
  r.source.onLog?.((m) => r.logs.push(m));
  r.source.onStatus((s, d) => {
    r.statuses.push(s);
    r.details.push(d);
  });
  return r;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

// What an uninterrupted server run sends to a client that has just said hello.
const greet = (s: FakeSocket, done = 2, total = 2) => {
  s.say({ type: "heartbeat" });
  s.say(roots(total));
  s.say({ type: "progress", done, total });
  s.say(lines("/a.jsonl", 3));
  s.say(lines("/b.jsonl", 5));
};

test("is named live, has no clock of its own and connects only on start", () => {
  const r = rig();
  expect(r.source.name).toBe("live");
  expect(r.source.clock).toBeUndefined();
  expect(r.sockets).toHaveLength(0);
  r.source.start();
  expect(r.sockets).toHaveLength(1);
  expect(r.statuses).toEqual(["connecting"]);
});

test("sends hello with the page token on open, then follows progress to live", () => {
  const r = rig();
  r.source.start();
  r.last().open();
  expect(r.last().sent).toEqual([{ type: "hello", token: "tok-1", cursors: [] }]);
  r.last().say({ type: "heartbeat" });
  r.last().say(roots(2));
  r.last().say({ type: "progress", done: 1, total: 2 });
  expect(r.statuses).toEqual(["connecting", "catching_up"]);
  r.last().say({ type: "progress", done: 2, total: 2 });
  expect(r.statuses).toEqual(["connecting", "catching_up", "live"]);
  expect(r.logs.map((m) => m.type)).toEqual(["roots", "progress", "progress"]);
});

test("forwards absolute line totals to the log callback", () => {
  const r = rig();
  r.source.start();
  r.last().open();
  r.last().say(lines("/a.jsonl", 3));
  r.last().say(lines("/a.jsonl", 4));
  expect(r.logs).toEqual([lines("/a.jsonl", 3), lines("/a.jsonl", 4)]);
});

test("kill and restart: the totals equal an uninterrupted run and the cursors are sent back", () => {
  const totals = (logs: LogMessage[]) => {
    const map = new Map<string, number>();
    for (const m of logs) if (m.type === "lines") map.set(m.path + m.fileId, m.total);
    return Object.fromEntries(map);
  };
  const steady = rig();
  steady.source.start();
  steady.last().open();
  greet(steady.last());
  steady.last().say(lines("/a.jsonl", 4));

  const killed = rig();
  killed.source.start();
  killed.last().open();
  greet(killed.last());
  killed.last().drop();
  expect(killed.statuses.at(-1)).toBe("reconnecting");
  killed.fire();
  killed.last().open();
  expect(killed.last().sent).toEqual([
    {
      type: "hello",
      token: "tok-1",
      cursors: [
        { path: "/a.jsonl", fileId: "1:1", offset: 0 },
        { path: "/b.jsonl", fileId: "1:1", offset: 0 },
      ],
    },
  ]);
  // The restarted server resends absolute totals, the new line included.
  killed.last().say({ type: "heartbeat" });
  killed.last().say(roots(2));
  killed.last().say({ type: "progress", done: 2, total: 2 });
  killed.last().say(lines("/a.jsonl", 4));
  killed.last().say(lines("/b.jsonl", 5));
  expect(totals(killed.logs)).toEqual(totals(steady.logs));
  expect(killed.statuses.at(-1)).toBe("live");
});

test("dropping and restoring the socket three times returns to live each time", () => {
  const r = rig();
  r.source.start();
  r.last().open();
  greet(r.last());
  for (let i = 1; i <= 3; i++) {
    r.last().drop();
    expect(r.statuses.at(-1)).toBe("reconnecting");
    r.fire();
    expect(r.sockets).toHaveLength(i + 1);
    r.last().open();
    greet(r.last());
    expect(r.statuses.at(-1)).toBe("live");
  }
  expect(r.statuses).not.toContain("error");
  // Each drop came after an accepted connection, so each wait starts again at 1 s.
  expect(r.delays).toEqual([1000, 1000, 1000]);
});

test("retries back off 1 s, 2 s, 4 s and then every 10 s while the server stays down", () => {
  const r = rig();
  r.source.start();
  for (let i = 0; i < 6; i++) {
    r.last().drop();
    r.fire();
  }
  expect(r.delays).toEqual([...BACKOFF_MS, 10_000, 10_000]);
  expect(BACKOFF_MS).toEqual([1000, 2000, 4000, 10_000]);
  expect(r.statuses.at(-1)).toBe("reconnecting");
  expect(r.statuses).not.toContain("error");
});

test("a close with 4401 fetches one fresh token and reconnects with it, no reload", async () => {
  const r = rig();
  r.source.start();
  r.last().open();
  greet(r.last());
  r.last().drop(4401);
  await flush();
  expect(r.fetched).toBe(1);
  expect(r.sockets).toHaveLength(2);
  r.last().open();
  expect(r.last().sent).toMatchObject([{ type: "hello", token: "tok-2" }]);
  greet(r.last());
  expect(r.statuses.at(-1)).toBe("live");
  expect(r.statuses).not.toContain("error");
  // A later rejection gets its own refresh again.
  r.last().drop(4401);
  await flush();
  expect(r.fetched).toBe(2);
});

test("a second rejection sets error with the session-expired reason and stops retrying", async () => {
  const r = rig();
  r.source.start();
  r.last().open();
  r.last().drop(4401);
  await flush();
  r.last().open();
  r.last().drop(4401);
  await flush();
  expect(r.statuses.at(-1)).toBe("error");
  expect(r.details.at(-1)).toBe(SESSION_EXPIRED);
  expect(r.fetched).toBe(1);
  const count = r.sockets.length;
  r.fire();
  expect(r.sockets).toHaveLength(count);
});

test("a session answer of 401 sets error; a network failure keeps retrying", async () => {
  const rejected = rig({
    fetchSession: async () => {
      throw new SessionRejected(401);
    },
  });
  rejected.source.start();
  rejected.last().drop(4401);
  await flush();
  expect(rejected.statuses.at(-1)).toBe("error");
  expect(rejected.details.at(-1)).toBe(SESSION_EXPIRED);

  const down = rig({
    fetchSession: async () => {
      throw new TypeError("fetch failed");
    },
  });
  down.source.start();
  down.last().drop(4401);
  await flush();
  expect(down.statuses.at(-1)).toBe("reconnecting");
  down.fire();
  expect(down.sockets).toHaveLength(2);
});

test("a page without a token meta asks /api/session before the first socket", async () => {
  const r = rig({ token: null });
  r.source.start();
  expect(r.sockets).toHaveLength(0);
  await flush();
  expect(r.fetched).toBe(1);
  r.last().open();
  expect(r.last().sent).toMatchObject([{ type: "hello", token: "tok-2" }]);
});

test("renewing the token on the first connection keeps the status connecting", async () => {
  const r = rig({ token: null });
  r.source.start();
  await flush();
  expect(r.statuses).toEqual(["connecting"]);
  r.last().open();
  r.last().say({ type: "progress", done: 1, total: 1 });
  expect(r.statuses).toEqual(["connecting", "live"]);
});

test("a message outside the wire schema sets error and closes the socket", () => {
  const r = rig();
  r.source.start();
  r.last().open();
  r.last().say({ type: "events", events: [] });
  expect(r.statuses.at(-1)).toBe("error");
  expect(r.details.at(-1)).toBe(WIRE_MISMATCH);
  expect(r.last().closed).toBe(true);
  r.last().drop();
  r.fire();
  expect(r.sockets).toHaveLength(1);
});

test("an invalid config file in the roots message sets error with its reason", () => {
  const r = rig();
  r.source.start();
  r.last().open();
  r.last().say({
    type: "roots",
    roots: [
      {
        path: "/home/u/.config/synapse/config.json",
        files: 0,
        source: "config",
        reason: "invalid config file: roots must be an array; fix or remove the file",
        configError: true,
      },
    ],
  });
  expect(r.statuses.at(-1)).toBe("error");
  expect(r.details.at(-1)).toContain("invalid config file");
  expect(r.details.at(-1)).toContain("/home/u/.config/synapse/config.json");
});

test("a root reason that merely mentions a config file is not a config error", () => {
  const r = rig();
  r.source.start();
  r.last().open();
  r.last().say({
    type: "roots",
    roots: [{ path: "/x", files: 0, source: "config", reason: "root not found: see config file" }],
  });
  expect(r.statuses).not.toContain("error");
});

test("a missing root is reported through roots and is not an error", () => {
  const r = rig();
  r.source.start();
  r.last().open();
  r.last().say({
    type: "roots",
    roots: [{ path: "/nope", files: 0, source: "flag", reason: "root not found: /nope" }],
  });
  r.last().say({ type: "progress", done: 0, total: 0 });
  expect(r.statuses.at(-1)).toBe("live");
});

test("stop is idempotent and silences everything after it", () => {
  const r = rig();
  r.source.start();
  r.last().open();
  r.source.stop();
  r.source.stop();
  expect(r.last().closed).toBe(true);
  const seen = r.statuses.length;
  r.last().say({ type: "progress", done: 1, total: 1 });
  r.last().drop();
  r.fire();
  expect(r.statuses).toHaveLength(seen);
  expect(r.sockets).toHaveLength(1);
});
