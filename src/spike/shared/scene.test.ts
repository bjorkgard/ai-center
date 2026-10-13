import { expect, test } from "vite-plus/test";
import {
  BASE_HALLS,
  MAX_HALLS,
  fillLedMatrices,
  fillRackMatrices,
  hallOrigin,
  ledsPerHall,
  racksPerHall,
  sceneCounts,
} from "./scene.ts";

test("load 1 draws 12 halls, 192 racks and 3,072 LEDs", () => {
  expect(BASE_HALLS).toBe(12);
  expect(sceneCounts(1)).toEqual({ halls: 12, racks: 192, leds: 3072 });
});

test("load 4 draws 12 halls, 768 racks and 12,288 LEDs", () => {
  expect(sceneCounts(4)).toEqual({ halls: 12, racks: 768, leds: 12288 });
});

test("per hall counts are 16 racks and 256 LEDs at 1x, 64 and 1,024 at 4x", () => {
  expect([racksPerHall(1), ledsPerHall(1)]).toEqual([16, 256]);
  expect([racksPerHall(4), ledsPerHall(4)]).toEqual([64, 1024]);
});

test("churn can grow the scene to 18 halls", () => {
  expect(MAX_HALLS).toBe(18);
  expect(sceneCounts(1, MAX_HALLS)).toEqual({ halls: 18, racks: 288, leds: 4608 });
});

test("hall origins are distinct for all 18 halls", () => {
  for (const load of [1, 4] as const) {
    const keys = new Set<string>();
    for (let i = 0; i < MAX_HALLS; i++) {
      const o = hallOrigin(i, load);
      keys.add(`${o.x},${o.z}`);
    }
    expect(keys.size).toBe(MAX_HALLS);
  }
});

test("rack and LED matrices fill the whole buffer with distinct finite positions", () => {
  for (const load of [1, 4] as const) {
    const racks = new Float32Array(racksPerHall(load) * 16);
    const leds = new Float32Array(ledsPerHall(load) * 16);
    fillRackMatrices(racks, load);
    fillLedMatrices(leds, load);
    for (const [buffer, count] of [
      [racks, racksPerHall(load)],
      [leds, ledsPerHall(load)],
    ] as const) {
      const positions = new Set<string>();
      for (let i = 0; i < count; i++) {
        const m = buffer.subarray(i * 16, i * 16 + 16);
        expect(m.every(Number.isFinite)).toBe(true);
        expect(m[15]).toBe(1);
        positions.add(`${m[12]},${m[13]},${m[14]}`);
      }
      expect(positions.size).toBe(count);
    }
  }
});
