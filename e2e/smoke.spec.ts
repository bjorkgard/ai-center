import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

test("page loads with a canvas, no console errors and the right version", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/");
  await page.waitForFunction("window.__sceneReady === true", undefined, { timeout: 30_000 });

  await expect(page).toHaveTitle("Synapse Horizon");
  await expect(page.locator("canvas")).toHaveCount(1);
  await expect(page.locator("[data-scene-ready]")).toHaveCount(1);
  await expect(page.locator('meta[name="app-version"]')).toHaveAttribute("content", version);
  expect(errors).toEqual([]);
});
