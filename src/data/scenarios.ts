// The mock scenario names (CEO C43, X3; eng E44). A Node-runnable leaf: params, mock:dump, the
// dev Data section, the mock, tests and the README check all read the names from here.
export const SCENARIOS = [
  {
    name: "steady",
    description: "Three projects, seven sessions and three subagents at an even pace",
  },
  { name: "burst", description: "One parent session spawns 10 subagents together, in cycles" },
  {
    name: "churn",
    description: "Projects appear and vanish every 20 s; two idle long enough to retire",
  },
  { name: "overflow", description: "One project grows to 40 sessions, then shrinks back to 8" },
  {
    name: "errors",
    description: "An error storm across several sessions every 5 minutes, then recovery",
  },
  { name: "codex-only", description: "Every session is a Codex session" },
  { name: "waiting", description: "Several sessions end a turn and wait on the user" },
] as const;

export type ScenarioName = (typeof SCENARIOS)[number]["name"];

export const SCENARIO_NAMES: readonly string[] = SCENARIOS.map((s) => s.name);

export const isScenario = (name: string): name is ScenarioName => SCENARIO_NAMES.includes(name);

// For error messages: `steady, burst, ...`.
export const scenarioList = (): string => SCENARIO_NAMES.join(", ");
