import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

// CEO S-RW30: runs only for the firefox project and only with CI set (playwright.config.ts).
test("CI Firefox: page loads and shows either the scene or the WebGL card", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/");
  const ready = page.waitForFunction("window.__sceneReady === true", undefined, {
    timeout: 30_000,
  });
  const card = page.getByRole("alert").filter({ hasText: "could not start 3D" });
  const cardShown = card.waitFor({ state: "visible", timeout: 30_000 });
  const branch = await Promise.any([ready.then(() => "scene"), cardShown.then(() => "card")]);
  ready.catch(() => {});
  cardShown.catch(() => {});
  testInfo.annotations.push({ type: "firefox-ci-branch", description: branch });
  console.log(`CI Firefox smoke branch: ${branch}`);

  await expect(page).toHaveTitle("Synapse Horizon");
  await expect(page.locator('meta[name="app-version"]')).toHaveAttribute("content", version);
  expect(errors).toEqual([]);
});
