import { expect, test } from "vite-plus/test";
import { parseSpikeParams } from "./params.ts";

test("no view means the home page, silently", () => {
  expect(parseSpikeParams("")).toEqual({ spike: null, warnings: [] });
  expect(parseSpikeParams("?view=home&load=9")).toEqual({ spike: null, warnings: [] });
});

test("a spike view with defaults: load 1, bloom 1, pass 1, no bench", () => {
  const { spike, warnings } = parseSpikeParams("?view=spike-r3f");
  expect(warnings).toEqual([]);
  expect(spike).toEqual({
    view: "spike-r3f",
    load: 1,
    bloom: 1,
    pass: 1,
    bench: false,
    freeze: false,
    seed: 1,
  });
});

test("all parameters parse", () => {
  const { spike, warnings } = parseSpikeParams(
    "?view=spike-vanilla&load=4&bench=1&bloom=0&pass=3&seed=42",
  );
  expect(warnings).toEqual([]);
  expect(spike).toMatchObject({
    view: "spike-vanilla",
    load: 4,
    bench: true,
    bloom: 0,
    pass: 3,
    seed: 42,
  });
});

test("the shots contract parameters are accepted without warnings", () => {
  const { spike, warnings } = parseSpikeParams(
    "?source=mock&scenario=steady&seed=1&freeze=1&view=spike-r3f",
  );
  expect(warnings).toEqual([]);
  expect(spike).toMatchObject({ view: "spike-r3f", seed: 1, freeze: true, bench: false });
});

test("an unknown view falls back to home and the warning names view", () => {
  const { spike, warnings } = parseSpikeParams("?view=foo");
  expect(spike).toBeNull();
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("view");
});

test("load other than 1 or 4 falls back to 1 and the warning names load", () => {
  for (const bad of ["2", "999999", "0", "abc", ""]) {
    const { spike, warnings } = parseSpikeParams(`?view=spike-r3f&load=${bad}`);
    expect(spike?.load).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("load");
  }
});

test("a malformed bench falls back to off and the warning names bench", () => {
  for (const bad of ["yes", "2", "true", ""]) {
    const { spike, warnings } = parseSpikeParams(`?view=spike-r3f&bench=${bad}`);
    expect(spike?.bench).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("bench");
  }
});

test("bad bloom, pass, seed and freeze fall back with a warning naming each", () => {
  const { spike, warnings } = parseSpikeParams(
    "?view=spike-r3f&bloom=2&pass=4&seed=x&freeze=maybe",
  );
  expect(spike).toMatchObject({ bloom: 1, pass: 1, seed: 1, freeze: false });
  expect(warnings).toHaveLength(4);
  for (const name of ["bloom", "pass", "seed", "freeze"]) {
    expect(warnings.some((w) => w.includes(name))).toBe(true);
  }
});

test("bench=1 together with freeze=1 is refused with a warning", () => {
  const { spike, warnings } = parseSpikeParams("?view=spike-r3f&bench=1&freeze=1");
  expect(spike).toMatchObject({ bench: false, freeze: true });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("bench");
  expect(warnings[0]).toContain("freeze");
});
