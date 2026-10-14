import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { LED, ledPlacements } from "../src/scene/lookdevLayout.ts";
import { LOOKDEV_FRAMING } from "../src/scene/lookdevFraming.ts";

const READY = "window.__sceneReady === true";
const VIEWPORT = { width: 1280, height: 720 };

// Only the lookdev Playwright project runs this (S-RW24): CI renders on ubuntu against a Mac
// baseline, so it is skipped when CI is set and runs in `vp run e2e:local`.
test.skip(!!process.env.CI, "baseline is a Mac Chromium render; runs in vp run e2e:local");

test.beforeEach(async ({ page }) => {
  await page.goto("/?source=mock&scenario=steady&seed=1&freeze=1&view=lookdev");
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
  await page.evaluate("document.fonts.ready");
});

test("the look-dev view matches its committed baseline", async ({ page }) => {
  // Threshold 0: the default 0.2 per-pixel tolerance let colour changes of the concrete, slate,
  // ground and the error LED through. The render is stable (3 of 3 runs identical).
  await expect(page).toHaveScreenshot("lookdev.png", {
    threshold: 0,
    maxDiffPixelRatio: 0.005,
    animations: "disabled",
    caret: "hide",
  });
});

type Rgb = [number, number, number];

// Screen position of a world point in the look-dev framing: the isometric camera looks along
// (-1,-1,-1), so screen right is (1,0,-1)/sqrt2 and screen up is (-1,2,-1)/sqrt6.
function project([x, y, z]: [number, number, number]): [number, number] {
  const [tx, ty, tz] = LOOKDEV_FRAMING.target;
  const d = [x - tx, y - ty, z - tz];
  const right = (d[0] - d[2]) / Math.SQRT2;
  const up = (-d[0] + 2 * d[1] - d[2]) / Math.sqrt(6);
  return [
    Math.round(VIEWPORT.width / 2 + LOOKDEV_FRAMING.zoom * right),
    Math.round(VIEWPORT.height / 2 - LOOKDEV_FRAMING.zoom * up),
  ];
}

const luminance = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("the six status LEDs read as six distinct colours", async ({ page }) => {
  const { data, info } = await sharp(await page.screenshot({ animations: "disabled" }))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const colour = new Map<string, Rgb>();
  for (const { status, at } of ledPlacements()) {
    if (colour.has(status)) continue;
    // The middle of the LED's front face, which faces the camera's +z side.
    const [x, y] = project([at[0], at[1], at[2] + LED.size[2] / 2]);
    const i = (y * info.width + x) * info.channels;
    colour.set(status, [data[i], data[i + 1], data[i + 2]]);
  }
  const statuses = [...colour.keys()];
  expect(statuses).toHaveLength(6);
  // Thresholds are estimated: with the LEDs at 2.4 intensity idle and done were 66 apart but
  // looked like one grey, and thinking came out near white.
  for (const [n, a] of statuses.entries()) {
    for (const b of statuses.slice(n + 1)) {
      expect(distance(colour.get(a)!, colour.get(b)!), `${a} vs ${b}`).toBeGreaterThanOrEqual(30);
    }
  }
  const idle = colour.get("idle")!;
  const done = colour.get("done")!;
  const thinking = colour.get("thinking")!;
  expect(luminance(idle)).toBeGreaterThan(luminance(done) + 20);
  expect(thinking[2] - thinking[0]).toBeGreaterThanOrEqual(20);
});
