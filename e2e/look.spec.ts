import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { skipFrameSpecInCiFirefox } from "./ci-skip.ts";

const READY = "window.__sceneReady === true";

test.beforeEach(({ browserName }, testInfo) => skipFrameSpecInCiFirefox(browserName, testInfo));

async function open(page: Page, query: string) {
  await page.goto(`/?${query}`);
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
}

type Rgb = [number, number, number];

// Points are CSS pixels; the screenshot is in device pixels (WebKit's Desktop Safari is 2x).
async function pixels(page: Page, points: [number, number][]): Promise<Rgb[]> {
  const { data, info } = await sharp(await page.screenshot({ animations: "disabled" }))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scale = info.width / page.viewportSize()!.width;
  return points.map(([x, y]) => {
    const i = (Math.round(y * scale) * info.width + Math.round(x * scale)) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  });
}

const sum = ([r, g, b]: Rgb) => r + g + b;

// The rig the plan names (D14): a hemisphere, the moon and the fill. A missing one
// can leave the pixel thresholds green, so count the lights themselves.
const RIG = { HemisphereLight: 1, DirectionalLight: 1, AmbientLight: 1 };

test("a hall and the ground render with the library under the whole rig", async ({ page }) => {
  await open(page, "dev=1&freeze=1&view=hall");
  expect(await page.evaluate("window.__sceneDev.rigLights()")).toEqual(RIG);
  // The glass panels would blur the frame and the dev menu grew over the lower right (05), so
  // look at the bare 3D area.
  await page.addStyleTag({
    content: "[data-testid^=slot-], [data-testid=perf-hud] { visibility: hidden !important }",
  });
  // Where the hall's front wall top, the ground beside it and far from it, and the front wall's
  // face (the side the moon barely reaches) land in this framing.
  const at = async (point: [number, number, number]): Promise<[number, number]> => {
    const p = (await page.evaluate(`window.__sceneDev.project(${JSON.stringify(point)})`)) as {
      x: number;
      y: number;
    };
    return [p.x, p.y];
  };
  const [top, ground, farGround, leftFace] = await pixels(page, [
    await at([2, 2.1, 2.9]),
    await at([6, 0, 0]),
    await at([-8, 0, -4]),
    await at([1.5, 1.0, 3.01]),
  ]);
  const background = 7 + 10 + 18; // RENDER.background #070a12
  expect(sum(top)).toBeGreaterThan(sum(ground) * 1.5);
  expect(sum(ground)).toBeGreaterThan(background);
  expect(sum(farGround)).toBeGreaterThan(background);
  // The face the moon barely reaches reads 115 here; without the hemisphere and fill it drops to 98.
  expect(sum(leftFace)).toBeGreaterThan(105); // [estimated]
});

test("the look-dev view hides the shell, the HUD, the loader and the toasts", async ({ page }) => {
  // Records an element that ever mounts: the loader fades out, so a check after ready misses it.
  await page.addInitScript(() => {
    const seen = new Set<string>();
    (window as unknown as { __seen: Set<string> }).__seen = seen;
    new MutationObserver(() => {
      for (const id of ["loader", "toast-host"]) {
        if (document.querySelector(`[data-testid=${id}]`)) seen.add(id);
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await open(page, "dev=1&freeze=1&view=lookdev");
  await expect(page.getByTestId("slot-top-bar")).toHaveCount(0);
  await expect(page.getByTestId("perf-hud")).toHaveCount(0);
  await expect(page.getByTestId("loader")).toHaveCount(0);
  await expect(page.getByTestId("toast-host")).toHaveCount(0);
  expect(
    await page.evaluate(() => [...(window as unknown as { __seen: Set<string> }).__seen]),
  ).toEqual([]);
  const stats = await page.evaluate("window.__sceneDev.stats()");
  expect(stats).toMatchObject({ projection: "orthographic", bloom: true });
  expect(await page.evaluate("window.__sceneDev.rigLights()")).toEqual(RIG);
});

test("shared materials receive 0 dispose events when the look-dev view unmounts and remounts", async ({
  page,
}) => {
  await open(page, "dev=1&view=lookdev");
  expect(await page.evaluate("window.__sceneDev.materialDisposeEvents()")).toBe(0);
  // Resolves only after the content has unmounted and mounted again.
  await page.evaluate("window.__sceneDev.remountContent()");
  expect(await page.evaluate("window.__sceneDev.materialDisposeEvents()")).toBe(0);
  const frames = () => page.evaluate("window.__sceneDev.stats().frames") as Promise<number>;
  const before = await frames();
  await expect.poll(frames, { timeout: 10_000 }).toBeGreaterThan(before + 2);
  const stats = (await page.evaluate("window.__sceneDev.stats()")) as { sceneCalls: number };
  expect(stats.sceneCalls).toBeGreaterThan(0);
});

test("the dispose guard watches the real library: disposing one shared material is counted", async ({
  page,
}) => {
  await open(page, "dev=1&view=lookdev");
  await page.evaluate("window.__sceneDev.disposeSharedMaterial()");
  expect(await page.evaluate("window.__sceneDev.materialDisposeEvents()")).toBe(1);
});
