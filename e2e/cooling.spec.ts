/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { skipFrameSpecInCiFirefox } from "./ci-skip.ts";

const READY = "window.__sceneReady === true";
const VIEWPORT = { width: 1280, height: 720 };

test.beforeEach(({ browserName }, testInfo) => skipFrameSpecInCiFirefox(browserName, testInfo));

async function open(page: Page, query = "dev=1&freeze=1&view=cooling") {
  await page.goto(`/?${query}`);
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
  // The loader fades out after the scene is ready; captures wait for it to go.
  await page.locator("[data-testid=loader]").waitFor({ state: "detached", timeout: 10_000 });
}

interface Stats {
  frames: number;
  sceneCalls: number;
  frameErrors: number;
}
const stats = (page: Page) => page.evaluate("window.__sceneDev.stats()") as Promise<Stats>;

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

const setDuty = (page: Page, value: number) =>
  afterFrame(page, () => page.evaluate(`window.__sceneDev.setDuty(${value})`));

async function pixels(page: Page) {
  // WebKit screenshots at 2x; every capture is brought to 1280 x 720.
  const { data } = await sharp(await page.screenshot({ animations: "disabled" }))
    .resize(VIEWPORT.width, VIEWPORT.height)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

// How much the picture changed from `base`, as the summed brightness the vapour added: the
// vapour is the only thing that changes with the duty, and overlaps add to it, so it tracks the
// number of particles where the covered area alone would saturate.
function covered(base: Buffer, shot: Buffer): number {
  let sum = 0;
  for (let i = 0; i < base.length; i++) sum += Math.abs(base[i] - shot[i]);
  return sum;
}

test("the duty slider ramps the vapour: none at 0, more at 0.1, 0.5 and 1", async ({ page }) => {
  await open(page);
  await setDuty(page, 0);
  const none = await pixels(page);
  const mass: number[] = [];
  for (const duty of [0.1, 0.5, 1]) {
    await setDuty(page, duty);
    mass.push(covered(none, await pixels(page)));
  }
  // The overlaps saturate the plume, so the steps are not linear, but each one adds.
  expect(mass[0]).toBeGreaterThan(100_000);
  expect(mass[1]).toBeGreaterThan(mass[0] * 1.5);
  expect(mass[2]).toBeGreaterThan(mass[1] * 1.1);
  // Back to 0 takes it away again, and nothing threw.
  await setDuty(page, 0);
  expect(covered(none, await pixels(page))).toBeLessThan(5_000);
  expect((await stats(page)).frameErrors).toBe(0);
});

test("two frozen view=cooling captures match", async ({ page }) => {
  await open(page, "freeze=1&view=cooling");
  const a = await pixels(page);
  await page.reload();
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
  await page.locator("[data-testid=loader]").waitFor({ state: "detached", timeout: 10_000 });
  const b = await pixels(page);
  expect(covered(a, b)).toBe(0);
});

test("vapour costs the same draw calls at duty 0 and duty 1: one for the tower group", async ({
  page,
}) => {
  await open(page);
  // Once at 1 so every program is compiled before counting.
  await setDuty(page, 1);
  const full = (await stats(page)).sceneCalls;
  await setDuty(page, 0);
  expect((await stats(page)).sceneCalls).toBe(full);
});

test("the Cooling section is collapsed, last, and its slider and hook drive the duty", async ({
  page,
}) => {
  const warnings: string[] = [];
  const lines: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
    if (msg.text().startsWith("[scene]")) lines.push(msg.text());
  });
  await open(page);
  const hud = page.getByTestId("perf-hud");
  const sections = await hud
    .locator("section")
    .evaluateAll((all) => all.map((s) => (s as HTMLElement).dataset.testid));
  expect(sections.at(-1)).toBe("dev-cooling");
  const header = hud.getByRole("button", { name: /^Cooling/ });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  const slider = hud.getByRole("slider", { name: "Cooling duty" });
  await afterFrame(page, () => slider.fill("0.4"));
  await expect(slider).toHaveValue("0.4");
  expect(lines.some((l) => l.includes("duty") && l.includes("0.4"))).toBe(true);
  // Out of range input clamps and warns, naming the argument.
  await afterFrame(page, () => page.evaluate("window.__sceneDev.setDuty(9)"));
  await expect(slider).toHaveValue("1");
  expect(warnings.some((w) => w.includes('"value"'))).toBe(true);
});

test("with reduced motion duty 1 shows the vapour of duty 0.3 (30% of the particles)", async ({
  page,
}) => {
  await open(page);
  await setDuty(page, 0);
  const none = await pixels(page);
  await setDuty(page, 1);
  const full = covered(none, await pixels(page));
  await setDuty(page, 0.3);
  const thirty = await pixels(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate("window.__sceneDev.state().reducedMotion")).toBe(true);
  // The vapour reads the flag on every frame; a duty write draws one.
  await setDuty(page, 0.99);
  await setDuty(page, 1);
  const reduced = await pixels(page);
  // The same particles show, so the two pictures agree, and both differ a lot from full duty.
  expect(covered(thirty, reduced)).toBeLessThan(full * 0.01);
  expect(covered(none, reduced)).toBeGreaterThan(30_000);
  expect(covered(reduced, none)).toBeLessThan(full * 0.9);
});

const fanRate = (page: Page) =>
  page.evaluate("window.__sceneDev.fanTurnRate()") as Promise<number | null>;

// The rate the plant draws, once it has turned long enough to be measured.
const settledRate = async (page: Page, want: number) => {
  await expect.poll(() => fanRate(page), { timeout: 15_000 }).toBeCloseTo(want, 2);
};

test("fans turn at 0.5 turns a second at duty 1, 0.05 at duty 0 and 0.125 with reduced motion", async ({
  page,
}) => {
  // Not frozen: the fans only turn while scene time passes.
  await open(page, "dev=1&view=cooling");
  await page.evaluate("window.__sceneDev.setDuty(1)");
  await settledRate(page, 0.5);
  await page.evaluate("window.__sceneDev.setDuty(0)");
  await settledRate(page, 0.05);
  await page.evaluate("window.__sceneDev.setDuty(1)");
  await settledRate(page, 0.5);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => page.evaluate("window.__sceneDev.state().reducedMotion")).toBe(true);
  await settledRate(page, 0.125);
  expect((await stats(page)).frameErrors).toBe(0);
});

test("the Cooling slider follows the live duty until you drag it", async ({ page }) => {
  test.setTimeout(60_000);
  await open(page, "dev=1&view=cooling");
  const hud = page.getByTestId("perf-hud");
  await hud.getByRole("button", { name: /^Cooling/ }).click();
  const label = hud.locator("#dev-cooling-body label");
  await expect(label).toContainText("(live)");
  // Unfrozen, the fake duty swells away from 0.75 (+-0.2 over 90 s); once it is clear of 0.75 the
  // shown value must be the live one, not the default. The HUD reads every 250 ms and the duty
  // moves about 0.014 a second, and the slider rounds to 0.05, so 0.04 is the tolerance and a
  // default of 0.75 shown against a live 0.80 or more is told apart.
  const slider = hud.getByRole("slider", { name: "Cooling duty" });
  await expect
    .poll(
      async () => {
        const live = (await page.evaluate("window.__sceneDev.liveDuty()")) as number | null;
        const shown = Number(await slider.inputValue());
        return live !== null && Math.abs(live - 0.75) > 0.05 && Math.abs(shown - live) <= 0.04;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await slider.fill("0.4");
  await expect(label).toContainText("Duty 0.40 (set)");
});

test("in view=cooling Home frames the halls placed now, not the ones placed at load", async ({
  page,
}) => {
  await open(page, "dev=1&view=cooling");
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
