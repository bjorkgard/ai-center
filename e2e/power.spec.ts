/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { skipFrameSpecInCiFirefox } from "./ci-skip.ts";

const READY = "window.__sceneReady === true";
const VIEWPORT = { width: 1280, height: 720 };

test.beforeEach(({ browserName }, testInfo) => skipFrameSpecInCiFirefox(browserName, testInfo));

async function open(page: Page, query = "dev=1&freeze=1&view=power") {
  await page.goto(`/?${query}`);
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
  // The loader fades out after the scene is ready; captures wait for it to go.
  await page.locator("[data-testid=loader]").waitFor({ state: "detached", timeout: 10_000 });
}

interface Stats {
  frames: number;
  sceneCalls: number;
  geometries: number;
  textures: number;
  frameErrors: number;
}
const stats = (page: Page) => page.evaluate("window.__sceneDev.stats()") as Promise<Stats>;
const lines = (page: Page) =>
  page.evaluate("window.__sceneDev.fibreLines()") as Promise<number | null>;

// Runs `change`, then waits for a frame drawn after it and for the frames to go quiet.
async function afterFrame(page: Page, change: () => Promise<unknown>) {
  const before = (await stats(page)).frames;
  await change();
  await expect
    .poll(async () => (await stats(page)).frames, { timeout: 10_000 })
    .toBeGreaterThan(before);
  await expect
    .poll(
      async () => {
        const a = (await stats(page)).frames;
        await page.waitForTimeout(300);
        return (await stats(page)).frames === a;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

async function pixels(page: Page) {
  // WebKit screenshots at 2x; every capture is brought to 1280 x 720.
  const { data } = await sharp(await page.screenshot({ animations: "disabled" }))
    .resize(VIEWPORT.width, VIEWPORT.height)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function differing(a: Buffer, b: Buffer): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum;
}

test("two frozen view=power captures match", async ({ page }) => {
  await open(page, "freeze=1&view=power");
  const a = await pixels(page);
  await page.reload();
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
  await page.locator("[data-testid=loader]").waitFor({ state: "detached", timeout: 10_000 });
  const b = await pixels(page);
  expect(differing(a, b)).toBe(0);
});

test("all the parts render: the power view shows cyan fibre and packets, and draws no frame errors", async ({
  page,
}) => {
  await open(page);
  const s = await stats(page);
  expect(s.frameErrors).toBe(0);
  // Two lines at the first view: A and B.
  expect(await lines(page)).toBe(2);
  // Cyan glow (blue and green well above red) shows where the fibre and the packets are.
  const px = await pixels(page);
  let cyan = 0;
  let lit = 0;
  for (let i = 0; i < px.length; i += 3) {
    if (px[i + 2] > 120 && px[i + 1] > 120 && px[i] < px[i + 1] - 30) cyan++;
    if (px[i] + px[i + 1] + px[i + 2] > 60) lit++;
  }
  expect(cyan).toBeGreaterThan(30);
  // The yard, tanks, generators and vault fill the middle of the frame.
  expect(lit).toBeGreaterThan(VIEWPORT.width * VIEWPORT.height * 0.3);
});

test("removing a hall slot removes its fibre line, and the geometry and texture counts return", async ({
  page,
}) => {
  await open(page, "dev=1&freeze=1&view=home");
  await afterFrame(page, () => page.evaluate("window.__sceneDev.setPlacedHalls(4)"));
  await expect.poll(() => lines(page)).toBe(4);
  const four = await stats(page);
  await afterFrame(page, () => page.evaluate("window.__sceneDev.setPlacedHalls(6)"));
  await expect.poll(() => lines(page)).toBe(6);
  // Placing halls adds what they draw.
  expect((await stats(page)).geometries).toBeGreaterThanOrEqual(four.geometries);
  await afterFrame(page, () => page.evaluate("window.__sceneDev.setPlacedHalls(4)"));
  await expect.poll(() => lines(page)).toBe(4);
  const back = await stats(page);
  expect(back.geometries).toBe(four.geometries);
  expect(back.textures).toBe(four.textures);
  expect(back.frameErrors).toBe(0);
});

test("the Network section is collapsed and last, and its slider and hook drive the packet rate", async ({
  page,
}) => {
  const warnings: string[] = [];
  const logged: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
    if (msg.text().startsWith("[scene]")) logged.push(msg.text());
  });
  await open(page);
  const hud = page.getByTestId("perf-hud");
  const sections = await hud
    .locator("section")
    .evaluateAll((all) => all.map((s) => (s as HTMLElement).dataset.testid));
  expect(sections.at(-1)).toBe("dev-network");
  const header = hud.getByRole("button", { name: /^Network/ });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  const slider = hud.getByRole("slider", { name: "Packet rate" });
  await expect(slider).toHaveValue("1");
  await afterFrame(page, () => slider.fill("4"));
  await expect(slider).toHaveValue("4");
  expect(logged.some((l) => l.includes("packet rate") && l.includes("4"))).toBe(true);
  // Out of range input clamps and warns, naming the argument; text keeps the value and warns.
  await afterFrame(page, () => page.evaluate("window.__sceneDev.setPacketRate(99)"));
  await expect(slider).toHaveValue("10");
  expect(warnings.some((w) => w.includes('"perSecond"'))).toBe(true);
  warnings.length = 0;
  await page.evaluate("window.__sceneDev.setPacketRate('fast')");
  await expect(slider).toHaveValue("10");
  expect(warnings.some((w) => w.includes('"perSecond"'))).toBe(true);
});

test("packets show more at a higher rate and none at rate 0, with the same draw calls", async ({
  page,
}) => {
  await open(page);
  await afterFrame(page, () => page.evaluate("window.__sceneDev.setPacketRate(10)"));
  const full = await pixels(page);
  const calls = (await stats(page)).sceneCalls;
  await afterFrame(page, () => page.evaluate("window.__sceneDev.setPacketRate(0)"));
  const none = await pixels(page);
  expect(differing(full, none)).toBeGreaterThan(2_000);
  expect((await stats(page)).sceneCalls).toBe(calls);
});

const speed = (page: Page) =>
  page.evaluate("window.__sceneDev.packetSpeed()") as Promise<number | null>;

test("packets move at 2.5 units a second, and at 25% of that (0.625) with reduced motion", async ({
  page,
}) => {
  // Not frozen: packets only move while scene time passes.
  await open(page, "dev=1&view=power");
  await expect.poll(() => speed(page), { timeout: 15_000 }).toBeCloseTo(2.5, 1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate("window.__sceneDev.state().reducedMotion")).toBe(true);
  await expect.poll(() => speed(page), { timeout: 15_000 }).toBeCloseTo(0.625, 1);
  expect((await stats(page)).frameErrors).toBe(0);
});

test("in view=power Home frames the halls placed now, not the ones placed at load", async ({
  page,
}) => {
  await open(page, "dev=1&view=power");
  const zoom = async () => {
    await page.getByRole("application", { name: "3D campus view" }).focus();
    await page.keyboard.press("0");
    await expect
      .poll(async () => (await page.evaluate("window.__sceneDev.camera().animating")) as boolean)
      .toBe(false);
    return ((await page.evaluate("window.__sceneDev.camera()")) as { zoom: number }).zoom;
  };
  const before = await zoom();
  await page.evaluate("window.__sceneDev.setPlacedHalls(12)");
  expect(await zoom()).toBeLessThan(before);
});
