import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { STATUS_ORDER } from "./materials.ts";
import { FAKE_PROJECTS, HERO_MIX, createFakeSignals, heroStatus } from "./fake.ts";
import { RACK_SLOTS } from "./hall/rackLayout.ts";

const HALLS = 12;

test("the hero mix is 60% tool, 25% thinking, 10% idle, 5% waiting, and never an error", () => {
  expect(HERO_MIX).toEqual([
    ["tool", 0.6],
    ["thinking", 0.25],
    ["idle", 0.1],
    ["waiting_user", 0.05],
  ]);
  const counts: Record<string, number> = {};
  const draws = 20_000;
  for (let i = 0; i < draws; i++) {
    const status = heroStatus((i + 0.5) / draws);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  expect(counts.tool / draws).toBeCloseTo(0.6, 2);
  expect(counts.thinking / draws).toBeCloseTo(0.25, 2);
  expect(counts.idle / draws).toBeCloseTo(0.1, 2);
  expect(counts.waiting_user / draws).toBeCloseTo(0.05, 2);
  expect(counts.error).toBeUndefined();
  expect(heroStatus(0.9999999)).toBe("waiting_user");
});

test("the seeded load over every hall and rack follows the hero mix, with 0-6 lit blades", () => {
  const signals = createFakeSignals({ seed: 1, now: () => 0 });
  const counts: Record<string, number> = {};
  let total = 0;
  let lit = 0;
  for (let hall = 0; hall < HALLS; hall++) {
    for (let rack = 0; rack < RACK_SLOTS; rack++) {
      const load = signals.ledLoad(hall, rack);
      counts[load.status] = (counts[load.status] ?? 0) + 1;
      total++;
      expect(load.blades.length).toBeGreaterThanOrEqual(0);
      expect(load.blades.length).toBeLessThanOrEqual(6);
      for (const blade of load.blades) {
        expect(STATUS_ORDER).toContain(blade);
        expect(blade).not.toBe("error");
      }
      expect(load.load).toBeGreaterThan(0);
      expect(load.load).toBeLessThanOrEqual(1);
      lit += load.blades.length;
    }
  }
  expect(total).toBe(192);
  // 192 racks: tool near 115, thinking near 48, idle near 19, waiting near 10 (loose bounds).
  expect(counts.tool).toBeGreaterThan(90);
  expect(counts.tool).toBeLessThan(140);
  expect(counts.thinking).toBeGreaterThan(30);
  expect(counts.idle).toBeGreaterThan(5);
  expect(counts.error).toBeUndefined();
  expect(lit / total).toBeGreaterThan(1.5);
});

test("the same seed gives the same load, another seed a different one", () => {
  const a = createFakeSignals({ seed: 1, now: () => 0 });
  const b = createFakeSignals({ seed: 1, now: () => 50 });
  const c = createFakeSignals({ seed: 2, now: () => 0 });
  const read = (s: typeof a) =>
    Array.from({ length: 16 }, (_, rack) => JSON.stringify(s.ledLoad(3, rack)));
  expect(read(a)).toEqual(read(b));
  expect(read(a)).not.toEqual(read(c));
});

test("ledLoad returns the same object on every read, so the frame loop allocates nothing", () => {
  const signals = createFakeSignals({ seed: 1, now: () => 0 });
  expect(signals.ledLoad(0, 4)).toBe(signals.ledLoad(0, 4));
  // Out of range reads are clamped to an idle rack, not undefined.
  expect(signals.ledLoad(99, 99).status).toBe("idle");
  expect(signals.ledLoad(-1, -1).blades).toHaveLength(0);
});

test("the rack count is a closed form in scene time and seed, within 0-16", () => {
  let time = 0;
  const signals = createFakeSignals({ seed: 5, now: () => time });
  const seen = new Set<number>();
  for (time = 0; time < 400; time += 3) {
    const count = signals.rackCount(2);
    expect(Number.isInteger(count) && count >= 0 && count <= 16).toBe(true);
    seen.add(count);
  }
  expect(seen.size).toBeGreaterThan(4);
  time = 61.5;
  const once = signals.rackCount(2);
  const again = createFakeSignals({ seed: 5, now: () => 61.5 }).rackCount(2);
  expect(again).toBe(once);
});

test("a fixed rack count overrides the time-varying one (view=racks)", () => {
  let time = 0;
  const signals = createFakeSignals({ seed: 1, now: () => time, racks: 16 });
  for (time = 0; time < 100; time += 7) expect(signals.rackCount(0)).toBe(16);
});

test("hall signs are fixed fictional names, one per hall slot", () => {
  const signals = createFakeSignals({ seed: 1, now: () => 0 });
  expect(FAKE_PROJECTS).toHaveLength(12);
  expect(new Set(FAKE_PROJECTS).size).toBe(12);
  expect(signals.hallSign(0)).toEqual({ letter: "A", project: "Northwind" });
  expect(signals.hallSign(11).letter).toBe("L");
});

// Whether a source file imports fake.ts, with single or double quotes, as a static import, a
// re-export or a dynamic import.
function importsFake(source: string): boolean {
  return /(?:from\s*|import\s*\(\s*|import\s+)(["'])[^"']*\/fake\.ts\1/.test(source);
}

test("the import scan sees fake.ts in both quote styles and ignores look-alikes", () => {
  expect(importsFake('import { x } from "./fake.ts";')).toBe(true);
  expect(importsFake("import { x } from '../scene/fake.ts';")).toBe(true);
  expect(importsFake("export * from '../fake.ts'")).toBe(true);
  expect(importsFake("const m = await import('./fake.ts')")).toBe(true);
  expect(importsFake('import "./fake.ts"')).toBe(true);
  expect(importsFake('import { x } from "./fakeness.ts";')).toBe(false);
  expect(importsFake('import { x } from "./fake.test.ts";')).toBe(false);
  expect(importsFake("// the fake.ts module")).toBe(false);
});

// The seam (CEO W-RW28): outside tests, only sceneSignals.ts, the one place that picks the
// implementation, imports fake.ts. Every file under src and e2e is scanned.
test("nothing under src or e2e imports fake.ts except sceneSignals.ts and tests", () => {
  const root = join(import.meta.dirname, "..", "..");
  const offenders: string[] = [];
  const scanned: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(path);
      } else if (/\.tsx?$/.test(entry.name)) {
        scanned.push(path);
        const allowed = entry.name === "sceneSignals.ts" || /\.(test|spec)\.tsx?$/.test(entry.name);
        if (!allowed && importsFake(readFileSync(path, "utf8"))) offenders.push(path);
      }
    }
  };
  walk(join(root, "src"));
  walk(join(root, "e2e"));
  expect(scanned.some((p) => p.endsWith("Hall.tsx"))).toBe(true);
  expect(scanned.some((p) => p.includes("/e2e/"))).toBe(true);
  expect(offenders).toEqual([]);
});

test("the fake duty starts at 0.75 at scene time 0 and swells within 0-1", () => {
  let t = 0;
  const signals = createFakeSignals({ seed: 1, now: () => t });
  expect(signals.duty()).toBeCloseTo(0.75, 9);
  for (t = 0; t <= 180; t += 3) {
    expect(signals.duty()).toBeGreaterThanOrEqual(0.5);
    expect(signals.duty()).toBeLessThanOrEqual(1);
  }
});

test("a duty override replaces the fake duty and clamps", () => {
  let forced: number | null = 0.2;
  const signals = createFakeSignals({ seed: 1, now: () => 5, dutyOverride: () => forced });
  expect(signals.duty()).toBe(0.2);
  forced = 7;
  expect(signals.duty()).toBe(1);
  forced = null;
  expect(signals.duty()).not.toBe(1);
});

test("vapour phase is the seeded age (t + offset) mod 6 s: in range, seeded, and 6 s periodic", () => {
  let t = 0;
  const a = createFakeSignals({ seed: 1, now: () => t });
  const b = createFakeSignals({ seed: 1, now: () => t });
  const other = createFakeSignals({ seed: 2, now: () => t });
  let differs = 0;
  for (let i = 0; i < 180; i++) {
    const age = a.vapourPhase(i);
    expect(age).toBeGreaterThanOrEqual(0);
    expect(age).toBeLessThan(6);
    expect(b.vapourPhase(i)).toBe(age);
    if (other.vapourPhase(i) !== age) differs++;
  }
  expect(differs).toBeGreaterThan(150);
  const at0 = a.vapourPhase(7);
  t = 6;
  expect(a.vapourPhase(7)).toBeCloseTo(at0, 9);
  t = 2;
  expect(a.vapourPhase(7)).toBeCloseTo((at0 + 2) % 6, 9);
});

test("a fan turns at the duty's speed, a quarter of it under reduced motion, and keeps going when the duty changes", () => {
  let t = 0;
  let duty: number | null = 1;
  const signals = createFakeSignals({ seed: 1, now: () => t, dutyOverride: () => duty });
  const start = signals.fanAngle(0);
  // Frozen: the same time gives the same angle however often it is read.
  expect(signals.fanAngle(0)).toBe(start);
  for (let k = 1; k <= 20; k++) {
    t = k * 0.1;
    signals.fanAngle(0);
  }
  // 2 s at 0.5 turns a second is one turn.
  expect(signals.fanAngle(0) - start).toBeCloseTo(2 * Math.PI, 6);
  const before = signals.fanAngle(0);
  duty = 0;
  expect(signals.fanAngle(0)).toBe(before);
  t += 1;
  // One second at duty 0: 0.05 turns, still turning.
  expect(signals.fanAngle(0) - before).toBeCloseTo(2 * Math.PI * 0.05, 6);
  const reducedFrom = signals.fanAngle(0, true);
  duty = 1;
  t += 1;
  expect(signals.fanAngle(0, true) - reducedFrom).toBeCloseTo(2 * Math.PI * 0.5 * 0.25, 6);
});

test("fans start at different seeded angles", () => {
  const signals = createFakeSignals({ seed: 1, now: () => 0 });
  expect(new Set([0, 1, 2].map((i) => signals.fanAngle(i))).size).toBe(3);
});
