import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";

// The log server watches the default roots (the real home) unless told otherwise, so every
// harness that starts `vp preview` must pass SYNAPSE_LOG_ROOTS=none.
test.each([["playwright.config.ts"], ["scripts/shots.ts"]])(
  "%s starts vp preview with SYNAPSE_LOG_ROOTS=none",
  (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/SYNAPSE_LOG_ROOTS:\s*"none"/);
  },
);
