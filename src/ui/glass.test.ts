import { expect, test } from "vite-plus/test";
import { FALLBACK_ALPHA, glassFill, type Phase, type Weather } from "./glass.ts";

const phases: Phase[] = ["night", "dusk", "day"];
const weathers: Weather[] = ["clear", "heatwave", "monsoon", "storm"];

test("glassFill returns the clear level for every phase and weather but day + heatwave", () => {
  const clear: Record<Phase, number> = { night: 0, dusk: 0.3, day: 0.6 };
  for (const phase of phases) {
    for (const weather of weathers) {
      const want = phase === "day" && weather === "heatwave" ? 0.72 : clear[phase];
      expect(glassFill(phase, weather), `${phase} + ${weather}`).toBe(want);
    }
  }
});

test("the fallback alpha is the solid 85% level", () => {
  expect(FALLBACK_ALPHA).toBe(0.85);
});
