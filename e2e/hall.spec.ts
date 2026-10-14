/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { skipFrameSpecInCiFirefox } from "./ci-skip.ts";

const READY = "window.__sceneReady === true";
const VIEWPORT = { width: 1280, height: 720 };

test.beforeEach(({ browserName }, testInfo) => skipFrameSpecInCiFirefox(browserName, testInfo));

async function open(page: Page, query: string) {
  await page.goto(`/?${query}`);
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
}

type Point = [number, number, number];
type Hooks = {
  project(p: Point): { x: number; y: number };
  stats(): { frames: number; sceneCalls: number; bloom: boolean; frameErrors: number } | null;
  setRoofCut(on: boolean): void;
  setQuality(tier: string): void;
  signOpacity(slot: number): number | null;
};

const project = (page: Page, p: Point) =>
  page.evaluate(
    (q) => (window as unknown as { __sceneDev: Hooks }).__sceneDev.project(q),
    p,
  ) as Promise<{ x: number; y: number }>;
const frames = (page: Page) => page.evaluate("window.__sceneDev.stats().frames") as Promise<number>;
const opacity = (page: Page) =>
  page.evaluate("window.__sceneDev.signOpacity(0)") as Promise<number | null>;
// Runs `change`, then waits for a frame drawn after it (a frozen view draws one on demand).
const afterFrame = async (page: Page, change: () => Promise<unknown>) => {
  const before = await frames(page);
  await change();
  await expect.poll(() => frames(page), { timeout: 10_000 }).toBeGreaterThan(before);
};
const setRoofCut = (page: Page, on: boolean) =>
  afterFrame(page, () => page.evaluate(`window.__sceneDev.setRoofCut(${on})`));

// The hall's sign: centre (0, 1.55, 3.01) in the view=hall world; the "A" stands near its left end.
const LETTER: Point = [-1.28, 1.58, 3.02];
const ROOF_CORNERS: Point[] = [
  [-4.1, 2.22, -3.1],
  [4.1, 2.22, -3.1],
  [4.1, 2.22, 3.1],
  [-4.1, 2.22, 3.1],
];

// Scrolls the wheel over the middle of the canvas, which zooms out towards the cursor.
async function zoomOut(page: Page) {
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  for (let i = 0; i < 14; i++) await page.mouse.wheel(0, 400);
}

// The wheel's zoom has finished easing: two reads a moment apart agree.
const cameraStill = (page: Page) =>
  expect
    .poll(async () => {
      const read = () => page.evaluate("JSON.stringify(window.__sceneDev.camera())");
      const before = await read();
      await page.waitForTimeout(300);
      return (await read()) === before;
    })
    .toBe(true);

async function pixels(page: Page) {
  // WebKit screenshots at 2x; the hooks speak CSS px, so every capture is brought to 1280 x 720.
  const { data, info } = await sharp(await page.screenshot({ animations: "disabled" }))
    .resize(VIEWPORT.width, VIEWPORT.height)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, channels: info.channels };
}

type Shot = Awaited<ReturnType<typeof pixels>>;
const luminanceAt = (shot: Shot, x: number, y: number) => {
  const i = (Math.round(y) * shot.width + Math.round(x)) * shot.channels;
  return 0.2126 * shot.data[i] + 0.7152 * shot.data[i + 1] + 0.0722 * shot.data[i + 2];
};
// The brightest pixel in a (2r+1) square: a letter stroke is thin, so one sample could miss it.
function brightest(shot: Shot, x: number, y: number, r: number) {
  let max = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) max = Math.max(max, luminanceAt(shot, x + dx, y + dy));
  }
  return max;
}

test("the roof cutaway toggle changes the roof region of a frozen view=hall capture", async ({
  page,
}) => {
  await open(page, "dev=1&freeze=1&view=hall");
  const corners = await Promise.all(ROOF_CORNERS.map((c) => project(page, c)));
  const box = {
    x0: Math.max(0, Math.floor(Math.min(...corners.map((c) => c.x)))),
    x1: Math.min(VIEWPORT.width, Math.ceil(Math.max(...corners.map((c) => c.x)))),
    y0: Math.max(0, Math.floor(Math.min(...corners.map((c) => c.y)))),
    y1: Math.min(VIEWPORT.height, Math.ceil(Math.max(...corners.map((c) => c.y)))),
  };
  const cut = await pixels(page);
  await setRoofCut(page, false);
  const uncut = await pixels(page);
  let changed = 0;
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      const i = (y * cut.width + x) * cut.channels;
      const d =
        Math.abs(cut.data[i] - uncut.data[i]) +
        Math.abs(cut.data[i + 1] - uncut.data[i + 1]) +
        Math.abs(cut.data[i + 2] - uncut.data[i + 2]);
      if (d > 12) changed++;
    }
  }
  // The roof covers most of the hall's footprint on screen (about 40,000 px at this zoom).
  expect(changed).toBeGreaterThan(5_000);
  await setRoofCut(page, true);
  const again = await pixels(page);
  const i =
    (Math.round((box.y0 + box.y1) / 2) * cut.width + Math.round((box.x0 + box.x1) / 2)) *
    cut.channels;
  expect(Math.abs(again.data[i] - cut.data[i])).toBeLessThan(4);
});

test("the sign shows at the view=hall framing and hides after zooming out", async ({ page }) => {
  await open(page, "dev=1&freeze=1&view=hall");
  expect(await opacity(page)).toBe(1);
  const at = await project(page, LETTER);
  expect(brightest(await pixels(page), at.x, at.y, 8)).toBeGreaterThan(110);
  await zoomOut(page);
  await expect.poll(() => opacity(page), { timeout: 10_000 }).toBe(0);
  await cameraStill(page);
  const far = await project(page, LETTER);
  expect(brightest(await pixels(page), far.x, far.y, 2)).toBeLessThan(110);
});

test("a panel's opacity goes from 1 to 0 within about 200 ms after zooming out", async ({
  page,
}) => {
  test.slow();
  await open(page, "dev=1&view=hall");
  expect(await opacity(page)).toBe(1);
  // Sampled on every animation frame while the wheel zooms out. The fade starts the moment the
  // letter drops below 12 px and takes 200 ms, whatever the zoom speed. On a busy machine frames
  // can be further apart than the fade, so an attempt with fewer than two samples between 1 and 0
  // is repeated (one is enough in the end; two are what let the end bracket catch a slower fade).
  // The last attempt stays zoomed out, so the fader-clock checks below read the fade it ran.
  // CI's software-rendered Chromium can draw frames more than 200 ms apart on every attempt, so
  // no sample may land inside the fade at all. Then only the sample checks are skipped (and the
  // run is annotated): the fader-clock checks at the end still prove the 200 ms duration, and a
  // cut would leave their start/end null, so it is still caught.
  type Sample = [number, number];
  let samples: Sample[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const run = page.evaluate(
      () =>
        new Promise<Sample[]>((resolve) => {
          const dev = (window as unknown as { __sceneDev: Hooks }).__sceneDev;
          const out: Sample[] = [];
          const tick = (now: number) => {
            const o = dev.signOpacity(0)!;
            out.push([now, o]);
            if (o === 0) return resolve(out);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    await zoomOut(page);
    samples = await run;
    if (samples.filter(([, o]) => o > 0 && o < 1).length >= 2 || attempt === 3) break;
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    for (let i = 0; i < 14; i++) await page.mouse.wheel(0, -400);
    await expect.poll(() => opacity(page), { timeout: 10_000 }).toBe(1);
  }
  const partial = samples.filter(([, o]) => o > 0 && o < 1);
  if (partial.length > 0) {
    expect(partial.length, "a sample between 1 and 0 means a fade, not a cut").toBeGreaterThan(0);
    // A 200 ms linear fade that reads o at time t began (1 - o) x 200 ms earlier; every sample
    // must agree on when. The fade ends at start + 200 ms, which must fall between the last sample
    // still fading and the first sample at 0 (bracketed, so frames far apart on a busy
    // machine cannot fail it, while a 400 ms fade still does: its last partial sample is later
    // than the end).
    const starts = partial.map(([t, o]) => t - (1 - o) * 200);
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(120);
    const start = Math.min(...starts);
    const lastPartial = partial[partial.length - 1][0];
    const end = samples[samples.length - 1][0];
    expect(end).toBeGreaterThanOrEqual(start + 190);
    expect(lastPartial).toBeLessThanOrEqual(start + 200 + 40);
  } else {
    test.info().annotations.push({
      type: "sparse-frames",
      description:
        "no frame landed inside the 200 ms fade; duration checked on the fader clock only",
    });
  }
  // The fader's own clock gives the duration whatever the frame spacing: 200 ms (design D7).
  const fade = (await page.evaluate("window.__sceneDev.signFade(0)")) as {
    opacity: number;
    start: number | null;
    end: number | null;
  };
  expect(fade.opacity).toBe(0);
  expect(fade.start).not.toBeNull();
  expect(fade.end).not.toBeNull();
  expect(fade.end! - fade.start!).toBeGreaterThanOrEqual(190);
  expect(fade.end! - fade.start!).toBeLessThanOrEqual(210);
});

test("a static hall draws in 4 scene calls: 3 main pass plus 1 shadow, on top of the ground", async ({
  page,
}) => {
  await open(page, "dev=1&freeze=1&view=hall");
  const calls = (await page.evaluate("window.__sceneDev.stats().sceneCalls")) as number;
  // The ground plane and its grid are 2 more calls; the hall itself is 4 (CEO C24).
  const GROUND_CALLS = 2;
  // Exactly 4 at the high tier, which has shadows on: with shadows off it would read 3.
  expect(await page.evaluate("window.__sceneDev.state().quality")).toBe("high");
  expect(calls - GROUND_CALLS).toBe(4);
  await expect(page.getByTestId("perf-hud").locator('[data-hud="scene calls"]')).toHaveText(
    String(calls),
  );
});

test("the Hall dev section starts collapsed, after Camera, and toggles the roof", async ({
  page,
}) => {
  await open(page, "dev=1&freeze=1&view=hall");
  const hud = page.getByTestId("perf-hud");
  const sections = await hud
    .locator("section")
    .evaluateAll((all) => all.map((s) => s.dataset.testid));
  expect(sections).toEqual([
    "dev-camera",
    "dev-hall",
    "dev-racks",
    "dev-campus",
    "dev-cooling",
    "dev-network",
  ]);
  const header = hud.getByRole("button", { name: /^Hall/ });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();
  const roof = hud.getByRole("button", { name: /^Roof cut/ });
  await expect(roof).toHaveText("Roof cut on");
  await roof.click();
  await expect(roof).toHaveText("Roof cut off");
  await roof.click();
  await expect(roof).toHaveText("Roof cut on");
});

test("setQuality forces a tier, and a bad tier warns without changing it", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  await open(page, "dev=1&freeze=1&view=hall");
  expect(await page.evaluate("window.__sceneDev.stats().bloom")).toBe(true);
  await page.evaluate("window.__sceneDev.setQuality('medium')");
  await expect.poll(() => page.evaluate("window.__sceneDev.stats().bloom")).toBe(false);
  await page.evaluate("window.__sceneDev.setQuality('ultra')");
  expect(await page.evaluate("window.__sceneDev.state().quality")).toBe("medium");
  expect(warnings.some((w) => w.includes("tier"))).toBe(true);
  await page.evaluate("window.__sceneDev.setQuality('high')");
  await expect.poll(() => page.evaluate("window.__sceneDev.stats().bloom")).toBe(true);
  expect(await page.evaluate("window.__sceneDev.stats().frameErrors")).toBe(0);
});
