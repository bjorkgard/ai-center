import type { Load } from "./scene.ts";

export type SpikeViewName = "spike-r3f" | "spike-vanilla";

export interface SpikeParams {
  view: SpikeViewName;
  load: Load;
  bloom: 0 | 1;
  pass: 1 | 2 | 3;
  bench: boolean;
  freeze: boolean;
  seed: number;
}

export interface ParsedParams {
  spike: SpikeParams | null;
  warnings: string[];
}

const SPIKE_VIEWS: readonly string[] = ["spike-r3f", "spike-vanilla"];

// Allowlist parser (C12): anything outside it falls back to a default and the
// warning names the parameter. source, scenario and the shots-contract
// parameters are accepted silently; seed and freeze drive the fake store.
export function parseSpikeParams(search: string): ParsedParams {
  const q = new URLSearchParams(search);
  const warnings: string[] = [];
  const view = q.get("view");
  if (view === null || view === "home") return { spike: null, warnings };
  if (!SPIKE_VIEWS.includes(view)) {
    warnings.push(`view="${view}" is not a known view; showing the home page`);
    return { spike: null, warnings };
  }

  const pick = <T extends string | number | boolean>(
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

  const load = pick<Load>("load", { 1: 1, 4: 4 }, 1);
  const bloom = pick<0 | 1>("bloom", { 0: 0, 1: 1 }, 1);
  const pass = pick<1 | 2 | 3>("pass", { 1: 1, 2: 2, 3: 3 }, 1);
  let bench = pick("bench", { 0: false, 1: true }, false);
  const freeze = pick("freeze", { 0: false, 1: true }, false);

  let seed = 1;
  const rawSeed = q.get("seed");
  if (rawSeed !== null) {
    if (/^\d{1,9}$/.test(rawSeed)) seed = Number(rawSeed);
    else warnings.push(`seed="${rawSeed}" is not a whole number; using 1`);
  }

  if (bench && freeze) {
    bench = false;
    warnings.push("bench=1 is refused with freeze=1 (a frozen clock cannot be measured)");
  }

  return {
    spike: { view: view as SpikeViewName, load, bloom, pass, bench, freeze, seed },
    warnings,
  };
}
