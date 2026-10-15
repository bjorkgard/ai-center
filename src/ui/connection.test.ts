import { expect, test } from "vite-plus/test";
import { SESSION_EXPIRED, WIRE_MISMATCH } from "../data/liveSource.ts";
import type { SourceStatus } from "../data/schema.ts";
import type { RootInfoMessage } from "../data/wire.ts";
import {
  RECONNECT_BANNER_MS,
  bannerShown,
  bannerReload,
  bannerText,
  demoUrl,
  firstRun,
  pillView,
  rootLabel,
} from "./connection.ts";

const root = (over: Partial<RootInfoMessage> = {}): RootInfoMessage => ({
  path: "/home/u/.claude/projects",
  files: 2,
  source: "default",
  ...over,
});

test.each<[SourceStatus, string]>([
  ["connecting", "Connecting"],
  ["live", "Connected"],
  ["reconnecting", "Reconnecting"],
  ["closed", "Off"],
  ["error", "Off"],
])("the pill reads %s as %s", (status, text) => {
  expect(pillView({ name: "live", status }, null, [root()])?.text).toBe(text);
});

test("catching up shows the server's n/N files", () => {
  expect(
    pillView({ name: "live", status: "catching_up" }, { done: 120, total: 480 }, [root()])?.text,
  ).toBe("Catching up 120/480 files");
  expect(pillView({ name: "live", status: "catching_up" }, null, null)?.text).toBe(
    "Catching up 0/0 files",
  );
});

test("an error puts its reason in the tooltip", () => {
  expect(pillView({ name: "live", status: "error", detail: SESSION_EXPIRED }, null, null)).toEqual({
    text: "Off",
    title: SESSION_EXPIRED,
  });
});

test("no pill without a live source", () => {
  expect(pillView({ name: null, status: "idle" }, null, null)).toBeNull();
  expect(pillView({ name: "mock", status: "live" }, null, null)).toBeNull();
});

test("a root reason shows in the pill; no roots at all (--no-logs) reads Off", () => {
  const missing = root({ path: "/nope", files: 0, reason: "root not found: /nope" });
  expect(pillView({ name: "live", status: "live" }, null, [root(), missing])).toEqual({
    text: "Connected",
    reason: "root not found: /nope",
    title: "root not found: /nope",
  });
  expect(pillView({ name: "live", status: "live" }, null, [])?.text).toBe("Off");
});

test.each([
  ["dev", "Log server not running. Start it with vp dev."],
  ["binary", "Synapse Horizon stopped. Run it again to reconnect."],
  ["preview", "Log server not running. Start it with vp run serve."],
])("the %s banner text", (mode, text) => {
  expect(bannerText(mode, "reconnecting")).toBe(text);
});

test("an unknown or missing mode falls back to the dev text", () => {
  expect(bannerText(null, "reconnecting")).toBe(bannerText("dev", "reconnecting"));
});

test("only a second token rejection says Session expired and offers Reload", () => {
  expect(bannerText("preview", "error", SESSION_EXPIRED)).toBe("Session expired. Reload the page.");
  expect(bannerReload("error", SESSION_EXPIRED)).toBe(true);
});

test("a wire mismatch states problem, cause and fix, with Reload", () => {
  const text = bannerText("dev", "error", WIRE_MISMATCH);
  expect(text).toContain("could not understand");
  expect(text).toContain("versions differ");
  expect(text).toContain("restart the server");
  expect(bannerReload("error", WIRE_MISMATCH)).toBe(true);
});

test("a config-file error names the problem, the file and the README, with no Reload", () => {
  const detail = "invalid config file: roots must be an array (/home/u/.config/c.json)";
  const text = bannerText("dev", "error", detail);
  expect(text).toContain(detail);
  expect(text).toContain("README #configuration");
  expect(text).not.toContain("Session expired");
  expect(bannerReload("error", detail)).toBe(false);
  expect(bannerReload("reconnecting")).toBe(false);
});

test("the banner shows on a failed first connection at once and on later loss after 3 s", () => {
  expect(RECONNECT_BANNER_MS).toBe(3000);
  expect(bannerShown("reconnecting", false, 0)).toBe(true);
  expect(bannerShown("reconnecting", true, 2999)).toBe(false);
  expect(bannerShown("reconnecting", true, 3000)).toBe(true);
  expect(bannerShown("live", true, 9000)).toBe(false);
  expect(bannerShown("catching_up", true, 9000)).toBe(false);
  expect(bannerShown("connecting", false, 9000)).toBe(false);
  expect(bannerShown("error", true, 0)).toBe(true);
});

test("the first-run card needs a finished backfill with files in no root", () => {
  const live = { name: "live", status: "live" } as const;
  const empty = [root({ files: 0 }), root({ path: "/c", files: 0, source: "env" })];
  expect(firstRun(live, { done: 0, total: 0 }, empty)).toBe(true);
  expect(firstRun(live, null, empty)).toBe(true);
  expect(firstRun(live, { done: 0, total: 0 }, [root({ files: 0 }), root()])).toBe(false);
  expect(firstRun(live, { done: 0, total: 0 }, [])).toBe(false);
  expect(firstRun(live, { done: 0, total: 0 }, null)).toBe(false);
  expect(firstRun({ name: "live", status: "catching_up" }, { done: 1, total: 2 }, empty)).toBe(
    false,
  );
  expect(firstRun({ name: "live", status: "reconnecting" }, null, empty)).toBe(false);
  expect(firstRun({ name: "mock", status: "live" }, null, empty)).toBe(false);
});

test("roots are named with the source that supplied them", () => {
  expect(rootLabel(root())).toBe("/home/u/.claude/projects (default)");
  expect(rootLabel(root({ path: "/x", source: "flag" }))).toBe("/x (--log-root)");
  expect(rootLabel(root({ path: "/x", source: "env" }))).toBe("/x (SYNAPSE_LOG_ROOTS)");
  expect(rootLabel(root({ path: "/x", source: "config" }))).toBe("/x (config file)");
});

test("Try the demo keeps the other parameters and switches to the steady mock", () => {
  expect(demoUrl("")).toBe("?source=mock&scenario=steady");
  expect(demoUrl("?dev=1&source=live&scenario=burst")).toBe("?dev=1&source=mock&scenario=steady");
});
