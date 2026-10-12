import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

test("page loads with no console errors and the right version", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto("/");

  await expect(page).toHaveTitle("Synapse Horizon");
  await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.locator('meta[name="app-version"]')).toHaveAttribute("content", version);
  expect(errors).toEqual([]);
});
