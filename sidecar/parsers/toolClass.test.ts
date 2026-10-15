import { describe, expect, test } from "vite-plus/test";
import { classifyCommand, classifyTool, toolPaths } from "./toolClass.ts";

describe("edit tools", () => {
  test.each(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"])("%s is edit", (name) => {
    expect(classifyTool(name, {})).toBe("edit");
  });

  test("Read, Grep and unknown tools are other", () => {
    expect(classifyTool("Read", { file_path: "/x" })).toBe("other");
    expect(classifyTool("mcp__thing__do", {})).toBe("other");
  });

  test("Bash classifies its command, and a missing command is other", () => {
    expect(classifyTool("Bash", { command: "git commit -m x" })).toBe("git_commit");
    expect(classifyTool("Bash", {})).toBe("other");
    expect(classifyTool("Bash", { command: 5 })).toBe("other");
  });
});

describe("git_commit", () => {
  test.each([
    "git commit -m 'fix'",
    "git add -A && git commit -m x",
    "git -C /tmp/repo commit --amend",
    "git -c user.name=x commit -m y",
    "cd app; git commit -m y",
    "/usr/bin/git commit -m y",
  ])("%s", (cmd) => {
    expect(classifyCommand(cmd)).toBe("git_commit");
  });

  test.each(["git status", "git log --oneline", "git add . && git push", "git commit-tree abc"])(
    "%s is other",
    (cmd) => expect(classifyCommand(cmd)).toBe("other"),
  );
});

describe("test runners", () => {
  test.each([
    "vp test run",
    "vitest",
    "vitest run src/a.test.ts",
    "jest --ci",
    "pytest -q",
    "go test ./...",
    "cargo test",
    "playwright test",
    "npm test",
    "npm run test",
    "pnpm test",
    "pnpm run test:unit",
    "yarn test",
    "bun test",
    "deno test",
    "make test",
    "just test",
  ])("%s", (cmd) => {
    expect(classifyCommand(cmd)).toBe("test");
  });
});

describe("checkers", () => {
  test.each([
    "vp check",
    "eslint .",
    "tsc --noEmit",
    "ruff check .",
    "biome check",
    "prettier --check .",
  ])("%s", (cmd) => {
    expect(classifyCommand(cmd)).toBe("lint");
  });

  test("prettier without --check is other", () => {
    expect(classifyCommand("prettier --write .")).toBe("other");
  });
});

describe("wrappers and env assignments are stripped", () => {
  test.each([
    ["npx vitest run", "test"],
    ["bunx jest", "test"],
    ["pnpm exec vitest", "test"],
    ["pnpm vitest", "test"],
    ["yarn jest", "test"],
    ["npm run vitest", "test"],
    ["uv run pytest -x", "test"],
    ["poetry run pytest", "test"],
    ["pnpm exec tsc -b", "lint"],
    ["npx eslint src", "lint"],
    ["uv run ruff check", "lint"],
    ["CI=1 vitest", "test"],
    ["FOO=bar BAZ='a b' pytest", "test"],
    ["NODE_ENV=test npx -y vitest", "test"],
    ["./node_modules/.bin/vitest", "test"],
  ])("%s is %s", (cmd, expected) => {
    expect(classifyCommand(cmd)).toBe(expected);
  });
});

describe("splitting on && || ; |", () => {
  test("any segment can carry the class, git_commit over test over lint", () => {
    expect(classifyCommand("cd app && vitest run")).toBe("test");
    expect(classifyCommand("false || vp check")).toBe("lint");
    expect(classifyCommand("vp check && vp test run")).toBe("test");
    expect(classifyCommand("vitest; git commit -m x")).toBe("git_commit");
    expect(classifyCommand("cat log.txt | pytest")).toBe("test");
  });
});

describe("quoted words never match", () => {
  test.each([
    'echo "git commit -m x"',
    "echo 'vitest run'",
    '"vitest" run',
    "'git' commit -m x",
    'grep -r "vp check" docs',
    "echo done; echo 'a && vitest'",
  ])("%s is other", (cmd) => {
    expect(classifyCommand(cmd)).toBe("other");
  });
});

describe("documented v1 limits", () => {
  test("bash -c, $(...) and heredocs are not looked into", () => {
    expect(classifyCommand("bash -c 'vitest run'")).toBe("other");
    expect(classifyCommand("echo $(git commit -m x)")).toBe("other");
  });

  test("a subshell is looked into", () => {
    expect(classifyCommand("(cd app && vitest run)")).toBe("test");
    expect(classifyCommand("(vitest)")).toBe("test");
    expect(classifyCommand("(cd app && vitest)")).toBe("test");
    expect(classifyCommand("(cd app && npm test)")).toBe("test");
    expect(classifyCommand("(cd app && tsc)")).toBe("lint");
    expect(classifyCommand("(cd app && vp check)")).toBe("lint");
    expect(classifyCommand("( cd app && pytest )")).toBe("test");
  });

  test("a heredoc marker may contain a hyphen", () => {
    expect(classifyCommand("cat <<'END-X'\ngit commit -m x\nEND-X")).toBe("other");
  });

  test("a newline separates commands like ;", () => {
    expect(classifyCommand("cd app\nvitest run")).toBe("test");
    expect(classifyCommand("echo hi\ngit commit -m x")).toBe("git_commit");
    expect(classifyCommand('echo "a\nvitest"')).toBe("other");
  });

  test("heredoc bodies are not commands", () => {
    expect(classifyCommand("cat <<'EOF'\ngit commit -m x\nEOF")).toBe("other");
    expect(classifyCommand('cat <<"EOF"\nvitest\nEOF')).toBe("other");
    expect(classifyCommand("cat <<EOF > a.sh\nvitest\nEOF")).toBe("other");
    expect(classifyCommand("cat <<-EOF\n\tvitest\n\tEOF")).toBe("other");
    expect(classifyCommand("cat <<'EOF'\nvitest\nEOF\nvitest run")).toBe("test");
  });

  test("a commit with a heredoc message is a commit, whatever the message says", () => {
    const cmd = `git commit -m "$(cat <<'EOF'\nfix: thing\n\nvp test passes\nEOF\n)"`;
    expect(classifyCommand(cmd)).toBe("git_commit");
    expect(classifyCommand(`git add . && ${cmd}`)).toBe("git_commit");
    expect(classifyCommand("echo hi\ncat <<'EOF'\nvp check\nEOF")).toBe("other");
  });

  test("a heredoc with no terminator drops the rest", () => {
    expect(classifyCommand("cat <<'EOF'\ngit commit -m x\nvitest")).toBe("other");
  });

  test("a here-string is not a heredoc", () => {
    expect(classifyCommand("cat <<< x\nvitest")).toBe("test");
  });
});

describe("toolPaths", () => {
  test("file_path, notebook_path and apply_patch headers feed filesTouched", () => {
    expect(toolPaths("Edit", { file_path: "/repo/a.ts", old_string: "x" })).toEqual(["/repo/a.ts"]);
    expect(toolPaths("Write", { file_path: "/repo/b.ts", content: "SECRET BODY" })).toEqual([
      "/repo/b.ts",
    ]);
    expect(toolPaths("MultiEdit", { file_path: "/repo/c.ts", edits: [] })).toEqual(["/repo/c.ts"]);
    expect(toolPaths("NotebookEdit", { notebook_path: "/repo/n.ipynb" })).toEqual([
      "/repo/n.ipynb",
    ]);
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ body that must not leave",
      "-old",
      "+new",
      "*** Add File: src/new.ts",
      "+content",
      "*** Delete File: src/old.ts",
      "*** Move to: src/moved.ts",
      "*** End Patch",
    ].join("\n");
    expect(toolPaths("apply_patch", patch)).toEqual([
      "src/a.ts",
      "src/new.ts",
      "src/old.ts",
      "src/moved.ts",
    ]);
    expect(toolPaths("apply_patch", { input: patch })).toEqual([
      "src/a.ts",
      "src/new.ts",
      "src/old.ts",
      "src/moved.ts",
    ]);
  });

  test("tools without a path, and bad input, give nothing", () => {
    expect(toolPaths("Bash", { command: "ls" })).toEqual([]);
    expect(toolPaths("Edit", null)).toEqual([]);
    expect(toolPaths("Edit", { file_path: 4 })).toEqual([]);
    expect(toolPaths("Read", { file_path: "/repo/a.ts" })).toEqual([]);
  });
});
