import { writeFileSync } from "node:fs";
import { mockEvents } from "../src/data/mock.ts";
import { isScenario, scenarioList } from "../src/data/scenarios.ts";
import { AgentEvent } from "../src/data/schema.ts";

// `vp run mock:dump -- --seed N --scenario steady --minutes M --out <file>` writes the mock's
// normalised events as JSONL, one per line ordered by ts, ties by id, covering M sim minutes from sim
// time 0 (CEO C30). A file, not stdout, so `vp run` output cannot mix in.
const MAX_MINUTES = 1440;
const FLAGS = ["--seed", "--scenario", "--minutes", "--out"] as const;

function fail(message: string): never {
  console.error(`mock-dump: ${message}`);
  process.exit(1);
}

// `vp run mock:dump -- ...` hands the separator on to the script; drop it.
const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
const given = new Map<string, string>();
for (let i = 0; i < argv.length; i += 2) {
  const flag = argv[i];
  if (!(FLAGS as readonly string[]).includes(flag)) fail(`unknown flag ${flag}`);
  if (argv[i + 1] === undefined) fail(`${flag} needs a value`);
  given.set(flag, argv[i + 1]);
}
const value = (flag: string): string => given.get(flag) ?? fail(`${flag} is required`);

const seedText = value("--seed");
if (!/^\d{1,9}$/.test(seedText)) fail(`--seed must be a whole number, got "${seedText}"`);
const minutesText = value("--minutes");
const minutes = Number(minutesText);
if (!/^\d+$/.test(minutesText) || !Number.isSafeInteger(minutes * 60_000) || minutes < 1) {
  fail(`--minutes must be a whole number above 0, got "${minutesText}"`);
}
if (minutes > MAX_MINUTES)
  fail(`--minutes must be at most ${MAX_MINUTES} (one sim day), got ${minutes}`);
const scenario = value("--scenario");
if (!isScenario(scenario)) fail(`unknown scenario "${scenario}" (use ${scenarioList()})`);
const out = value("--out");

const events = mockEvents(Number(seedText), scenario, 0, minutes * 60_000);
for (const event of events) {
  if (!AgentEvent.safeParse(event).success) fail(`the mock made an invalid event ${event.id}`);
}
try {
  writeFileSync(out, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
} catch (error) {
  fail(`--out: cannot write ${out}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
}
console.log(`mock-dump: ${events.length} events to ${out}`);
