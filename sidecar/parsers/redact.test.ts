import { describe, expect, test } from "vite-plus/test";
import { redact, redactPath, REDACTED, OUTSIDE } from "./redact.ts";

const hex = (n: number) => "9f8e7d6c5b4a39281706f5e4d3c2b1a0".repeat(4).slice(0, n);

describe("secret patterns (R2, C101)", () => {
  test.each([
    ["an sk- key", "use sk-ant-api03-Zk4Pq9Xw2Lm8Vb7Nc5Hd3Jf1 now"],
    ["a GitHub token", "token ghp_aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6 end"],
    ["a fine-grained GitHub token", "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123 end"],
    ["a Slack token", "xoxb-1234567890-abcdefghij end"],
    ["an AWS key id", "AKIA1234567890ABCDEF end"],
    ["a Google key", "AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q end"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij end"],
  ])("%s becomes [redacted]", (_name, text) => {
    const out = redact(text, "/repo");
    expect(out).toContain(REDACTED);
    expect(out).toMatch(/ end$|^use .* now$/);
  });

  test("a bearer token is redacted and the word before it stays", () => {
    const out = redact("Authorization: Bearer abc123.def456-ghi789 sent", "/repo");
    expect(out).toBe(`Authorization: Bearer ${REDACTED} sent`);
  });

  test("the word after Bearer is kept when it is short", () => {
    expect(redact("a Bearer of bad news", "/repo")).toBe("a Bearer of bad news");
  });

  test("a 32+ char mixed letter-digit string with entropy 4.0 is redacted", () => {
    const secret = "a8Kd93jfL0qZx7Vn2Bm5Tc1Rw4Yp6Hs9";
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(redact(`pass ${secret} done`, "/repo")).toBe(`pass ${REDACTED} done`);
  });

  test("long words without digits, and low-entropy mixed strings, are kept", () => {
    const word = "internationalizationconfigurationmanager";
    expect(redact(word, "/repo")).toBe(word.slice(0, 120));
    const flat = "xy12xy12xy12xy12xy12xy12xy12xy12xy12";
    expect(redact(flat, "/repo")).toBe(flat);
  });

  test("hex of exactly 40 and 64 chars is kept (git SHA lengths)", () => {
    expect(redact(hex(40), "/repo")).toBe(hex(40));
    expect(redact(hex(64), "/repo")).toBe(hex(64));
  });

  test("hex of 32, 48 and 128 chars is redacted; 31 is kept", () => {
    expect(redact(hex(32), "/repo")).toBe(REDACTED);
    expect(redact(hex(48), "/repo")).toBe(REDACTED);
    expect(redact(hex(128), "/repo")).toBe(REDACTED);
    expect(redact(hex(31), "/repo")).toBe(hex(31));
  });

  test("KEY=value splits at = so a value is judged alone", () => {
    expect(redact(`API_KEY=${hex(32)}`, "/repo")).toBe(`API_KEY=${REDACTED}`);
  });
});

describe("linear time on adversarial input (C101)", () => {
  const MiB = 1024 * 1024;
  const shapes: [string, string][] = [
    ["one letter", "a".repeat(MiB)],
    ["letter digit pairs", "a1".repeat(MiB / 2)],
    ["slashes", "/a".repeat(MiB / 2)],
    ["Bearer words", "Bearer ".repeat(MiB / 7)],
    ["equals", "=a".repeat(MiB / 2)],
    ["hex run", "f".repeat(MiB)],
    ["dashes", "sk-".repeat(MiB / 3)],
    ["dots", "a.".repeat(MiB / 2)],
  ];
  test.each(shapes)("1 MiB of %s takes under 50 ms", (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(MiB - 8);
    const start = performance.now();
    const out = redact(text, "/repo");
    const took = performance.now() - start;
    expect(took).toBeLessThan(50);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  test("only the first 4 KiB is examined: a secret after it never appears", () => {
    const out = redact("x ".repeat(3000) + hex(32), "/repo");
    expect(out).not.toContain("9f8e7d6c");
    expect(out.length).toBeLessThanOrEqual(120);
  });
});

describe("the 120 character cut", () => {
  test("output is at most 120 characters, secrets are redacted before the cut", () => {
    const text = "a".repeat(110) + " " + hex(32);
    const out = redact(text, "/repo");
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out).not.toContain("9f8e7d6c");
  });

  test("a cut never leaves half a surrogate pair", () => {
    const out = redact("a".repeat(119) + "😀😀", "/repo");
    expect(out.length).toBe(119);
  });
});

describe("paths (E10, D16)", () => {
  test.each([
    ["/repo/src/a.ts", "src/a.ts"],
    ["/repo", "."],
    ["/repo/", "."],
    ["/repo/src/../lib/b.ts", "lib/b.ts"],
    ["/etc/passwd", OUTSIDE],
    ["/home/user/.ssh/id_rsa", OUTSIDE],
    ["/repository/x", OUTSIDE],
    ["/repo/../other/x", OUTSIDE],
    ["~/notes/todo.md", OUTSIDE],
    ["C:\\Users\\someone\\proj\\a.ts", OUTSIDE],
  ])("%s becomes %s", (path, expected) => {
    expect(redact(path, "/repo")).toBe(expected);
  });

  test("a path inside text is rewritten and its trailing punctuation kept", () => {
    expect(redact("fix /repo/src/a.ts, then /var/log/x.log.", "/repo")).toBe(
      `fix src/a.ts, then ${OUTSIDE}.`,
    );
  });

  test("a single-segment slash word is a command, not a path", () => {
    expect(redact("run /commit now", "/repo")).toBe("run /commit now");
  });

  test("URLs are left to the fixture script, not treated as paths", () => {
    expect(redact("see https://example.com/a/b", "/repo")).toBe("see https://example.com/a/b");
  });

  test("without a root every absolute path is outside", () => {
    expect(redact("/repo/src/a.ts", undefined)).toBe(OUTSIDE);
  });
});

describe("redactPath for filesTouched", () => {
  test.each([
    ["/repo/src/a.ts", "src/a.ts"],
    ["/elsewhere/a.ts", OUTSIDE],
    ["src/a.ts", "src/a.ts"],
    ["../x.ts", OUTSIDE],
    ["/x.ts", OUTSIDE],
  ])("%s becomes %s", (path, expected) => {
    expect(redactPath(path, "/repo")).toBe(expected);
  });

  test("a secret-looking file name is redacted", () => {
    expect(redactPath(`out/${hex(32)}`, "/repo")).toBe(`out/${hex(32)}`.replace(hex(32), REDACTED));
  });
});
