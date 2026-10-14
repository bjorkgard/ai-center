/// <reference lib="dom" />
import { expect, test, type Page } from "@playwright/test";
import { campusHome, slotPosition } from "../src/scene/campus/layout.ts";
import { skipFrameSpecInCiFirefox } from "./ci-skip.ts";

const READY = "window.__sceneReady === true";

test.beforeEach(({ browserName }, testInfo) => skipFrameSpecInCiFirefox(browserName, testInfo));

async function open(page: Page, query = "dev=1&freeze=1") {
  await page.goto(`/?${query}`);
  await page.waitForFunction(READY, undefined, { timeout: 30_000 });
}

interface Stats {
  frames: number;
  sceneCalls: number;
  triangles: number;
  frameErrors: number;
}
const stats = (page: Page) => page.evaluate("window.__sceneDev.stats()") as Promise<Stats>;
// Runs `change`, then waits for a frame drawn after it (a frozen view draws one on demand).
async function afterFrame(page: Page, change: () => Promise<unknown>) {
  const before = (await stats(page)).frames;
  await change();
  await expect
    .poll(async () => (await stats(page)).frames, { timeout: 10_000 })
    .toBeGreaterThan(before);
}
const project = (page: Page, point: readonly [number, number, number]) =>
  page.evaluate(
    (p) =>
      (
        window as unknown as {
          __sceneDev: { project(q: number[]): { x: number; y: number } };
        }
      ).__sceneDev.project(p as number[]),
    [...point],
  );

// The area home and the startup view frame the campus in (decision H1): the canvas minus the top
// bar and the tab strip.
async function homeRect(page: Page) {
  const top = (await page.getByTestId("slot-top-bar").boundingBox())!;
  const tabs = (await page.getByTestId("slot-tab-strip").boundingBox())!;
  const canvas = page.viewportSize()!;
  return {
    x: 0,
    y: top.y + top.height,
    width: canvas.width,
    height: tabs.y - (top.y + top.height),
  };
}

const corners = (placed: number) => {
  const h = campusHome(placed);
  return [h.minX, h.maxX].flatMap((x) =>
    [h.minZ, h.maxZ].flatMap((z) => [0, h.maxY].map((y) => [x, y, z] as const)),
  );
};

// A frozen view at the high tier draws once: its scene call count is the whole frame's.
test("the frozen campus home view draws in under 40 scene calls with shadows on (Chromium)", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the draw-call bar is read in Chromium (CEO W-RW2)");
  await open(page);
  expect(await page.evaluate("window.__sceneDev.state().quality")).toBe("high");
  const s = await stats(page);
  expect(s.sceneCalls).toBeGreaterThan(10);
  expect(s.sceneCalls).toBeLessThan(40);
  expect(s.frameErrors).toBe(0);
  await expect(page.getByTestId("perf-hud").locator('[data-hud="scene calls"]')).toHaveText(
    String(s.sceneCalls),
  );
});

for (const [width, height] of [
  [1280, 720],
  [1920, 1080],
]) {
  test(`the first view frames the placed halls, plant, power and gate inside the home area at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await open(page);
    // No key pressed: this is the startup pose (CEO C25).
    const safe = await homeRect(page);
    await expect
      .poll(async () => {
        const points = await Promise.all(corners(2).map((c) => project(page, c)));
        return points.every(
          (p) =>
            p.x > safe.x && p.x < safe.x + safe.width && p.y > safe.y && p.y < safe.y + safe.height,
        );
      })
      .toBe(true);
  });
}

test("placing a third hall widens the next home, and does not move the camera before it", async ({
  page,
}) => {
  await open(page, "dev=1");
  const camera = () => page.evaluate("window.__sceneDev.camera()") as Promise<{ zoom: number }>;
  const start = await camera();
  await page.evaluate("window.__sceneDev.setPlacedHalls(3)");
  expect((await camera()).zoom).toBe(start.zoom);
  await page.getByRole("application", { name: "3D campus view" }).focus();
  await page.keyboard.press("0");
  await expect
    .poll(async () => (await page.evaluate("window.__sceneDev.camera().animating")) as boolean)
    .toBe(false);
  const wider = await camera();
  expect(wider.zoom).toBeLessThan(start.zoom);
  const safe = await homeRect(page);
  for (const c of corners(3)) {
    const p = await project(page, c);
    expect(p.x).toBeGreaterThan(safe.x);
    expect(p.x).toBeLessThan(safe.x + safe.width);
    expect(p.y).toBeGreaterThan(safe.y);
    expect(p.y).toBeLessThan(safe.y + safe.height);
  }
});

test("the Campus dev section starts collapsed after Racks, and its controls drive the campus", async ({
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
  // Cooling (chunk 09) follows Campus.
  expect(sections.slice(-2)).toEqual(["dev-campus", "dev-cooling"]);
  const header = hud.getByRole("button", { name: /^Campus/ });
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await header.click();

  const slider = hud.getByRole("slider", { name: "Placed halls" });
  await expect(slider).toHaveValue("2");
  await expect(slider).toHaveAttribute("min", "2");
  await expect(slider).toHaveAttribute("max", "12");
  await afterFrame(page, () => slider.fill("4"));
  await expect(slider).toHaveValue("4");
  expect(lines).toContain("[scene] placed halls 2 -> 4");

  // Out of range input clamps and warns, naming the argument.
  await afterFrame(page, () => page.evaluate("window.__sceneDev.setPlacedHalls(99)"));
  await expect(slider).toHaveValue("12");
  expect(warnings.some((w) => w.includes('"n"'))).toBe(true);
  await page.evaluate("window.__sceneDev.setPlacedHalls(0)");
  await expect(slider).toHaveValue("2");
});

test("the waypoint toggle draws the graph as one more call and removes it again", async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "warning") warnings.push(msg.text());
  });
  await open(page);
  const hud = page.getByTestId("perf-hud");
  await hud.getByRole("button", { name: /^Campus/ }).click();
  const toggle = hud.getByRole("button", { name: /^Waypoints/ });
  await expect(toggle).toHaveText("Waypoints off");
  const without = (await stats(page)).sceneCalls;
  await afterFrame(page, () => toggle.click());
  await expect(toggle).toHaveText("Waypoints on");
  expect((await stats(page)).sceneCalls).toBe(without + 1);
  await afterFrame(page, () => page.evaluate("window.__sceneDev.setWaypoints(false)"));
  await expect(toggle).toHaveText("Waypoints off");
  expect((await stats(page)).sceneCalls).toBe(without);
  await page.evaluate("window.__sceneDev.setWaypoints('maybe')");
  expect(warnings.some((w) => w.includes('"on"'))).toBe(true);
});

test("twelve placed halls stay within 150k triangles at the frozen home view", async ({ page }) => {
  await open(page);
  await afterFrame(page, () => page.evaluate("window.__sceneDev.setPlacedHalls(12)"));
  // Every hall shows its racks: the seeded fake count at scene time 0 is part of the frame.
  for (let hall = 0; hall < 12; hall++) {
    await page.evaluate(`window.__sceneDev.setRackCount(${hall}, 16)`);
  }
  await expect
    .poll(async () => (await stats(page)).triangles, { timeout: 10_000 })
    .toBeGreaterThan(40_000);
  const s = await stats(page);
  expect(s.triangles).toBeLessThanOrEqual(150_000);
  expect(s.frameErrors).toBe(0);
  // The hooks and the layout agree on where a twelfth hall stands.
  const last = slotPosition(11);
  const at = await project(page, [last.x, 0, last.z]);
  expect(Number.isFinite(at.x) && Number.isFinite(at.y)).toBe(true);
});
