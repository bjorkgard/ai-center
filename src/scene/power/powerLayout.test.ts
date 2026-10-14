import { expect, test } from "vite-plus/test";
import { ZONES, type Rect } from "../campus/layout.ts";
import { POWER_FRAMING, TANKS, TRANSFORMERS, VAULT, powerFootprints } from "./powerLayout.ts";

const overlap = (a: Rect, b: Rect) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
const inside = (r: Rect, outer: Rect) =>
  r.minX >= outer.minX && r.maxX <= outer.maxX && r.minZ >= outer.minZ && r.maxZ <= outer.maxZ;

test("every power part stands inside the power zone, none overlapping another", () => {
  const { yard, vault, transformers, generators, tanks } = powerFootprints();
  expect(transformers).toHaveLength(3);
  expect(generators).toHaveLength(3);
  expect(tanks).toHaveLength(TANKS.length);
  const standalone = [yard, vault, ...generators, ...tanks];
  for (const r of [...standalone, ...transformers]) expect(inside(r, ZONES.power)).toBe(true);
  standalone.forEach((a, i) =>
    standalone.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false)),
  );
  // The transformers stand inside the fenced yard, apart from each other.
  for (const t of transformers) expect(inside(t, yard)).toBe(true);
  transformers.forEach((a, i) =>
    transformers.slice(i + 1).forEach((b) => expect(overlap(a, b)).toBe(false)),
  );
  expect(TRANSFORMERS).toHaveLength(3);
});

test("the vault sits on the axis of the road in front of hall row 0, at the east edge of the power zone", () => {
  // The first road row (z 12-15, centre 13.5) starts at x = -26; the vault's east face is just
  // short of it.
  expect(VAULT.z).toBeCloseTo(13.5, 9);
  expect(VAULT.x + VAULT.width / 2).toBeLessThan(-26);
  expect(VAULT.x + VAULT.width / 2).toBeGreaterThan(-30);
});

test("the power view is framed on the power zone and the road beyond its vault", () => {
  const [x, , z] = POWER_FRAMING.target;
  expect(x).toBeGreaterThan(ZONES.power.minX);
  expect(x).toBeLessThan(ZONES.power.maxX);
  expect(z).toBeGreaterThan(ZONES.power.minZ);
  expect(z).toBeLessThan(ZONES.power.maxZ);
  // The vault is in the half of the frame the fibre leaves towards.
  expect(VAULT.x).toBeGreaterThan(x);
});
