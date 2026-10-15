/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";

async function openData(page: Page, query: string) {
  await page.goto(`/?${query}`);
  await page.locator("[data-testid=dev-data] button").first().click();
  await page.locator("[data-testid=dev-data-body]").waitFor();
}

const renders = (page: Page) => page.evaluate("window.__dataDev.renders()") as Promise<number>;
// The first frames of the scene compile shaders and can stall the page for seconds; wait until
// a 50 ms timer chain runs on time before measuring anything.
async function settle(page: Page) {
  for (let i = 0; i < 20; i++) {
    const gap = await page.evaluate(
      () =>
        new Promise<number>((done) => {
          let last = performance.now();
          let max = 0;
          let n = 0;
          const tick = () => {
            const now = performance.now();
            max = Math.max(max, now - last);
            last = now;
            if (++n < 10) setTimeout(tick, 50);
            else done(max);
          };
          setTimeout(tick, 50);
        }),
    );
    if (gap < 150) return;
  }
  throw new Error("the page never settled: a 50 ms timer chain kept running late");
}
const applied = async (page: Page) =>
  Number(
    /applied (\d+)/.exec(await page.locator("[data-testid=data-health]").innerText())?.[1] ?? NaN,
  );
const health = (page: Page) => page.locator("[data-testid=data-health]");

test("the Data section fills from the mock and re-renders at most once per 250 ms", async ({
  page,
}) => {
  // Under load the page stalls for seconds while the scene compiles; the bound is relative to
  // the elapsed time actually measured so a slow page loosens it rather than breaking it.
  test.setTimeout(90_000);
  // webgl=0 skips the scene: its shader compiles and frames are not what is measured here.
  await openData(page, "dev=1&source=mock&webgl=0");
  await expect(health(page)).toContainText("live");
  await expect(page.locator("[data-testid=data-session-row]").first()).toBeVisible();
  // A page stalled by shader compiles fits too few batches in the window to tell a throttled
  // panel from an unthrottled one; settle() throws if it never quiets.
  await settle(page);
  const before = await renders(page);
  const appliedBefore = await applied(page);
  // One batch per timer task, for at least 5 s and at least 100 batches: an unthrottled panel
  // renders about once per batch, far past the bound, however slow the page runs.
  const start = Date.now();
  const sent = await page.evaluate(
    () =>
      new Promise<number>((done) => {
        const hook = (window as unknown as { __dataDev: { applyBatch(e: unknown[]): void } })
          .__dataDev;
        const t0 = performance.now();
        let n = 0;
        const tick = () => {
          hook.applyBatch([
            {
              id: `burst-${n}`,
              vendor: "claude",
              projectKey: "/work/orbit-api",
              sessionId: `burst-s${n % 5}`,
              parentKnown: true,
              agentKind: "main",
              ts: new Date(Date.UTC(2026, 0, 2, 9, 0, 0, n)).toISOString(),
              type: "session_start",
              status: "idle",
              provenance: {},
            },
          ]);
          n++;
          const elapsed = performance.now() - t0;
          if ((elapsed < 5000 || n < 100) && elapsed < 15_000) setTimeout(tick, 5);
          else done(n);
        };
        tick();
      }),
  );
  await page.waitForTimeout(500);
  const rendered = (await renders(page)) - before;
  const elapsed = Date.now() - start;
  expect(sent).toBeGreaterThanOrEqual(100);
  // C39: at most one render per 250 ms (25 in 5 s), plus slack for the window edges.
  expect(rendered).toBeLessThanOrEqual(Math.floor(elapsed / 250) + 3);
  // The source was really streaming: the applied count grew by the burst events, and the
  // panel rendered more than once while they arrived.
  expect((await applied(page)) - appliedBefore).toBeGreaterThanOrEqual(sent);
  expect(rendered).toBeGreaterThan(3);

  await page.locator("[data-testid=data-source-off]").click();
  await expect(health(page)).toContainText("idle");
  await page.waitForTimeout(500);
  const stopped = await renders(page);
  await page.waitForTimeout(2000);
  expect(await renders(page)).toBe(stopped);
});

test("clicking a session row lists its events", async ({ page }) => {
  await openData(page, "dev=1&source=mock&freeze=1");
  await expect(health(page)).toContainText("live");
  await page.locator("[data-testid=data-session-row]").first().click();
  const events = page.locator("[data-testid=data-peek-event]");
  await expect(events.first()).toBeVisible();
  expect(await events.count()).toBeLessThanOrEqual(20);
  await expect(events.first()).toHaveText(/^\d\d:\d\d:\d\d \w+ \S+ \S+$/);
});

test("60 sessions show 50 rows and +10 more; none shows the empty text", async ({ page }) => {
  // No source: without freeze=1 the page connects the live one.
  await openData(page, "dev=1&freeze=1");
  await expect(page.locator("[data-testid=data-empty]")).toHaveText(
    "No sessions yet (source: idle)",
  );
  await page.evaluate(() => {
    const events = Array.from({ length: 60 }, (_, i) => ({
      id: `dev-${i}`,
      vendor: "claude",
      projectKey: "/work/orbit-api",
      sessionId: `dev-s${i}`,
      parentKnown: true,
      agentKind: "main",
      ts: new Date(Date.UTC(2026, 0, 1, 9, 0, i)).toISOString(),
      type: "session_start",
      status: "idle",
      provenance: {},
    }));
    (window as unknown as { __dataDev: { applyBatch(e: unknown[]): void } }).__dataDev.applyBatch(
      events,
    );
  });
  await expect(page.locator("[data-testid=data-session-row]")).toHaveCount(50, { timeout: 15_000 });
  await expect(page.locator("[data-testid=data-more]")).toHaveText("+10 more", { timeout: 15_000 });
});

test("two frozen captures of the open Data section match across a reload", async ({ page }) => {
  await openData(page, "dev=1&source=mock&freeze=1");
  await expect(health(page)).toContainText("live");
  await expect(health(page)).toContainText("—");
  // Under freeze only the catch-up is sent: let several mock ticks and the 250 ms throttle pass
  // and the applied count must not move.
  // The page may be stalled by shader compiles first, so settle before counting the time.
  const catchUp = await applied(page);
  await settle(page);
  await page.waitForTimeout(1500);
  expect(await applied(page)).toBe(catchUp);
  const hud = page.locator("[data-testid=perf-hud]");
  const first = await hud.screenshot({ animations: "disabled" });
  await openData(page, "dev=1&source=mock&freeze=1");
  await expect(health(page)).toContainText("live");
  await expect(health(page)).toContainText("—");
  await settle(page);
  await page.waitForTimeout(1500);
  expect(await applied(page)).toBe(catchUp);
  const second = await hud.screenshot({ animations: "disabled" });
  expect(second.equals(first)).toBe(true);
});

test("burst at 10x: the applied count rises, Pause stops it over 1 s, Play resumes it", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // No scene (webgl=0): on GPU-less CI the live scene keeps the page from settling.
  await openData(page, "dev=1&webgl=0&source=mock&scenario=burst&speed=10");
  await expect(health(page)).toContainText("live");
  await expect(health(page)).toContainText("10x");
  const first = await applied(page);
  await expect.poll(() => applied(page), { timeout: 20_000 }).toBeGreaterThan(first);
  await settle(page);
  const playPause = page.locator("[data-testid=data-playpause]");
  await expect(playPause).toHaveText("Pause");
  await playPause.click();
  await expect(playPause).toHaveText("Play");
  await expect(health(page)).toContainText("paused");
  // Let the 250 ms panel throttle and any in-flight tick land before counting.
  await page.waitForTimeout(600);
  const frozen = await applied(page);
  await page.waitForTimeout(1000);
  expect(await applied(page)).toBe(frozen);
  await playPause.click();
  await expect(playPause).toHaveText("Pause");
  await expect.poll(() => applied(page), { timeout: 20_000 }).toBeGreaterThan(frozen);
});

const sourceTime = async (page: Page) =>
  /\+(\d\d:\d\d:\d\d)/.exec(await health(page).innerText())?.[1] ?? "";
const batches = async (page: Page) =>
  Number(/batches (\d+)/.exec(await health(page).innerText())?.[1] ?? NaN);

test("the source time advances while running with no batch, and holds while paused", async ({
  page,
}) => {
  test.setTimeout(90_000);
  // Intervals created while the flag is set never fire: the mock's tick timer is made after the
  // click, so no batch follows the catch-up while its clock still runs. The panel's own timer is
  // made at mount, before the flag.
  await page.addInitScript(() => {
    const real = window.setInterval.bind(window);
    const w = window as unknown as { __muteNew?: boolean };
    window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
      real(w.__muteNew ? () => {} : fn, ms, ...args)) as typeof window.setInterval;
  });
  await openData(page, "dev=1&webgl=0");
  await settle(page);
  await page.evaluate(() => ((window as unknown as { __muteNew: boolean }).__muteNew = true));
  await page.locator("[data-testid=data-source-mock]").click();
  await expect(health(page)).toContainText("running");
  await page.waitForTimeout(600);
  const [t0, b0] = [await sourceTime(page), await batches(page)];
  await page.waitForTimeout(2500);
  expect(await batches(page)).toBe(b0);
  expect(await sourceTime(page)).not.toBe(t0);
  await page.locator("[data-testid=data-playpause]").click();
  await expect(health(page)).toContainText("paused");
  await page.waitForTimeout(600);
  const held = await sourceTime(page);
  await page.waitForTimeout(2500);
  expect(await sourceTime(page)).toBe(held);
});

test("every [data-metric] carries a provenance badge of the right kind, with its basis on hover and focus", async ({
  page,
}) => {
  await openData(page, "dev=1&source=mock&freeze=1&webgl=0");
  await expect(health(page)).toContainText("live");
  const metrics = page.locator("[data-metric]");
  await expect(metrics).toHaveCount(8);
  const bare = await metrics.evaluateAll((els) =>
    els
      .filter((el) => !el.querySelector("[data-provenance]"))
      .map((el) => el.getAttribute("data-metric")),
  );
  expect(bare).toEqual([]);
  const kind = (name: string) =>
    page.locator(`[data-metric=${name}] [data-provenance]`).getAttribute("data-provenance");
  expect(await kind("tokens")).toBe("real");
  expect(await kind("active-sessions")).toBe("derived");
  expect(await kind("tokens-per-min")).toBe("derived");
  for (const name of ["cost", "hall-heat", "hall-inlet", "hot-aisle", "cooling-duty"])
    expect(await kind(name), name).toBe("estimated");

  const badge = page.locator("[data-metric=cost] [data-provenance]");
  const tip = badge.locator("[role=tooltip]");
  await expect(tip).toBeHidden();
  await badge.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("not a subscription bill");
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  await badge.focus();
  await expect(tip).toBeVisible();
});
