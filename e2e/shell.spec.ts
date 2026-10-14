/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { skipFrameSpecInCiFirefox } from "./ci-skip.ts";
import { contrastRatio, expectContrast } from "./helpers/contrast.ts";

const READY = "window.__sceneReady === true";

async function open(page: Page, query: string) {
  await page.goto(`/?${query}`);
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
}

// Holds every animation frame until __release(), so the scene cannot draw its first frame.
const HOLD_FRAMES = `(() => {
  const real = window.requestAnimationFrame.bind(window);
  const queue = [];
  let held = true;
  window.requestAnimationFrame = (cb) => {
    if (!held) return real(cb);
    queue.push(cb);
    return queue.length;
  };
  window.__release = () => {
    held = false;
    for (const cb of queue.splice(0)) real(cb);
  };
})()`;

const box = async (page: Page, testId: string) => {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return b;
};

const lose = `(() => {
  const gl = document.querySelector("canvas").getContext("webgl2");
  const ext = gl.getExtension("WEBGL_lose_context");
  window.__ext = ext;
  ext.loseContext();
})()`;

for (const size of [
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
]) {
  test(`the shell matches the section 4b diagram at ${size.width}x${size.height}`, async ({
    page,
    browserName,
  }, testInfo) => {
    skipFrameSpecInCiFirefox(browserName, testInfo);
    await page.setViewportSize(size);
    await open(page, "dev=1&freeze=1");

    const top = await box(page, "slot-top-bar");
    expect(top).toMatchObject({ x: 0, y: 0, width: size.width, height: 56 });
    const tabs = await box(page, "slot-tab-strip");
    expect(tabs).toMatchObject({ x: 0, y: size.height - 48, width: size.width, height: 48 });
    for (const id of ["slot-top-bar", "slot-tab-strip"]) {
      const radius = await page
        .getByTestId(id)
        .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
      expect(radius).toBe("0px");
    }
    expect(
      await page
        .getByTestId("slot-job-tracker")
        .evaluate((el) => getComputedStyle(el).borderTopLeftRadius),
    ).not.toBe("0px");

    const kpis = ["claude-sessions", "codex-sessions", "agents"];
    for (const [i, name] of kpis.entries()) {
      expect(await box(page, `slot-${name}`)).toMatchObject({
        x: 16 + i * (168 + 12),
        y: 72,
        width: 168,
        height: 120,
      });
    }
    const tracker = await box(page, "slot-job-tracker");
    expect(tracker).toMatchObject({ x: 16, width: 536, height: 112 });
    expect(tracker.y + tracker.height).toBe(tabs.y - 16);
    await expect(page.getByTestId("slot-right-panel")).toHaveCount(0);

    await page.getByRole("button", { name: "Show right panel" }).click();
    const right = await box(page, "slot-right-panel");
    expect(right).toMatchObject({ x: size.width - 16 - 360, y: 72, width: 360 });
    expect(right.y + right.height).toBe(tabs.y - 16);

    const safe = page.getByTestId("safe-area");
    await expect
      .poll(async () => safe.boundingBox())
      .toMatchObject({ x: 0, y: 192, width: size.width - 376, height: tracker.y - 192 });
    await page.getByRole("button", { name: "Hide right panel" }).click();
    await expect
      .poll(async () => safe.boundingBox())
      .toMatchObject({ x: 0, y: 192, width: size.width, height: tracker.y - 192 });
  });
}

test("panels block pointer events and the gaps pass them through", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  await open(page, "dev=1&freeze=1");
  const hit = (x: number, y: number) =>
    page.evaluate(`(() => {
      const el = document.elementFromPoint(${x}, ${y});
      return { panel: !!el?.closest("[data-panel]"), tag: el?.tagName };
    })()`) as Promise<{ panel: boolean; tag: string }>;
  expect((await hit(100, 130)).panel).toBe(true); // KPI tile
  expect((await hit(640, 20)).panel).toBe(true); // top bar
  expect((await hit(640, 700)).panel).toBe(true); // tab strip
  expect(await hit(640, 400)).toEqual({ panel: false, tag: "CANVAS" }); // gap
});

test("text keeps the D21 contrast at the night glass level", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  await open(page, "dev=1&freeze=1");
  await page.getByRole("button", { name: "Show right panel" }).click();
  await expectContrast(page, page.getByTestId("wordmark"));
  for (const label of await page.getByTestId("tab-label").all()) {
    await expectContrast(page, label);
  }
  for (const id of ["claude-sessions", "codex-sessions", "agents", "job-tracker", "right-panel"]) {
    await expectContrast(page, page.getByTestId(`slot-${id}`).getByRole("heading"));
  }
});

test("the loader wordmark keeps the D21 contrast on the 3D area", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  await page.addInitScript(HOLD_FRAMES);
  await page.goto("/");
  const wordmark = page.getByTestId("loader-wordmark");
  await expect(wordmark).toBeVisible();
  await expectContrast(page, wordmark);
});

test("scrollable elements get the thin themed scrollbar", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  await open(page, "dev=1&freeze=1");
  const width = await page.evaluate(() => {
    const el = document.createElement("div");
    el.style.cssText = "overflow:auto;height:10px";
    document.body.append(el);
    const w = getComputedStyle(el).scrollbarWidth;
    el.remove();
    return w;
  });
  expect(width).toBe("thin");
});

test("the contrast helper itself measures known colours", () => {
  expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
  expect(contrastRatio([163, 172, 189], [27, 30, 37])).toBeGreaterThan(7);
});

test("the loader shows after 300 ms under the shell, then fades out on the first frame", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  await page.addInitScript(HOLD_FRAMES);
  await page.goto("/");
  await expect(page.getByTestId("slot-top-bar")).toBeVisible(); // shell from first paint
  const loader = page.getByTestId("loader");
  await expect(loader).toBeVisible();
  await expect(loader).toHaveAttribute("data-phase", "shown");
  const bar = page.getByTestId("loader-bar");
  expect(await bar.evaluate((el) => getComputedStyle(el).animationName)).toBe("loader-sweep");
  expect(await bar.evaluate((el) => getComputedStyle(el).animationDuration)).toBe("1.2s");
  // The sweeping bar is a fractional width mid-animation; the track around it is the stable box.
  expect(await bar.locator("..").boundingBox()).toMatchObject({ width: 160, height: 2 });
  expect(await page.evaluate(READY)).toBe(false);

  await page.evaluate("window.__release()");
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
  await expect(loader).toHaveCount(0);
});

test("under reduced motion the loader does not sweep and cuts instantly", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(HOLD_FRAMES);
  await page.goto("/");
  const loader = page.getByTestId("loader");
  await expect(loader).toBeVisible();
  expect(
    await page.getByTestId("loader-bar").evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  // A cut never passes through the fading phase; this does not depend on how fast React renders.
  await page.evaluate(`(() => {
    window.__fading = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="loader"][data-phase="fading"]')) {
        window.__fading = true;
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  })()`);
  await page.evaluate("window.__release()");
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
  await expect(loader).toHaveCount(0);
  expect(await page.evaluate("window.__fading")).toBe(false);
});

test("a fast start never shows the loader", async ({ page }) => {
  await page.goto("/?webgl=0");
  await expect(page.getByTestId("webgl-card")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("loader")).toHaveCount(0);
});

test("webgl=0 shows the WebGL card as glass and the loader gives way", async ({ page }) => {
  await page.goto("/?webgl=0");
  const card = page.getByTestId("webgl-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-glass", "adaptive");
  await expect(card.locator('[data-glass-layer="tint"]')).toHaveCount(1);
  const filter = await card.evaluate((el) => getComputedStyle(el).backdropFilter);
  expect(filter).toContain("blur(16px)");
  expect(filter).toContain("saturate(1.4)");
  await expect(page.getByTestId("loader")).toHaveCount(0);
  await expect(page.getByTestId("slot-top-bar")).toBeVisible(); // panels still render
});

const alpha = (css: string) =>
  Number(css.match(/,\s*([\d.]+)\)$/)?.[1] ?? (css.includes("rgba") ? NaN : 1));

test("the glass falls back to a solid 85% layer under slow frames and recovers", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  test.setTimeout(90_000);
  await open(page, "dev=1&calm=0");
  const panel = page.getByTestId("slot-job-tracker");
  const dark = panel.locator('[data-glass-layer="dark"]');
  const tint = panel.locator('[data-glass-layer="tint"]');
  const bg = (l: typeof dark) =>
    l.evaluate((el) => getComputedStyle(el).backgroundColor) as Promise<string>;

  await page.evaluate("window.__sceneDev.simulateFrameInterval(16)");
  expect(alpha(await bg(dark))).toBe(0); // night: only the white tint
  expect(alpha(await bg(tint))).toBeCloseTo(0.08, 2);

  await page.evaluate("window.__sceneDev.simulateFrameInterval(40)");
  await expect(panel).toHaveAttribute("data-glass", "fallback", { timeout: 20_000 });
  await expect.poll(async () => alpha(await bg(dark))).toBeCloseTo(0.85, 2);
  expect(alpha(await bg(tint))).toBeCloseTo(0.08, 2); // the tint stays
  expect(await panel.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");

  await page.evaluate("window.__sceneDev.simulateFrameInterval(16)");
  await expect(panel).toHaveAttribute("data-glass", "adaptive", { timeout: 40_000 });
  await expect.poll(async () => alpha(await bg(dark))).toBe(0);
});

test("a lost context shows the restore toast in the live region, then the restored toast for 6 s", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  test.setTimeout(60_000);
  await open(page, "dev=1");
  const region = page.locator('[aria-live="polite"]');
  await expect(region).toHaveCount(1);
  await page.evaluate(lose);
  await expect(region.getByText("Restoring 3D view")).toBeVisible();
  const toast = region.getByTestId("toast");
  expect(await toast.boundingBox()).toMatchObject({ width: 320 });
  await page.evaluate("window.__ext.restoreContext()");
  await expect(region.getByText("3D view restored")).toBeVisible();
  await expect(region.getByText("Restoring 3D view")).toHaveCount(0);
  await expect(region.getByText("3D view restored")).toHaveCount(0, { timeout: 12_000 });
});

// Flags any moment the restoring toast is in the DOM together with a card.
const WATCH_RESTORING_OVER_CARD = `(() => {
  const log = { overCard: false, exited: false };
  const check = () => {
    const toast = [...document.querySelectorAll('[data-testid="toast"]')].find((t) =>
      t.textContent.includes("Restoring 3D view"),
    );
    if (!toast) return;
    if (toast.style.animation.includes("-out")) log.exited = true;
    if (document.querySelector('[data-testid$="-card"]')) log.overCard = true;
  };
  new MutationObserver(check).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  window.__restoringLog = log;
})()`;

test("the restoring toast leaves without lingering when a scene error card replaces it", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  await open(page, "dev=1");
  await page.evaluate(WATCH_RESTORING_OVER_CARD);
  await page.evaluate(lose);
  await expect(page.getByTestId("toast").filter({ hasText: "Restoring 3D view" })).toBeVisible();
  await page.evaluate("window.__sceneDev.throwInScene('boom')");
  await expect(page.getByTestId("scene-error-card")).toBeVisible();
  await expect(page.getByText("Restoring 3D view")).toHaveCount(0);
  expect(await page.evaluate("window.__restoringLog")).toMatchObject({ overCard: false });
});

test("the restoring toast leaves without lingering when the lost card replaces it", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  test.setTimeout(60_000);
  await open(page, "dev=1");
  await page.evaluate(WATCH_RESTORING_OVER_CARD);
  await page.evaluate(lose);
  await expect(page.getByTestId("toast").filter({ hasText: "Restoring 3D view" })).toBeVisible();
  await expect(page.getByTestId("webgl-lost-card")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Restoring 3D view")).toHaveCount(0);
  expect(await page.evaluate("window.__restoringLog")).toMatchObject({ overCard: false });
});

test("a card that appears while the restoring toast exits removes it at once", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  await open(page, "dev=1");
  await page.evaluate(WATCH_RESTORING_OVER_CARD);
  // Throw the scene error in the same task that sees the restoring toast start its exit.
  await page.evaluate(`(() => {
    new MutationObserver(() => {
      const out = [...document.querySelectorAll('[data-testid="toast"]')].some(
        (t) => t.textContent.includes("Restoring 3D view") && t.style.animation.includes("-out"),
      );
      if (out && !window.__thrown) {
        window.__thrown = true;
        window.__sceneDev.throwInScene("boom");
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  })()`);
  await page.evaluate(lose);
  await expect(page.getByTestId("toast").filter({ hasText: "Restoring 3D view" })).toBeVisible();
  await page.evaluate("window.__ext.restoreContext()");
  await expect(page.getByTestId("scene-error-card")).toBeVisible();
  await expect(page.getByText("Restoring 3D view")).toHaveCount(0);
  expect(await page.evaluate("window.__restoringLog")).toMatchObject({
    exited: true,
    overCard: false,
  });
});

test("under reduced motion the restoring icon does not spin", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "dev=1");
  await page.evaluate(lose);
  const toast = page.getByTestId("toast").filter({ hasText: "Restoring 3D view" });
  await expect(toast).toBeVisible();
  expect(await toast.locator("path").evaluate((el) => getComputedStyle(el).animationName)).toBe(
    "none",
  );
});

test("resizing and toggling panels raise no ResizeObserver error", async ({
  page,
  browserName,
}, testInfo) => {
  skipFrameSpecInCiFirefox(browserName, testInfo);
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  await page.addInitScript(
    `window.addEventListener("error", (e) => console.error("window error: " + e.message))`,
  );
  await open(page, "dev=1");
  for (const [width, height] of [
    [1400, 800],
    [1280, 720],
    [1600, 900],
    [1280, 720],
  ]) {
    await page.setViewportSize({ width, height });
    await page.getByRole("button", { name: /right panel/ }).click();
  }
  await page.waitForTimeout(300);
  const safe = await page.getByTestId("safe-area").boundingBox();
  expect(safe).toMatchObject({ y: 192 });
  expect(errors.filter((e) => /ResizeObserver/i.test(e))).toEqual([]);
  expect(errors).toEqual([]);
});
