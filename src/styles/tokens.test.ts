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

test("tokens define the motion durations, the one easing and the secondary text colour", () => {
  const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
  expect(css).toContain("--dur-fast: 150ms;");
  expect(css).toContain("--dur-ui: 250ms;");
  expect(css).toContain("--dur-scene: 600ms;");
  expect(css).toContain("--ease: cubic-bezier(0.22, 1, 0.36, 1);");
  expect(css).toContain("--color-text-2: #a3acbd;");
  expect(css).toContain("--color-text-3: #8a93a6;");
});

test("tokens define the glass tint at 8% white and its border at 12% white", () => {
  const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
  expect(css).toContain("--color-glass: rgb(255 255 255 / 0.08);");
  expect(css).toContain("--color-glass-border: rgb(255 255 255 / 0.12);");
});
