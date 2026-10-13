import { expect, test, type Page } from "@playwright/test";

const READY = "window.__sceneReady === true";

async function open(page: Page, query: string) {
  await page.goto(`/?${query}`);
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
}

const stats = (page: Page) =>
  page.evaluate("window.__sceneDev.stats()") as Promise<{
    frames: number;
    sceneCalls: number;
    postCalls: number;
    capFps: number;
    mode: string;
    projection: string;
    bloom: boolean;
  } | null>;

test("the test cube draws in under 10 scene draw calls, post-processing counted apart", async ({
  page,
}) => {
  await open(page, "dev=1&freeze=1");
  const s = await stats(page);
  expect(s).not.toBeNull();
  expect(s!.sceneCalls).toBeGreaterThan(0);
  expect(s!.sceneCalls).toBeLessThan(10);
  expect(s!.bloom).toBe(true);
  expect(s!.postCalls).toBeGreaterThan(0);
  const hud = page.getByTestId("perf-hud");
  await expect(hud).toBeVisible();
  await expect(hud.locator('[data-hud="fps"]')).toHaveText("frozen");
  await expect(hud.locator('[data-hud="scene calls"]')).toHaveText(String(s!.sceneCalls));
  await expect(hud.locator('[data-hud="post calls"]')).toHaveText(String(s!.postCalls));
});

test("the HUD and the dev hooks exist only with dev=1", async ({ page }) => {
  await open(page, "freeze=1");
  await expect(page.getByTestId("perf-hud")).toHaveCount(0);
  expect(await page.evaluate("window.__sceneDev === undefined")).toBe(true);
});

test("the HUD button toggles ortho and perspective and the loop keeps drawing", async ({
  page,
}) => {
  await open(page, "dev=1");
  expect((await stats(page))!.projection).toBe("orthographic");
  await page.getByRole("button", { name: "Switch to perspective" }).click();
  await expect.poll(async () => (await stats(page))?.projection).toBe("perspective");
  const before = (await stats(page))!.frames;
  await expect
    .poll(async () => (await stats(page))!.frames, { timeout: 10_000 })
    .toBeGreaterThan(before + 2);
  await page.getByRole("button", { name: "Switch to orthographic" }).click();
  await expect.poll(async () => (await stats(page))?.projection).toBe("orthographic");
});

test("calm mode renders at most 31 frames per second after 5 s idle", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the 31 fps bar is proven in Chromium (C16)");
  await open(page, "dev=1");
  await page.waitForTimeout(5500);
  const a = await stats(page);
  await page.waitForTimeout(3000);
  const b = await stats(page);
  expect(b!.mode).toBe("calm");
  expect(b!.capFps).toBe(30);
  const perSecond = (b!.frames - a!.frames) / 3;
  expect(perSecond).toBeLessThanOrEqual(31);
});

test("the reducedMotion flag follows the emulated media setting live", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "dev=1&freeze=1");
  expect(await page.evaluate("window.__sceneDev.state().reducedMotion")).toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => page.evaluate("window.__sceneDev.state().reducedMotion")).toBe(false);
});
