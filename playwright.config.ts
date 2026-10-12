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
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 720 } },
      testIgnore: /repeat\.spec\.ts/,
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 720 } },
      testIgnore: /repeat\.spec\.ts/,
    },
  ],
  webServer: {
    command: `vp build && vp preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: URL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
