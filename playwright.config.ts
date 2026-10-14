import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const URL = `http://127.0.0.1:${PORT}`;

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
      testIgnore: /ci-firefox\.spec\.ts|lookdev\.spec\.ts|campus\.spec\.ts/,
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
        ? /repeat\.spec\.ts|lookdev\.spec\.ts|campus\.spec\.ts/
        : /repeat\.spec\.ts|ci-firefox\.spec\.ts|lookdev\.spec\.ts|campus\.spec\.ts/,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 720 } },
      testIgnore: /repeat\.spec\.ts|ci-firefox\.spec\.ts|lookdev\.spec\.ts|campus\.spec\.ts/,
    },
    {
      // The committed look-dev and campus baselines (CEO C17, C28): Chromium only, their own
      // snapshot folder because test-results/ is gitignored.
      name: "lookdev",
      testMatch: /lookdev\.spec\.ts|campus\.spec\.ts/,
      snapshotPathTemplate: "e2e/__screenshots__/{testFileName}/{arg}{ext}",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    command: `vp build && vp preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: URL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
