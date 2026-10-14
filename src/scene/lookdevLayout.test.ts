import { expect, test } from "vite-plus/test";
import { createLookDevSignals } from "./lookdevLayout.ts";
import type { SceneSignals } from "./signals.ts";

const base: SceneSignals = {
  rackCount: () => 4,
  ledLoad: () => ({ status: "tool", blades: ["tool"], load: 0.5, phase: 0.1 }),
  hallSign: () => ({ letter: "A", project: "Northwind" }),
  duty: () => 0.5,
  vapourPhase: () => 1,
  fanAngle: (_, reduced) => (reduced ? 1 : 2),
};

test("the look-dev signals pass reduced motion on to the base fan angle", () => {
  const signals = createLookDevSignals(base);
  expect(signals.fanAngle(0, true)).toBe(1);
  expect(signals.fanAngle(0, false)).toBe(2);
});
