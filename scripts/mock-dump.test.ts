import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vite-plus/test";
import { mockEvents } from "../src/data/mock.ts";

const dir = mkdtempSync(join(tmpdir(), "mock-dump-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const run = (...args: string[]) =>
  spawnSync(process.execPath, ["scripts/mock-dump.ts", ...args], { encoding: "utf8" });

test("the dump for a seed equals the generator's events after JSON.parse of each line", () => {
  const out = join(dir, "a.jsonl");
  const res = run("--seed", "4", "--scenario", "steady", "--minutes", "3", "--out", out);
  expect(res.status).toBe(0);
  const lines = readFileSync(out, "utf8").trimEnd().split("\n");
  expect(lines.map((l) => JSON.parse(l))).toEqual(mockEvents(4, "steady", 0, 3 * 60_000));
});

test.each([
  [["--seed", "x", "--scenario", "steady", "--minutes", "1", "--out", "o"], "--seed"],
  [["--scenario", "steady", "--minutes", "1", "--out", "o"], "--seed"],
  [["--seed", "1", "--scenario", "burst", "--minutes", "1", "--out", "o"], "scenario"],
  [["--seed", "1", "--scenario", "steady", "--minutes", "0", "--out", "o"], "--minutes"],
  [["--seed", "1", "--scenario", "steady", "--minutes", "1.5", "--out", "o"], "--minutes"],
  [
    ["--seed", "1", "--scenario", "steady", "--minutes", "99999999999999999999", "--out", "o"],
    "--minutes",
  ],
  [["--seed", "1", "--scenario", "steady", "--minutes", "1441", "--out", "o"], "1440"],
  [["--seed", "1", "--scenario", "steady", "--minutes", "1"], "--out"],
  [
    ["--seed", "1", "--scenario", "steady", "--minutes", "1", "--out", "/nonexistent-dir/x"],
    "--out",
  ],
  [["--bogus"], "--bogus"],
])("a bad flag %j exits non-zero naming the problem", (args, word) => {
  const res = run(...args);
  expect(res.status).not.toBe(0);
  expect(res.stderr).toContain(word);
});
