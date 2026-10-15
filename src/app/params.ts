import type { Speed } from "../data/clock.ts";
import { isScenario, scenarioList } from "../data/scenarios.ts";

export type ViewName = "home" | "lookdev" | "hall" | "racks" | "cooling" | "power";

export interface AppParams {
  dev: boolean;
  webgl: boolean;
  calm: boolean;
  view: ViewName;
  source: "live" | "mock" | null;
  scenario: string | null;
  speed: Speed;
  seed: number;
  freeze: boolean;
}

export interface ParsedParams {
  params: AppParams;
  warnings: string[];
}

const SEED = /^\d{1,9}$/;

// Allowlist parser (S-RW2): anything outside it falls back to the default and
// the warning names the parameter. Pure; loadParams does the logging.
export function parseParams(search: string): ParsedParams {
  const q = new URLSearchParams(search);
  const warnings: string[] = [];

  const pick = <T extends string | number | boolean | null>(
    name: string,
    allowed: Record<string, T>,
    fallback: T,
  ): T => {
    const raw = q.get(name);
    if (raw === null) return fallback;
    if (Object.hasOwn(allowed, raw)) return allowed[raw];
    warnings.push(
      `${name}="${raw}" is not allowed (use ${Object.keys(allowed).join(" or ")}); using ${String(fallback)}`,
    );
    return fallback;
  };

  const dev = pick("dev", { 0: false, 1: true }, false);
  const webgl = pick("webgl", { 0: false }, true);
  const calm = pick("calm", { 0: false, 1: true }, true);
  const view = pick<ViewName>(
    "view",
    {
      home: "home",
      lookdev: "lookdev",
      hall: "hall",
      racks: "racks",
      cooling: "cooling",
      power: "power",
    },
    "home",
  );
  const freeze = pick("freeze", { 1: true }, false);
  // Live is the default; a frozen page connects nothing unless it asks for a source (C79).
  const source = pick<"live" | "mock" | null>(
    "source",
    { live: "live", mock: "mock" },
    freeze ? null : "live",
  );
  const speed = pick<Speed>("speed", { 1: 1, 10: 10, 60: 60 }, 1);
  let scenario: string | null = source === "mock" ? "steady" : null;
  const rawScenario = q.get("scenario");
  if (rawScenario !== null) {
    if (isScenario(rawScenario)) scenario = rawScenario;
    else {
      warnings.push(
        `scenario="${rawScenario}" is not allowed (use ${scenarioList()}); using steady`,
      );
      scenario = "steady";
    }
  }
  // Both only mean something to the mock (C52).
  for (const name of ["scenario", "speed"]) {
    if (q.has(name) && source !== "mock") warnings.push(`${name} is ignored without source=mock`);
  }

  let seed = 1;
  const rawSeed = q.get("seed");
  if (rawSeed !== null) {
    if (SEED.test(rawSeed)) seed = Number(rawSeed);
    else warnings.push(`seed="${rawSeed}" is not a whole number; using 1`);
  }

  return { params: { dev, webgl, calm, view, source, scenario, speed, seed, freeze }, warnings };
}

export function loadParams(search: string): AppParams {
  const { params, warnings } = parseParams(search);
  for (const w of warnings) console.warn(`[params] ${w}`);
  return params;
}
