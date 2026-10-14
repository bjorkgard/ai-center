import { afterEach, expect, test, vi } from "vite-plus/test";
import { loadParams, parseParams } from "./params.ts";

afterEach(() => vi.restoreAllMocks());

test("no parameters gives the defaults and no warnings", () => {
  expect(parseParams("")).toEqual({
    params: {
      dev: false,
      webgl: true,
      calm: true,
      view: "home",
      source: null,
      scenario: null,
      seed: 1,
      freeze: false,
    },
    warnings: [],
  });
});

test("every key parses its allowed values", () => {
  const { params, warnings } = parseParams(
    "?dev=1&webgl=0&calm=0&view=lookdev&source=mock&scenario=steady&seed=42&freeze=1",
  );
  expect(warnings).toEqual([]);
  expect(params).toEqual({
    dev: true,
    webgl: false,
    calm: false,
    view: "lookdev",
    source: "mock",
    scenario: "steady",
    seed: 42,
    freeze: true,
  });
});

test("view=home is accepted", () => {
  expect(parseParams("?view=home")).toMatchObject({ params: { view: "home" }, warnings: [] });
});

test("junk in each key falls back and the warning names that key", () => {
  const cases: [string, string, unknown][] = [
    ["dev", "2", false],
    ["webgl", "yes", true],
    ["calm", "no", true],
    ["freeze", "true", false],
    ["view", "foo", "home"],
    ["source", "a b!", null],
    ["scenario", "x".repeat(40), null],
    ["seed", "-3", 1],
  ];
  for (const [key, bad, fallback] of cases) {
    const { params, warnings } = parseParams(`?${key}=${encodeURIComponent(bad)}`);
    expect(params[key as keyof typeof params]).toBe(fallback);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(key);
  }
});

test("an empty value is junk, and unknown keys are ignored silently", () => {
  const { warnings } = parseParams("?dev=&unknown=1");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("dev");
});

test("Object.prototype names are not treated as allowed values", () => {
  expect(parseParams("?dev=constructor").warnings).toHaveLength(1);
});

test("loadParams emits exactly one console.warn per bad value", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  loadParams("?dev=1&seed=x&view=bar");
  expect(warn).toHaveBeenCalledTimes(2);
  const text = warn.mock.calls.map((c) => String(c[0]));
  expect(text.some((t) => t.includes("seed"))).toBe(true);
  expect(text.some((t) => t.includes("view"))).toBe(true);
  warn.mockClear();
  loadParams("?dev=1");
  expect(warn).not.toHaveBeenCalled();
});

test("calm=1 and dev=0 are the defaults and do not warn", () => {
  expect(parseParams("?calm=1&dev=0")).toMatchObject({
    params: { calm: true, dev: false },
    warnings: [],
  });
});
