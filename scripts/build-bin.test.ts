import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  ChecksumMismatch,
  downloadNodeArchive,
  expectedHash,
  extractNode,
  FetchError,
  fetchBytes,
  nodeTarget,
  step,
  ToolFailed,
  type Fetch,
} from "./build-bin.ts";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "build-bin-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const ok = (body: string | Buffer) => ({
  ok: true,
  status: 200,
  arrayBuffer: () => Promise.resolve(new Uint8Array(Buffer.from(body)).buffer),
});
const status = (code: number) => ({
  ok: false,
  status: code,
  arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
});
const sha = (body: string) => createHash("sha256").update(body).digest("hex");

describe("FetchError", () => {
  test("5xx is retried 3 times with 1s, 2s, 4s backoff, then fails naming the URL and error", async () => {
    const fetchFn = vi.fn<Fetch>(() => Promise.resolve(status(503)));
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const promise = fetchBytes("https://nodejs.org/x", fetchFn, sleep);
    await expect(promise).rejects.toThrow(FetchError);
    await expect(promise).rejects.toThrow("https://nodejs.org/x: HTTP 503");
    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
  });

  test("network errors are retried and the last error is reported", async () => {
    const fetchFn = vi.fn<Fetch>(() => Promise.reject(new Error("ECONNRESET")));
    await expect(fetchBytes("https://u", fetchFn, () => Promise.resolve())).rejects.toThrow(
      "ECONNRESET",
    );
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  test("recovers when a retry succeeds", async () => {
    const fetchFn = vi
      .fn<Fetch>()
      .mockResolvedValueOnce(status(502))
      .mockResolvedValueOnce(ok("hi"));
    expect((await fetchBytes("https://u", fetchFn, () => Promise.resolve())).toString()).toBe("hi");
  });

  test("a 404 is not retried", async () => {
    const fetchFn = vi.fn<Fetch>(() => Promise.resolve(status(404)));
    await expect(fetchBytes("https://u", fetchFn, () => Promise.resolve())).rejects.toThrow(
      "HTTP 404",
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("ChecksumMismatch", () => {
  const file = "node-v24.21.0-darwin-arm64.tar.gz";

  test("deletes the archive, does not retry, and prints expected vs actual", async () => {
    const cacheDir = tmp();
    const fetchFn = vi.fn<Fetch>((url) =>
      Promise.resolve(
        url.endsWith("SHASUMS256.txt") ? ok(`${sha("good")}  ${file}\n`) : ok("tampered"),
      ),
    );
    const promise = downloadNodeArchive({
      version: "24.21.0",
      platform: "darwin",
      arch: "arm64",
      cacheDir,
      fetchFn,
      sleep: () => Promise.resolve(),
    });
    await expect(promise).rejects.toThrow(ChecksumMismatch);
    await expect(promise).rejects.toThrow(`expected ${sha("good")}`);
    await expect(promise).rejects.toThrow(`actual   ${sha("tampered")}`);
    expect(existsSync(join(cacheDir, file))).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2); // SHASUMS + archive, no retry
  });

  test("a cached archive with the right hash is reused without downloading it again", async () => {
    const cacheDir = tmp();
    writeFileSync(join(cacheDir, file), "good");
    const fetchFn = vi.fn<Fetch>(() => Promise.resolve(ok(`${sha("good")}  ${file}\n`)));
    const result = await downloadNodeArchive({
      version: "24.21.0",
      platform: "darwin",
      arch: "arm64",
      cacheDir,
      fetchFn,
    });
    expect(result.dirName).toBe("node-v24.21.0-darwin-arm64");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("target naming and SHASUMS parsing", () => {
    expect(nodeTarget("win32", "x64")).toMatchObject({ os: "win", ext: "zip", windows: true });
    expect(nodeTarget("linux", "x64")).toMatchObject({
      os: "linux",
      ext: "tar.gz",
      windows: false,
    });
    expect(expectedHash("abc  a.tar.gz\ndef  b.tar.gz\n", "b.tar.gz")).toBe("def");
    expect(expectedHash("abc  a.tar.gz\n", "c")).toBeUndefined();
  });
});

describe("ToolFailed", () => {
  test("a non-zero exit names the step and carries the tool's stderr", () => {
    const run = vi.fn(() => ({ status: 1, stderr: "postject: bad segment" }));
    expect(() => step("postject", run, "node", ["x"])).toThrow(ToolFailed);
    expect(() => step("postject", run, "node", ["x"])).toThrow(
      /build step "postject" failed[\s\S]*bad segment/,
    );
  });

  test("a missing tool names the step", () => {
    const run = () => ({ status: null, stderr: "", error: new Error("spawn codesign ENOENT") });
    expect(() => step("codesign --sign -", run, "codesign", [])).toThrow(
      /build step "codesign --sign -" failed.*ENOENT/,
    );
  });

  test("a zero exit passes", () => {
    expect(() => step("ok", () => ({ status: 0, stderr: "" }), "true", [])).not.toThrow();
  });
});

describe("extractNode", () => {
  test("removes a previously extracted binary and re-extracts from the verified archive", () => {
    const cacheDir = tmp();
    const member = "node-v1-darwin-arm64/bin/node";
    mkdirSync(join(cacheDir, "node-v1-darwin-arm64/bin"), { recursive: true });
    writeFileSync(join(cacheDir, member), "tampered");
    let existedAtExtract: boolean | undefined;
    const run = vi.fn(() => {
      existedAtExtract = existsSync(join(cacheDir, member));
      return { status: 0, stderr: "" };
    });
    expect(extractNode("a.tar.gz", member, cacheDir, run)).toBe(join(cacheDir, member));
    expect(existedAtExtract).toBe(false);
    expect(run).toHaveBeenCalledWith("tar", ["-xf", "a.tar.gz", "-C", cacheDir, member]);
  });

  test("a failing extract names the step", () => {
    const run = () => ({ status: 2, stderr: "tar: bad archive" });
    expect(() => extractNode("a", "m", tmp(), run)).toThrow(/build step "extract node" failed/);
  });
});
