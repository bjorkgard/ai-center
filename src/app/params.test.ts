import { afterEach, expect, test, vi } from "vite-plus/test";
import { SCENARIO_NAMES } from "../data/scenarios.ts";
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
      speed: 1,
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
    speed: 1,
    seed: 42,
    freeze: true,
  });
});

test("view=cooling is accepted", () => {
  expect(parseParams("?view=cooling")).toMatchObject({
    params: { view: "cooling" },
    warnings: [],
  });
});

test("view=power is accepted", () => {
  expect(parseParams("?view=power")).toMatchObject({
    params: { view: "power" },
    warnings: [],
  });
});

test("view=racks is accepted", () => {
  expect(parseParams("?view=racks")).toMatchObject({ params: { view: "racks" }, warnings: [] });
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
    ["scenario", "x".repeat(40), "steady"],
    ["speed", "5", 1],
    ["seed", "-3", 1],
  ];
  for (const [key, bad, fallback] of cases) {
    const { params, warnings } = parseParams(
      `?${key === "scenario" || key === "speed" ? "source=mock&" : ""}${key}=${encodeURIComponent(bad)}`,
    );
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

test("view=hall is accepted", () => {
  expect(parseParams("?view=hall")).toMatchObject({ params: { view: "hall" }, warnings: [] });
});

test("source=mock and scenario=steady are accepted", () => {
  expect(parseParams("?source=mock&scenario=steady")).toMatchObject({
    params: { source: "mock", scenario: "steady" },
    warnings: [],
  });
});

test("an unknown source warns and falls back to null; scenario and speed are then ignored", () => {
  const { params, warnings } = parseParams("?source=live&scenario=burst");
  expect(params).toMatchObject({ source: null, scenario: "burst" });
  expect(warnings).toHaveLength(2);
  expect(warnings[0]).toContain("source");
  expect(warnings[1]).toContain("scenario");
  expect(warnings[1]).toContain("ignored");
});

test.each(SCENARIO_NAMES)("scenario=%s is accepted with source=mock", (name) => {
  expect(parseParams(`?source=mock&scenario=${name}`)).toMatchObject({
    params: { source: "mock", scenario: name },
    warnings: [],
  });
});

test.each([1, 10, 60])("speed=%i is accepted with source=mock", (speed) => {
  expect(parseParams(`?source=mock&speed=${speed}`)).toMatchObject({
    params: { speed },
    warnings: [],
  });
});

test("an unknown scenario warns naming the valid ones and falls back to steady", () => {
  const { params, warnings } = parseParams("?source=mock&scenario=nope");
  expect(params.scenario).toBe("steady");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("scenario");
  for (const name of SCENARIO_NAMES) expect(warnings[0]).toContain(name);
});

test.each(["0", "2", "100", "fast", "10x"])("speed=%s warns and falls back to 1", (bad) => {
  const { params, warnings } = parseParams(`?source=mock&speed=${bad}`);
  expect(params.speed).toBe(1);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("speed");
});

test("speed and scenario without source=mock warn that they are ignored", () => {
  for (const q of ["?speed=10", "?scenario=burst", "?source=live&speed=10"]) {
    const { warnings } = parseParams(q);
    expect(
      warnings.some((w) => w.includes("ignored without source=mock")),
      q,
    ).toBe(true);
  }
  expect(parseParams("?speed=10&scenario=burst").warnings).toHaveLength(2);
  expect(parseParams("?source=mock&speed=10&scenario=burst").warnings).toEqual([]);
});
