/// <reference types="node" />
import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";

test("tokens define the brand cyan and the six status colours", () => {
  const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
  expect(css).toContain("--color-cyan: #22d3ee;");
  for (const status of ["idle", "thinking", "tool", "waiting-user", "error", "done"]) {
    expect(css).toContain(`--color-status-${status}:`);
    expect(css).toContain(`--status-shape-${status}:`);
  }
});
