import { expect, test } from "@playwright/test";

const READY = "window.__sceneReady === true";

// Only the lookdev Playwright project runs this (CEO C28, S-RW24): CI renders on ubuntu against a
// Mac baseline, so it is skipped when CI is set and runs in `vp run e2e:local`. Every PR that
// changes the campus look regenerates the baseline in the same PR.
test.skip(!!process.env.CI, "baseline is a Mac Chromium render; runs in vp run e2e:local");

test.beforeEach(async ({ page }) => {
  await page.goto("/?source=mock&scenario=steady&seed=1&freeze=1&view=home");
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
  await page.evaluate("document.fonts.ready");
  // The loader fades out after the scene is ready; the capture waits for it to go.
  await page.locator("[data-testid=loader]").waitFor({ state: "detached", timeout: 10_000 });
});

test("the frozen campus home view matches its committed baseline", async ({ page }) => {
  await expect(page).toHaveScreenshot("campus-home.png", {
    maxDiffPixelRatio: 0.005,
    animations: "disabled",
    caret: "hide",
  });
});
