import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { parse } from "yaml";

type Job = {
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: { id?: string; uses?: string; with?: Record<string, unknown> }[];
};
type Workflow = {
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  jobs: Record<string, Job>;
};

const text = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const workflow = parse(text) as Workflow;
const { verify, release } = workflow.jobs;

describe("release.yml", () => {
  test("release waits for verify", () => {
    expect([release.needs].flat()).toEqual(["verify"]);
  });

  test("no continue-on-error anywhere", () => {
    expect(text).not.toContain("continue-on-error");
  });

  test("permissions: {} at the top, and least privilege per job", () => {
    expect(workflow.permissions).toEqual({});
    expect(verify.permissions).toEqual({ contents: "read" });
    expect(release.permissions).toEqual({
      contents: "write",
      issues: "write",
      "pull-requests": "write",
    });
  });

  test("releases queue behind each other and are never cancelled", () => {
    expect(workflow.concurrency).toEqual({
      group: "release",
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  test("the release checkout fetches full history", () => {
    const checkout = release.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  test("published and version outputs come from the release step", () => {
    expect(release.steps.some((s) => s.id === "release")).toBe(true);
    expect(release.outputs).toEqual({
      published: "${{ steps.release.outputs.published }}",
      version: "${{ steps.release.outputs.version }}",
    });
  });
});
