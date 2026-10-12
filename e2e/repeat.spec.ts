import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";

// Repeat-run check (eng T2): two captures of the same frozen view must agree.
test("same view captured twice stays within 0.5% pixel diff", async ({ page }, testInfo) => {
  const url = "/?source=mock&scenario=steady&seed=1&freeze=1&view=home";

  await page.goto(url);
  await page.evaluate("document.fonts.ready");
  const first = await page.screenshot({ animations: "disabled", caret: "hide" });
  const baseline = testInfo.snapshotPath("home.png");
  mkdirSync(dirname(baseline), { recursive: true });
  writeFileSync(baseline, first);

  await page.reload();
  await page.evaluate("document.fonts.ready");
  await expect(page).toHaveScreenshot("home.png", { maxDiffPixelRatio: 0.005 });
});
