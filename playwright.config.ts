import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const URL = `http://127.0.0.1:${PORT}`;
// The logserver project's own preview, watching only this directory (never a real home).
const LOG_PORT = 4174;
const LOG_URL = `http://127.0.0.1:${LOG_PORT}`;
const LOG_ROOT = resolve("e2e/.tmp/logs");

// The webServer builds and previews the production bundle, so the smoke specs
// run against the same page users get (including the injected version meta).
export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "test-results/snapshots/{testFileName}/{projectName}-{arg}{ext}",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: URL,
    viewport: { width: 1280, height: 720 },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
      testIgnore: /ci-firefox\.spec\.ts|lookdev\.spec\.ts|campus\.spec\.ts|logserver\.spec\.ts/,
    },
    {
      name: "firefox",
      use: {
        ...devices["Desktop Firefox"],
        viewport: { width: 1280, height: 720 },
        // Headless Firefox on GPU-less CI runners blocks software WebGL by default
        // (CEO S-RW30); force it on so the scene can draw.
        launchOptions: { firefoxUserPrefs: { "webgl.force-enabled": true } },
      },
      // The CI-only smoke (S-RW30) asserts the card-or-scene path; locally the full
      // specs run, and repeat.spec.ts never runs on Firefox.
      testIgnore: process.env.CI
        ? /repeat\.spec\.ts|lookdev\.spec\.ts|campus\.spec\.ts|logserver\.spec\.ts/
        : /repeat\.spec\.ts|ci-firefox\.spec\.ts|lookdev\.spec\.ts|campus\.spec\.ts|logserver\.spec\.ts/,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 720 } },
      testIgnore:
        /repeat\.spec\.ts|ci-firefox\.spec\.ts|lookdev\.spec\.ts|campus\.spec\.ts|logserver\.spec\.ts/,
    },
    {
      // The committed look-dev and campus baselines (CEO C17, C28): Chromium only, their own
      // snapshot folder because test-results/ is gitignored.
      name: "lookdev",
      testMatch: /lookdev\.spec\.ts|campus\.spec\.ts/,
      snapshotPathTemplate: "e2e/__screenshots__/{testFileName}/{arg}{ext}",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
    {
      // The live source against a real log server (PLAN chunk 14c, C70). The specs share one
      // server and one directory, so they run in order on one worker.
      name: "logserver",
      testMatch: /logserver\.spec\.ts/,
      fullyParallel: false,
      workers: 1,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 720 },
        baseURL: LOG_URL,
      },
    },
  ],
  webServer: [
    {
      command: `vp build && vp preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      url: URL,
      // The log server must not watch the real home directory.
      env: { SYNAPSE_LOG_ROOTS: "none" },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // Starts once the first server has built dist/, then previews it on its own port.
      command: `node e2e/helpers/logserver.ts ${URL} ${LOG_PORT}`,
      url: LOG_URL,
      env: { SYNAPSE_LOG_ROOTS: LOG_ROOT },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
