import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkWorkflow } from "./check-workflows.ts";

function fixture(name: string) {
  const path = new URL(`./fixtures/workflows/${name}`, import.meta.url);
  return checkWorkflow(name, readFileSync(path, "utf8"));
}

describe("checkWorkflow", () => {
  test("passes a valid workflow with a SHA-pinned and a local action", () => {
    expect(fixture("valid.yml")).toEqual([]);
  });

  test("fails a uses: that points at a tag", () => {
    const problems = fixture("tag-ref.yml");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("actions/checkout@v4");
  });

  test("fails a flow-style uses: that points at a tag", () => {
    const problems = fixture("flow-style.yml");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("actions/checkout@v4");
  });

  test("fails a workflow without a top-level permissions key", () => {
    const problems = fixture("no-permissions.yml");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("permissions");
  });
});
