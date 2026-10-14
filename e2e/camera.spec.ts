/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { skipFrameSpecInCiFirefox } from "./ci-skip.ts";

const READY = "window.__sceneReady === true";

test.beforeEach(({ browserName }, testInfo) => skipFrameSpecInCiFirefox(browserName, testInfo));

async function open(page: Page, query = "dev=1") {
  await page.goto(`/?${query}`);
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
}

interface CameraView {
  target: [number, number, number];
  zoom: number;
  azimuth: number;
  elevation: number;
  projection: string;
  animating: boolean;
}

type Hooks = {
  camera(): CameraView;
  project(p: [number, number, number]): { x: number; y: number };
};

const camera = (page: Page) => page.evaluate("window.__sceneDev.camera()") as Promise<CameraView>;
const project = (page: Page, p: [number, number, number]) =>
  page.evaluate(
    (q) => (window as unknown as { __sceneDev: Hooks }).__sceneDev.project(q),
    p,
  ) as Promise<{ x: number; y: number }>;
// The camera has stopped, damping included: two reads a few frames apart are the same.
// The damping tail takes ~3-4 s under load, so the poll gets more than the 5 s default.
const camerasStill = (page: Page) =>
  expect
    .poll(
      async () => {
        const before = JSON.stringify(await camera(page));
        await page.evaluate(
          "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))",
        );
        return JSON.stringify(await camera(page)) === before;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
const settled = (page: Page) => expect.poll(async () => (await camera(page)).animating).toBe(false);

// The canvas takes focus the way a keyboard user gets there: Tab from the top of the page.
async function focusCanvas(page: Page) {
  await page.keyboard.press("Tab");
  await expect(page.getByRole("application", { name: "3D campus view" })).toBeFocused();
}

const HALF = 14; // CAMPUS_BOUNDS half extent
const MAX_Y = 3; // CAMPUS_BOUNDS height

test("the canvas is the first Tab stop after the top bar, named and described for assistive tech", async ({
  page,
}) => {
  await open(page);
  const order = await page.evaluate(() => {
    const bar = document.querySelector("[data-testid=slot-top-bar]")!;
    const canvas = document.querySelector("canvas")!;
    return bar.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING;
  });
  expect(order).toBeTruthy();
  await focusCanvas(page);
  const canvas = page.getByRole("application", { name: "3D campus view" });
  await expect(canvas).toHaveAttribute("tabindex", "0");
  const describedBy = await canvas.getAttribute("aria-describedby");
  await expect(page.locator(`#${describedBy}`)).toHaveText(
    "Arrow keys pan, plus and minus zoom, Q and E rotate, 0 returns home, P switches perspective.",
  );
  // The next Tab stop is the dev menu, so the canvas does not trap focus.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: /^Camera/ })).toBeFocused();
});

test("keyboard focus shows four cyan corner brackets round the safe area, not the viewport ring", async ({
  page,
}) => {
  await open(page);
  const brackets = page.getByTestId("focus-brackets");
  await expect(brackets).toHaveCSS("opacity", "0");
  await focusCanvas(page);
  await expect(brackets).toHaveCSS("opacity", "1");
  await expect(page.getByRole("application")).toHaveCSS("outline-style", "none");
  const corners = brackets.locator("span");
  await expect(corners).toHaveCount(4);
  for (let i = 0; i < 4; i++) {
    await expect(corners.nth(i)).toHaveCSS("border-top-color", /./);
  }
  const safe = await page.getByTestId("safe-area").boundingBox();
  const frame = await brackets.boundingBox();
  expect(frame).toEqual(safe);
  const colours = await corners.evaluateAll((els) =>
    els.map((el) => {
      const s = getComputedStyle(el);
      return [s.borderTopColor, s.borderBottomColor, s.borderLeftColor, s.borderRightColor];
    }),
  );
  expect(colours.flat()).toContain("rgb(34, 211, 238)");
  // Leaving the canvas hides them again.
  await page.keyboard.press("Tab");
  await expect(brackets).toHaveCSS("opacity", "0");
});

test("a mouse click on the canvas does not show the keyboard brackets", async ({ page }) => {
  await open(page);
  // A free spot on the canvas: no panel, no Glide test button, no cube.
  await page.mouse.click(300, 400);
  await expect(page.getByRole("application", { name: "3D campus view" })).toBeFocused();
  await expect(page.getByTestId("focus-brackets")).toHaveCSS("opacity", "0");
});

// The smallest supported window (docs/PLAN.md:497): home frames the whole campus in the safe area.
for (const projection of ["orthographic", "perspective"]) {
  test(`home frames all eight campus corners inside the safe area at 1280x720 (${projection})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page);
    await focusCanvas(page);
    if (projection === "perspective") {
      await page.keyboard.press("p");
      await expect.poll(async () => (await camera(page)).projection).toBe("perspective");
    }
    await page.keyboard.press("+");
    await settled(page);
    await page.keyboard.press("0");
    await settled(page);
    const safe = (await page.getByTestId("safe-area").boundingBox())!;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        for (const y of [0, MAX_Y]) {
          const p = await project(page, [sx * HALF, y, sz * HALF]);
          expect(p.x).toBeGreaterThan(safe.x);
          expect(p.x).toBeLessThan(safe.x + safe.width);
          expect(p.y).toBeGreaterThan(safe.y);
          expect(p.y).toBeLessThan(safe.y + safe.height);
        }
      }
    }
  });
}

test("each camera key moves the camera and it stays in bounds", async ({ page }) => {
  await open(page);
  await focusCanvas(page);
  const start = await camera(page);

  await page.keyboard.press("ArrowRight");
  await settled(page);
  const right = await camera(page);
  expect(right.target).not.toEqual(start.target);

  await page.keyboard.press("+");
  await settled(page);
  const zoomed = await camera(page);
  expect(zoomed.zoom).toBeCloseTo(right.zoom * 1.25, 3);
  await page.keyboard.press("-");
  await settled(page);
  expect((await camera(page)).zoom).toBeCloseTo(right.zoom, 3);
  await page.keyboard.press("=");
  await settled(page);
  expect((await camera(page)).zoom).toBeCloseTo(right.zoom * 1.25, 3);

  await page.keyboard.press("q");
  await settled(page);
  const q = await camera(page);
  expect(q.azimuth - right.azimuth).toBeCloseTo(Math.PI / 4, 3);
  await page.keyboard.press("e");
  await settled(page);
  expect((await camera(page)).azimuth).toBeCloseTo(right.azimuth, 3);

  await page.keyboard.press("0");
  await settled(page);
  const home = await camera(page);
  expect(home.zoom).toBeLessThan(zoomed.zoom);
  expect(home.azimuth).toBeCloseTo(Math.PI / 4, 3);
  const safe = (await page.getByTestId("safe-area").boundingBox())!;
  const origin = await project(page, [0, 0, 0]);
  expect(origin.x).toBeCloseTo(safe.x + safe.width / 2, 0);
  expect(origin.y).toBeCloseTo(safe.y + safe.height / 2, 0);

  await page.keyboard.press("ArrowLeft");
  await settled(page);
  await page.keyboard.press("Home");
  await settled(page);
  expect((await camera(page)).zoom).toBeCloseTo(home.zoom, 3);

  await page.keyboard.press("p");
  await expect.poll(async () => (await camera(page)).projection).toBe("perspective");
  await page.keyboard.press("P");
  await expect.poll(async () => (await camera(page)).projection).toBe("orthographic");

  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
  for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowRight");
  for (let i = 0; i < 12; i++) await page.keyboard.press("+");
  await settled(page);
  const end = await camera(page);
  expect(Math.abs(end.target[0])).toBeLessThanOrEqual(HALF + 1e-6);
  expect(Math.abs(end.target[2])).toBeLessThanOrEqual(HALF + 1e-6);
  expect(end.zoom).toBeLessThanOrEqual(240 + 1e-6);
});

test("camera keys do nothing unless the canvas has focus", async ({ page }) => {
  await open(page);
  await focusCanvas(page);
  await page.keyboard.press("Tab"); // on the dev menu button now
  const before = await camera(page);
  for (const key of ["ArrowRight", "+", "q", "0", "p"]) await page.keyboard.press(key);
  await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  expect(await camera(page)).toEqual(before);
});

test("a key press counts as input for calm mode", async ({ page }) => {
  await open(page);
  const mode = () => page.evaluate("window.__sceneDev.stats().mode") as Promise<string>;
  await expect.poll(mode, { timeout: 15_000 }).toBe("calm");
  await focusCanvas(page);
  await expect.poll(mode).toBe("active");
  await expect.poll(mode, { timeout: 15_000 }).toBe("calm");
  await page.keyboard.press("ArrowRight");
  await expect.poll(mode).toBe("active");
});

test("scroll over a corner moves that corner less than a centre zoom would", async ({ page }) => {
  // A ground point that sits near the lower-right corner of the 3D area at the first view.
  const corner: [number, number, number] = [8.93, 0, -0.97];
  const shift = async (cursor: (c: { x: number; y: number }) => { x: number; y: number }) => {
    await open(page);
    const before = await project(page, corner);
    const at = cursor(before);
    await page.mouse.move(at.x, at.y);
    await page.mouse.wheel(0, -300);
    await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(80);
    const after = await project(page, corner);
    return Math.hypot(after.x - before.x, after.y - before.y);
  };
  const overCorner = await shift((c) => c);
  const overCentre = await shift(() => ({ x: 640, y: 360 }));
  expect(overCentre).toBeGreaterThan(20);
  expect(overCorner).toBeLessThan(overCentre / 2);
  expect(overCorner).toBeLessThan(3);
});

test("a double-click on empty ground glides home, on the cube it does not", async ({ page }) => {
  await open(page);
  // Move away from home first: zoom in at the cursor, then pan a little.
  await page.mouse.move(640, 360);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(90);
  const away = await camera(page);

  const cube = await project(page, [0, 0.8, 0]);
  await page.mouse.dblclick(cube.x, cube.y);
  await page.evaluate("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  expect((await camera(page)).animating).toBe(false);
  expect((await camera(page)).zoom).toBeCloseTo(away.zoom, 6);

  await page.mouse.dblclick(800, 560);
  await settled(page);
  const home = await camera(page);
  expect(home.zoom).toBeLessThan(away.zoom);
  const safe = (await page.getByTestId("safe-area").boundingBox())!;
  const origin = await project(page, [0, 0, 0]);
  expect(origin.x).toBeCloseTo(safe.x + safe.width / 2, 0);
  expect(origin.y).toBeCloseTo(safe.y + safe.height / 2, 0);
});

test("left-drag pans, right-drag rotates and the context menu is suppressed", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const w = window as unknown as { __ctx: boolean[] };
    w.__ctx = [];
    window.addEventListener("contextmenu", (e) => w.__ctx.push(e.defaultPrevented));
  });
  const start = await camera(page);
  await page.mouse.move(700, 480);
  await page.mouse.down();
  await page.mouse.move(800, 480, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await camera(page)).target[0]).not.toBe(start.target[0]);
  const panned = await camera(page);
  expect(panned.azimuth).toBeCloseTo(start.azimuth, 6);

  await page.mouse.move(700, 480);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(790, 480, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await expect.poll(async () => (await camera(page)).azimuth).not.toBeCloseTo(start.azimuth, 3);
  const ctx = await page.evaluate(() => (window as unknown as { __ctx: boolean[] }).__ctx);
  expect(ctx.length).toBeGreaterThan(0);
  expect(ctx.every(Boolean)).toBe(true);
});

for (const projection of ["orthographic", "perspective"]) {
  test(`the camera cannot leave the bounds by dragging or zooming, in ${projection}`, async ({
    page,
  }) => {
    // CI SwiftShader makes every input round trip slow.
    test.slow();
    await open(page);
    await focusCanvas(page);
    if (projection === "perspective") {
      await page.keyboard.press("p");
      await expect.poll(async () => (await camera(page)).projection).toBe("perspective");
    }
    for (const [dx, dy] of [
      [-600, -300],
      [-600, -300],
      [600, 300],
      [600, 300],
      [-600, 300],
      [-600, 300],
    ]) {
      await page.mouse.move(640, 360);
      await page.mouse.down();
      await page.mouse.move(640 + dx, 360 + dy, { steps: 4 });
      await page.mouse.up();
      // Checked per drag: opposite drags cancel and ortho pans slowly, so only the repeated drags show a missing clamp.
      await page.evaluate(
        "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
      );
      const dragged = (await camera(page)).target;
      expect(Math.abs(dragged[0])).toBeLessThanOrEqual(HALF + 1e-6);
      expect(Math.abs(dragged[2])).toBeLessThanOrEqual(HALF + 1e-6);
    }
    // The last drag's damping tail ends with no later input, so only the per-frame clamp holds it.
    await camerasStill(page);
    const tail = (await camera(page)).target;
    expect(Math.abs(tail[0])).toBeLessThanOrEqual(HALF + 1e-6);
    expect(Math.abs(tail[2])).toBeLessThanOrEqual(HALF + 1e-6);
    // The rig clamps what the camera hook reports, so the zoom is measured on the drawn camera:
    // pixels per world unit at the target along the screen's right axis.
    const drawnZoom = async () => {
      const { target, azimuth } = await camera(page);
      const at = await project(page, target);
      const right = await project(page, [
        target[0] + Math.cos(azimuth),
        target[1],
        target[2] - Math.sin(azimuth),
      ]);
      return Math.hypot(right.x - at.x, right.y - at.y);
    };
    await page.mouse.move(640, 300);
    for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -500);
    await camerasStill(page);
    const view = await camera(page);
    expect(Math.abs(view.target[0])).toBeLessThanOrEqual(HALF + 1e-6);
    expect(Math.abs(view.target[2])).toBeLessThanOrEqual(HALF + 1e-6);
    expect(view.zoom).toBeLessThanOrEqual(240 + 1e-6);
    expect(await drawnZoom()).toBeLessThanOrEqual(240 + 1e-3);
    for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 500);
    await camerasStill(page);
    expect((await camera(page)).zoom).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(await drawnZoom()).toBeGreaterThanOrEqual(10 - 1e-3);
  });
}

test("the dev menu glide reaches its target in about 600 ms and a drag cancels it", async ({
  page,
}) => {
  await open(page);
  const elapsed = await page.evaluate(async () => {
    const hooks = (window as unknown as { __sceneDev: Hooks }).__sceneDev;
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Glide test",
    )!;
    const t0 = performance.now();
    button.click();
    await new Promise<void>((resolve) => {
      const tick = () => (hooks.camera().animating ? requestAnimationFrame(tick) : resolve());
      tick();
    });
    return performance.now() - t0;
  });
  expect(elapsed).toBeGreaterThan(550);
  expect(elapsed).toBeLessThan(1100);
  const reached = await camera(page);
  expect(reached.zoom).toBeCloseTo(140, 3);
  const safe = (await page.getByTestId("safe-area").boundingBox())!;
  const spot = await project(page, [8, 0, -6]);
  expect(spot.x).toBeCloseTo(safe.x + safe.width / 2, 0);
  expect(spot.y).toBeCloseTo(safe.y + safe.height / 2, 0);

  // Back towards home, then a press on the canvas in the same task, so a slow machine cannot
  // let the glide finish first.
  const cancelled = await page.evaluate(() => {
    const hooks = (window as unknown as { __sceneDev: Hooks }).__sceneDev;
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Glide test",
    )!;
    button.click();
    const running = hooks.camera().animating;
    document.querySelector("canvas")!.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 700,
        clientY: 450,
        bubbles: true,
      }),
    );
    return { running, stopped: !hooks.camera().animating, zoom: hooks.camera().zoom };
  });
  expect(cancelled.running).toBe(true);
  expect(cancelled.stopped).toBe(true);
  expect(cancelled.zoom).toBeGreaterThan(80);
});

test("the dev camera section collapses and keeps the projection and right-panel toggles", async ({
  page,
}) => {
  await open(page);
  const header = page.getByRole("button", { name: /^Camera/ });
  await expect(header).toHaveAttribute("aria-expanded", "true");
  for (const name of ["Glide test", "Switch to perspective", "Show right panel"]) {
    await expect(page.getByRole("button", { name })).toBeVisible();
  }
  await header.click();
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("button", { name: "Glide test" })).toHaveCount(0);
  await header.click();
  await expect(page.getByRole("button", { name: "Glide test" })).toBeVisible();
});

test("opening the right panel during a glide ends with the target inside the new safe area", async ({
  page,
}) => {
  await open(page);
  // Both clicks in one task: the glide is certainly still running when the panel opens.
  const running = await page.evaluate(() => {
    const hooks = (window as unknown as { __sceneDev: Hooks }).__sceneDev;
    const click = (name: string) =>
      [...document.querySelectorAll("button")].find((b) => b.textContent === name)!.click();
    click("Glide test");
    click("Show right panel");
    return hooks.camera().animating;
  });
  expect(running).toBe(true);
  await expect(page.getByTestId("slot-right-panel")).toBeVisible();
  await settled(page);
  const safe = (await page.getByTestId("safe-area").boundingBox())!;
  const spot = await project(page, [8, 0, -6]);
  expect(spot.x).toBeGreaterThan(safe.x);
  expect(spot.x).toBeLessThan(safe.x + safe.width);
  expect(spot.y).toBeGreaterThan(safe.y);
  expect(spot.y).toBeLessThan(safe.y + safe.height);
  expect(spot.x).toBeCloseTo(safe.x + safe.width / 2, 0);
  expect(spot.y).toBeCloseTo(safe.y + safe.height / 2, 0);
});

test.describe("with reduced motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("glides and key steps are instant cuts", async ({ page }) => {
    await open(page);
    await focusCanvas(page);
    await page.keyboard.press("+");
    let view = await camera(page);
    expect(view.animating).toBe(false);
    expect(view.zoom).toBeCloseTo(100, 3);
    await page.keyboard.press("0");
    view = await camera(page);
    expect(view.animating).toBe(false);
    expect(view.zoom).toBeLessThan(40);

    await page.getByRole("button", { name: "Glide test" }).click();
    view = await camera(page);
    expect(view.animating).toBe(false);
    expect(view.zoom).toBeCloseTo(140, 3);
  });

  test("damping is off: the camera stops when the pointer does", async ({ page }) => {
    await open(page);
    await page.mouse.move(700, 480);
    await page.mouse.down();
    await page.mouse.move(800, 480, { steps: 4 });
    await page.mouse.up();
    const atRelease = await camera(page);
    await page.evaluate(
      "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))))",
    );
    expect((await camera(page)).target).toEqual(atRelease.target);
  });
});

test("damping eases a drag to a stop when motion is not reduced", async ({ page }) => {
  await open(page);
  await page.mouse.move(700, 480);
  await page.mouse.down();
  await page.mouse.move(900, 480, { steps: 2 });
  const held = await camera(page);
  await page.mouse.up();
  const atRelease = await camera(page);
  expect(atRelease.target).toBeDefined();
  await expect.poll(async () => (await camera(page)).target[0] !== atRelease.target[0]).toBe(true);
  expect(held).toBeDefined();
});
