import { afterEach, expect, test, vi } from "vite-plus/test";
import { SIGN_SLOTS } from "./hallLayout.ts";
import { SIGN_FONT_TIMEOUT_MS, SignAtlasError, createSignAtlas } from "./signAtlas.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface Drawn {
  text: string;
  style: string;
  font: string;
}

// A canvas whose 2D context records what it is asked to draw; text is 10 px a character.
function fakeCanvas(context = true) {
  const drawn: Drawn[] = [];
  const rects: { kind: string; x: number; y: number; w: number; h: number }[] = [];
  const ctx = {
    fillStyle: "",
    font: "",
    textBaseline: "",
    textAlign: "",
    measureText: (text: string) => ({ width: text.length * 10 }),
    fillText(text: string) {
      drawn.push({ text, style: String(this.fillStyle), font: this.font });
    },
    fillRect: (x: number, y: number, w: number, h: number) =>
      rects.push({ kind: "fill", x, y, w, h }),
    clearRect: (x: number, y: number, w: number, h: number) =>
      rects.push({ kind: "clear", x, y, w, h }),
    save() {},
    restore() {},
    beginPath() {},
    rect() {},
    clip() {},
  };
  const canvas = { width: 0, height: 0, getContext: () => (context ? ctx : null) };
  return { canvas, drawn, rects };
}

function deps(load: () => Promise<unknown>, context = true) {
  const fake = fakeCanvas(context);
  return { fake, deps: { createCanvas: () => fake.canvas as never, fonts: { load } } };
}

test("a font that loads before the first sign is drawn once, with Geist and no warning", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { fake, deps: d } = deps(() => Promise.resolve([]));
  const atlas = createSignAtlas(d);
  await atlas.ready;
  expect(atlas.isReady).toBe(true);
  atlas.setSign(0, "A", "Northwind");
  const texts = fake.drawn.map((t) => t.text);
  expect(texts).toContain("A");
  expect(texts).toContain("Northwind");
  expect(fake.drawn.every((t) => t.font.includes("Geist"))).toBe(true);
  expect(warn).not.toHaveBeenCalled();
});

test("signs set before the font loads draw only after it resolves", async () => {
  const resolvers: ((v: unknown) => void)[] = [];
  const { fake, deps: d } = deps(() => new Promise((r) => resolvers.push(r)));
  const atlas = createSignAtlas(d);
  atlas.setSign(2, "C", "Northwind");
  expect(fake.drawn).toHaveLength(0);
  expect(atlas.isReady).toBe(false);
  for (const resolve of resolvers) resolve([]);
  await atlas.ready;
  expect(fake.drawn.map((t) => t.text)).toContain("C");
});

test("a font that never loads draws with the fallback after 3 s and warns once", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { fake, deps: d } = deps(() => new Promise(() => {}));
  const atlas = createSignAtlas(d);
  atlas.setSign(0, "A", "Northwind");
  await vi.advanceTimersByTimeAsync(SIGN_FONT_TIMEOUT_MS - 1);
  expect(atlas.isReady).toBe(false);
  expect(fake.drawn).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1);
  await atlas.ready;
  expect(SIGN_FONT_TIMEOUT_MS).toBe(3000);
  expect(atlas.isReady).toBe(true);
  expect(fake.drawn.map((t) => t.text)).toContain("A");
  atlas.setSign(1, "B", "Contoso");
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toMatch(/^\[scene\] /);
});

test("a rejected font load also falls back with one warning", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { deps: d } = deps(() => Promise.reject(new Error("no font")));
  const atlas = createSignAtlas(d);
  await atlas.ready;
  expect(atlas.isReady).toBe(true);
  expect(warn).toHaveBeenCalledTimes(1);
});

test("a null 2D context throws SignAtlasError", () => {
  const { deps: d } = deps(() => Promise.resolve([]), false);
  expect(() => createSignAtlas(d)).toThrow(SignAtlasError);
});

test("a slot outside 0-11 throws SignAtlasError", async () => {
  const { deps: d } = deps(() => Promise.resolve([]));
  const atlas = createSignAtlas(d);
  await atlas.ready;
  expect(SIGN_SLOTS).toBe(12);
  for (const slot of [-1, 12, 1.5, Number.NaN]) {
    expect(() => atlas.setSign(slot, "A", "x"), String(slot)).toThrow(SignAtlasError);
  }
  expect(() => atlas.rect(12)).toThrow(SignAtlasError);
  expect(() => atlas.setSign(11, "L", "x")).not.toThrow();
});

test("a name wider than the region is cut with an ellipsis, an empty one draws the letter only", async () => {
  const { fake, deps: d } = deps(() => Promise.resolve([]));
  const atlas = createSignAtlas(d);
  await atlas.ready;
  atlas.setSign(0, "A", "A".repeat(200));
  const name = fake.drawn.find((t) => t.text.endsWith("…"));
  expect(name).toBeDefined();
  expect(name!.text.length).toBeLessThan(200);
  fake.drawn.length = 0;
  atlas.setSign(1, "B", "");
  expect(fake.drawn.map((t) => t.text)).toEqual(["B"]);
});

test("a dormant hall reads 'No sessions' in text-3", async () => {
  const { fake, deps: d } = deps(() => Promise.resolve([]));
  const atlas = createSignAtlas(d);
  await atlas.ready;
  atlas.setSign(0, "A", "Northwind", true);
  const line = fake.drawn.find((t) => t.text === "No sessions");
  expect(line?.style.toLowerCase()).toBe("#8a93a6");
  expect(fake.drawn.some((t) => t.text === "Northwind")).toBe(false);
});

test("setSign redraws only its slot's region and keeps the one texture", async () => {
  const { fake, deps: d } = deps(() => Promise.resolve([]));
  const atlas = createSignAtlas(d);
  await atlas.ready;
  const texture = atlas.texture;
  const version = texture.version;
  fake.rects.length = 0;
  atlas.setSign(3, "D", "Northwind");
  const r = atlas.rect(3);
  const region = {
    x: r.col * (fake.canvas.width / 2),
    y: r.row * (fake.canvas.height / 6),
    w: fake.canvas.width / 2,
    h: fake.canvas.height / 6,
  };
  for (const rect of fake.rects) {
    expect(rect.x).toBeGreaterThanOrEqual(region.x);
    expect(rect.y).toBeGreaterThanOrEqual(region.y);
    expect(rect.x + rect.w).toBeLessThanOrEqual(region.x + region.w + 1e-6);
    expect(rect.y + rect.h).toBeLessThanOrEqual(region.y + region.h + 1e-6);
  }
  expect(fake.rects.length).toBeGreaterThan(0);
  expect(atlas.texture).toBe(texture);
  expect(texture.version).toBeGreaterThan(version);
});

test("each slot maps to its own non-overlapping UV rectangle inside 0-1", async () => {
  const { deps: d } = deps(() => Promise.resolve([]));
  const atlas = createSignAtlas(d);
  const seen = new Set<string>();
  for (let slot = 0; slot < SIGN_SLOTS; slot++) {
    const { u, v, w, h } = atlas.rect(slot).uv;
    expect(u).toBeGreaterThanOrEqual(0);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(u + w).toBeLessThanOrEqual(1 + 1e-9);
    expect(v + h).toBeLessThanOrEqual(1 + 1e-9);
    seen.add(`${u},${v}`);
  }
  expect(seen.size).toBe(SIGN_SLOTS);
});
