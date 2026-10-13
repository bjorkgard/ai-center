import { expect, test, type Page } from "@playwright/test";

// Crash and equality smoke for the chunk 03 spike views (CEO C13, eng E12, E17).
// Local only: CI's Chromium and Firefox jobs skip it. It is a crash check, not a
// measurement: headless Chromium renders on SwiftShader and Playwright's WebKit is
// not Safari, so no ADR number comes from here.
test.skip(!!process.env.CI, "spike smoke runs locally only (vp run e2e:local)");

interface Snapshot {
  halls: number;
  geometries: number;
  drawCalls: number;
  rackInstances: number;
  ledInstances: number;
}

async function openView(page: Page, view: string, load: number): Promise<Snapshot> {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto(`/?view=${view}&load=${load}`);
  await expect(page.locator("canvas")).toHaveCount(1);
  await page.waitForFunction(
    "window.__spikeSnapshot !== undefined && window.__spikeSnapshot().drawCalls > 0",
    undefined,
    { timeout: 30_000 },
  );
  const snapshot = (await page.evaluate("window.__spikeSnapshot()")) as Snapshot;
  expect(errors).toEqual([]);
  return snapshot;
}

for (const load of [1, 4]) {
  test(`both spike views draw the same scene at load ${load}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
      const r3f = await openView(await context.newPage(), "spike-r3f", load);
      const vanilla = await openView(await context.newPage(), "spike-vanilla", load);

      expect(r3f.halls).toBe(12);
      expect(r3f.rackInstances).toBe(192 * load);
      expect(r3f.ledInstances).toBe(3072 * load);
      expect(vanilla.halls).toBe(r3f.halls);
      expect(vanilla.rackInstances).toBe(r3f.rackInstances);
      expect(vanilla.ledInstances).toBe(r3f.ledInstances);
      expect(vanilla.geometries).toBe(r3f.geometries);
      expect(vanilla.drawCalls).toBe(r3f.drawCalls);
    } finally {
      await context.close();
    }
  });
}
