import { describe, expect, test } from "vite-plus/test";
import { eventId, fileIdentity, lineHash, shortHash } from "./ids.ts";

const stat = (ino: bigint, birthtimeMs = 1_700_000_000_000.5) => ({
  dev: 16777231n,
  ino,
  birthtimeMs,
});
const LINE = '{"type":"user","uuid":"u1"}';

describe("fileIdentity (E4)", () => {
  test("is dev:ino when the inode is known", () => {
    expect(fileIdentity(stat(12345678901234567890n), LINE)).toBe("16777231:12345678901234567890");
    expect(fileIdentity(stat(7n), undefined)).toBe("16777231:7");
  });

  test("with ino 0n it is the birth time plus the first line's hash", () => {
    const a = fileIdentity(stat(0n), LINE)!;
    expect(a).toMatch(/^b1700000000000\.5:[0-9a-f]{16}$/);
    expect(fileIdentity(stat(0n), LINE)).toBe(a);
    expect(fileIdentity(stat(0n), `${LINE} `)).not.toBe(a);
    expect(fileIdentity(stat(0n, 1_700_000_000_001), LINE)).not.toBe(a);
  });

  test("with ino 0n and no complete line there is no identity yet", () => {
    expect(fileIdentity(stat(0n), undefined)).toBeUndefined();
  });
});

describe("eventId", () => {
  const base = () => eventId("claude", "1:2", 100, lineHash(LINE), 0);

  test("is stable and 32 hex characters", () => {
    expect(base()).toBe(base());
    expect(base()).toMatch(/^[0-9a-f]{32}$/);
  });

  test.each([
    ["vendor", () => eventId("codex", "1:2", 100, lineHash(LINE), 0)],
    ["file", () => eventId("claude", "1:3", 100, lineHash(LINE), 0)],
    ["offset", () => eventId("claude", "1:2", 101, lineHash(LINE), 0)],
    ["content", () => eventId("claude", "1:2", 100, lineHash(`${LINE} `), 0)],
    ["index", () => eventId("claude", "1:2", 100, lineHash(LINE), 1)],
  ])("a different %s gives a different id", (_name, other) => {
    expect(other()).not.toBe(base());
  });

  test("fields cannot run together into the same id", () => {
    expect(eventId("claude", "1:2", 10, "ab", 0)).not.toBe(eventId("claude", "1:2", 1, "0ab", 0));
  });
});

describe("shortHash", () => {
  test("is 16 hex characters and order dependent", () => {
    expect(shortHash("a", "b")).toMatch(/^[0-9a-f]{16}$/);
    expect(shortHash("a", "b")).not.toBe(shortHash("b", "a"));
    expect(shortHash("ab", "c")).not.toBe(shortHash("a", "bc"));
  });
});
