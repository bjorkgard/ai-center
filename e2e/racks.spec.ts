/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { createFakeSignals } from "../src/scene/fake.ts";
import { skipFrameSpecInCiFirefox } from "./ci-skip.ts";

const READY = "window.__sceneReady === true";
const VIEWPORT = { width: 1280, height: 720 };

test.beforeEach(({ browserName }, testInfo) => skipFrameSpecInCiFirefox(browserName, testInfo));

async function open(page: Page, query: string) {
  await page.goto(`/?${query}`);
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
  // The loader fades out after the scene is ready; captures wait for it to go.
  await page.locator("[data-testid=loader]").waitFor({ state: "detached", timeout: 10_000 });
}

const frames = (page: Page) => page.evaluate("window.__sceneDev.stats().frames") as Promise<number>;
const stat = (page: Page, key: "geometries" | "sceneCalls" | "frameErrors") =>
  page.evaluate(`window.__sceneDev.stats().${key}`) as Promise<number>;
// Runs `change`, then waits for a frame drawn after it (a frozen view draws one on demand).
const afterFrame = async (page: Page, change: () => Promise<unknown>) => {
  const before = await frames(page);
  await change();
  await expect.poll(() => frames(page), { timeout: 10_000 }).toBeGreaterThan(before);
};
const setRacks = (page: Page, hall: number, n: number) =>
  afterFrame(page, () => page.evaluate(`window.__sceneDev.setRackCount(${hall}, ${n})`));

async function pixels(page: Page) {
  // WebKit screenshots at 2x; the hooks speak CSS px, so every capture is brought to 1280 x 720.
  const { data, info } = await sharp(await page.screenshot({ animations: "disabled" }))
    .resize(VIEWPORT.width, VIEWPORT.height)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, channels: info.channels };
}

test("the geometry count is unchanged across 0, 16 and 0 racks", async ({ page }) => {
  await open(page, "dev=1&freeze=1&view=racks");
  await setRacks(page, 0, 0);
  const empty = await stat(page, "geometries");
  await setRacks(page, 0, 16);
  expect(await stat(page, "geometries")).toBe(empty);
  await setRacks(page, 0, 0);
  expect(await stat(page, "geometries")).toBe(empty);
  expect(await stat(page, "frameErrors")).toBe(0);
});

test("draw calls do not grow with rack count", async ({ page }) => {
  await open(page, "dev=1&freeze=1&view=racks");
  // Once at 16 so every program is compiled before counting.
  await setRacks(page, 0, 16);
  await setRacks(page, 0, 0);
  const empty = await stat(page, "sceneCalls");
  const calls: number[] = [];
  for (const n of [1, 5, 16]) {
    await setRacks(page, 0, n);
    calls.push(await stat(page, "sceneCalls"));
  }
  // Racks and LEDs are two more draws plus the racks' shadow draw, however many racks stand.
  expect(calls, `calls ${calls.join(",")} empty ${empty}`).toEqual([calls[0], calls[0], calls[0]]);
  expect(calls[0] - empty).toBeLessThanOrEqual(3);
});

test("view=racks draws the 16 racks of the hall and two frozen captures match", async ({
  browser,
}) => {
  const shot = async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await open(page, "freeze=1&seed=1&view=racks");
    const taken = await pixels(page);
    await page.close();
    return taken;
  };
  const a = await shot();
  const b = await shot();
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 3) {
    if (
      Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]) >
      6
    ) {
      differing++;
    }
  }
  expect(differing).toBe(0);
});

// The seeded rack with the most load among the back row's 8: its strip pulses fastest.
const signals = createFakeSignals({ seed: 1, now: () => 0 });
const BUSIEST = Array.from({ length: 8 }, (_, rack) => rack).sort(
  (a, b) => signals.ledLoad(0, b).load - signals.ledLoad(0, a).load,
)[0];

// The green channel of the busiest rack's strip (a tool or thinking status carries green), read
// from the colour buffer the frame loop writes, sampled repeatedly.
async function stripLevels(page: Page, samples: number, gapMs: number) {
  const levels: number[] = [];
  for (let i = 0; i < samples; i++) {
    const rgb = (await page.evaluate(`window.__sceneDev.ledColor(0, ${BUSIEST})`)) as [
      number,
      number,
      number,
    ];
    levels.push(rgb[0] + rgb[1] + rgb[2]);
    await page.waitForTimeout(gapMs);
  }
  return levels;
}

test("LEDs pulse with the seeded fake load", async ({ page }) => {
  await open(page, "dev=1&calm=0&view=racks&seed=1");
  // Samples cover more than one period (1.2-3.0 s); the pulse swings 0.6-1.0 of the colour.
  const levels = await stripLevels(page, 40, 100);
  expect(Math.min(...levels)).toBeGreaterThan(0);
  expect(Math.min(...levels) / Math.max(...levels)).toBeLessThan(0.8);
  expect(Math.min(...levels) / Math.max(...levels)).toBeGreaterThan(0.55);
});

test("under reduced motion the LEDs hold steady", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "dev=1&calm=0&view=racks&seed=1");
  const levels = await stripLevels(page, 15, 100);
  expect(Math.max(...levels)).toBe(Math.min(...levels));
});

test("the Racks dev section starts collapsed after Hall, and its controls drive the racks", async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  await open(page, "dev=1&freeze=1&view=hall");
  const hud = page.getByTestId("perf-hud");
  const header = hud.getByRole("button", { name: /^Racks/ });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  const slider = hud.getByRole("slider", { name: "Rack count" });
  await expect(slider).toHaveValue("0");
  await slider.fill("16");
  await expect(slider).toHaveValue("16");
  const calls = await stat(page, "sceneCalls");
  expect(calls).toBeGreaterThan(0);
  const load = hud.getByRole("button", { name: /^Fake load/ });
  await expect(load).toHaveText("Fake load on");
  await load.click();
  await expect(load).toHaveText("Fake load off");
  await page.evaluate("window.__sceneDev.setFakeLoad(true)");
  await expect(load).toHaveText("Fake load on");
  await page.evaluate("window.__sceneDev.setRackCount(0, 99)");
  await expect(slider).toHaveValue("16");
  expect(warnings.some((w) => w.includes('"n"'))).toBe(true);
  await page.evaluate("window.__sceneDev.setRackCount(0, 0)");
  await expect(slider).toHaveValue("0");
  expect(await stat(page, "frameErrors")).toBe(0);
});
