import { expect, test } from "vite-plus/test";
import { ClientMessage, parseClientMessage, parseServerMessage, ServerMessage } from "./wire.ts";

test("accepts every message type of the protocol", () => {
  const hello = {
    type: "hello",
    token: "t",
    cursors: [{ path: "/a.jsonl", fileId: "1:2", offset: 0 }],
  };
  expect(ClientMessage.safeParse(hello).success).toBe(true);
  for (const message of [
    { type: "lines", path: "/a.jsonl", fileId: "1:2", total: 3 },
    { type: "progress", done: 1, total: 4 },
    { type: "roots", roots: [{ path: "/r", files: 2, source: "flag" }] },
    {
      type: "roots",
      roots: [{ path: "/r", files: 0, reason: "root not found", source: "default" }],
    },
    { type: "heartbeat" },
  ]) {
    expect(ServerMessage.safeParse(message).success).toBe(true);
  }
});

test("rejects unknown types, bad fields and unknown root sources", () => {
  expect(ClientMessage.safeParse({ type: "subscribe" }).success).toBe(false);
  expect(ServerMessage.safeParse({ type: "events", events: [] }).success).toBe(false);
  expect(
    ServerMessage.safeParse({ type: "lines", path: "/a", fileId: "1:2", total: -1 }).success,
  ).toBe(false);
  expect(
    ServerMessage.safeParse({ type: "lines", path: "/a", fileId: "1:2", total: 1.5 }).success,
  ).toBe(false);
  expect(
    ServerMessage.safeParse({ type: "roots", roots: [{ path: "/r", files: 0, source: "cloud" }] })
      .success,
  ).toBe(false);
  expect(
    ClientMessage.safeParse({ type: "hello", token: "t", cursors: [{ path: "/a" }] }).success,
  ).toBe(false);
});

test("the text parsers return undefined for non-JSON and invalid messages", () => {
  expect(parseClientMessage("not json")).toBeUndefined();
  expect(parseClientMessage(JSON.stringify({ type: "heartbeat" }))).toBeUndefined();
  expect(parseClientMessage(JSON.stringify({ type: "hello", token: "t", cursors: [] }))).toEqual({
    type: "hello",
    token: "t",
    cursors: [],
  });
  expect(parseServerMessage(JSON.stringify({ type: "heartbeat" }))).toEqual({ type: "heartbeat" });
  expect(parseServerMessage("{")).toBeUndefined();
});
