import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { skipFrameSpecInCiFirefox } from "./ci-skip.ts";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const READY = "window.__sceneReady === true";

// Every spec except the webgl=0 card one needs a rendered frame.
test.beforeEach(({ browserName }, testInfo) => {
  if (!testInfo.title.startsWith("webgl=0")) skipFrameSpecInCiFirefox(browserName, testInfo);
});

async function open(page: Page, query: string) {
  await page.goto(`/?${query}`);
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
}

const webglState = (page: Page) => page.evaluate("window.__sceneDev.state().webgl");
const frames = (page: Page) =>
  page.evaluate("window.__sceneDev.stats()?.frames ?? 0") as Promise<number>;
// Keeps the extension on window so the spec can restore the context later.
const LOSE_CONTEXT = `(() => {
  const gl = document.querySelector("canvas").getContext("webgl2");
  const ext = gl.getExtension("WEBGL_lose_context");
  window.__ext = ext;
  ext.loseContext();
})()`;
const focusOnBody = (page: Page) => page.evaluate("document.activeElement === document.body");

test("webgl=0 shows the WebGL card; this spec waits on the card, not the ready signal", async ({
  page,
  browserName,
}) => {
  await page.goto("/?webgl=0");
  const card = page.getByTestId("webgl-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("role", "alert");
  await expect(card.getByRole("heading")).toHaveText("Your browser could not start 3D (WebGL).");
  await expect(card.getByRole("button", { name: "Reload" })).toBeVisible();
  if (browserName === "webkit") {
    await expect(card).toContainText("Update your browser and system, then reload.");
  } else {
    await expect(card).toContainText("Turn on hardware acceleration, then reload.");
    await expect(
      card.getByRole("link", { name: "How to turn on hardware acceleration" }),
    ).toHaveAttribute("href", /^https:\/\//);
  }
  expect(await page.evaluate(READY)).toBe(false);
  expect(await focusOnBody(page)).toBe(true);
  await expect(page.locator("canvas")).toHaveCount(0);
});

test("a lost context goes restoring, then ok after restore, and the scene renders again", async ({
  page,
}) => {
  await open(page, "dev=1");
  await page.evaluate(LOSE_CONTEXT);
  await expect.poll(() => webglState(page)).toBe("restoring");
  await expect(page.getByTestId("webgl-lost-card")).toHaveCount(0);
  await page.evaluate("window.__ext.restoreContext()");
  await expect.poll(() => webglState(page)).toBe("ok");
  const after = await frames(page);
  await expect.poll(() => frames(page), { timeout: 15_000 }).toBeGreaterThan(after + 3);
});

test("a context lost with no restore shows the lost card after 10 s; a late restore hides it", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await open(page, "dev=1");
  await page.evaluate(LOSE_CONTEXT);
  await expect.poll(() => webglState(page)).toBe("restoring");
  await expect(page.getByTestId("webgl-lost-card")).toHaveCount(0);
  const card = page.getByTestId("webgl-lost-card");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toHaveAttribute("role", "alert");
  await expect(card.getByRole("heading")).toHaveText("The 3D view lost its graphics connection.");
  await expect(card).toContainText("Reload to restart it.");
  await expect(card.getByRole("link")).toHaveCount(0);
  expect(await webglState(page)).toBe("unavailable");
  expect(await focusOnBody(page)).toBe(true);

  await page.evaluate("window.__ext.restoreContext()");
  await expect(card).toHaveCount(0);
  await expect.poll(() => webglState(page)).toBe("ok");
});

test("a scene component that throws shows the scene-error card, not the WebGL card", async ({
  page,
  browserName,
  context,
}) => {
  if (browserName === "chromium") {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  await open(page, "dev=1");
  await page.evaluate("window.__sceneDev.throwInScene('cube exploded')");
  const card = page.getByTestId("scene-error-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("role", "alert");
  await expect(card.getByRole("heading")).toHaveText("The 3D view stopped after an error.");
  await expect(card).toContainText("The panels still work. Reload to restart the 3D view.");
  await expect(card).toContainText("cube exploded");
  await expect(page.locator("canvas")).toHaveCount(1); // last frame stays under the overlay
  await expect(page.getByTestId("webgl-card")).toHaveCount(0);
  await expect(page.getByTestId("webgl-lost-card")).toHaveCount(0);
  expect(await focusOnBody(page)).toBe(true);

  await card.getByRole("button", { name: "Show error details" }).click();
  await expect(card.getByRole("button", { name: "Hide error details" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await card.getByRole("button", { name: "Copy error details" }).click();
  await expect(card.getByRole("button", { name: "Copied" })).toBeVisible();
  if (browserName === "chromium") {
    const text = (await page.evaluate("navigator.clipboard.readText()")) as string;
    expect(text).toContain("cube exploded");
    expect(text).toContain("[scene]");
    expect(text).toContain(version);
    expect(text).toContain((await page.evaluate("navigator.userAgent")) as string);
  }
});

test("three failing frames keep the loop alive, log once, then show the scene-error card", async ({
  page,
}) => {
  const frameErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error" && msg.text().includes("[scene] frame error")) {
      frameErrors.push(msg.text());
    }
  });
  await open(page, "dev=1");
  await page.evaluate("window.__sceneDev.throwInFrame('frame boom')");
  const card = page.getByTestId("scene-error-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("frame boom");
  await expect(page.getByTestId("webgl-card")).toHaveCount(0);
  expect(frameErrors).toHaveLength(1);
  expect(await page.evaluate("window.__sceneDev.state().sceneError?.message")).toBe("frame boom");
});

const stat = (page: Page, key: "bloom" | "composerGen") =>
  page.evaluate(`window.__sceneDev.stats()?.${key}`);

test("a composer error turns bloom off without a card; a restore rebuilds it; a later error turns it off again", async ({
  page,
}) => {
  await open(page, "dev=1");
  // Healthy intervals keep the quality tier (and bloom) from degrading under CI load.
  await page.evaluate("window.__sceneDev.simulateFrameInterval(16)");
  expect(await stat(page, "bloom")).toBe(true);
  const gen = (await stat(page, "composerGen")) as number;

  // A restore with a healthy composer remounts it under a new key.
  await page.evaluate(LOSE_CONTEXT);
  await expect.poll(() => webglState(page)).toBe("restoring");
  await page.evaluate("window.__ext.restoreContext()");
  await expect.poll(() => webglState(page)).toBe("ok");
  await expect.poll(() => stat(page, "composerGen"), { timeout: 15_000 }).toBeGreaterThan(gen);
  await expect.poll(() => stat(page, "bloom"), { timeout: 15_000 }).toBe(true);

  await page.evaluate("window.__sceneDev.throwInComposer()");
  await expect.poll(() => stat(page, "bloom"), { timeout: 15_000 }).toBe(false);
  for (const id of ["scene-error-card", "webgl-card", "webgl-lost-card"]) {
    await expect(page.getByTestId(id)).toHaveCount(0);
  }
  const afterThrow = await frames(page);
  await expect.poll(() => frames(page), { timeout: 15_000 }).toBeGreaterThan(afterThrow + 3);

  await page.evaluate(LOSE_CONTEXT);
  await expect.poll(() => webglState(page)).toBe("restoring");
  await page.evaluate("window.__ext.restoreContext()");
  await expect.poll(() => webglState(page)).toBe("ok");
  await expect.poll(() => stat(page, "composerGen"), { timeout: 15_000 }).toBeGreaterThan(gen + 1);
  await expect.poll(() => stat(page, "bloom"), { timeout: 15_000 }).toBe(true);
  const afterRestore = await frames(page);
  await expect.poll(() => frames(page), { timeout: 15_000 }).toBeGreaterThan(afterRestore + 3);

  await page.evaluate("window.__sceneDev.throwInComposer()");
  await expect.poll(() => stat(page, "bloom"), { timeout: 15_000 }).toBe(false);
  await expect(page.getByTestId("scene-error-card")).toHaveCount(0);
});
