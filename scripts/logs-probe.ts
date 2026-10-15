import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { resolveRoots } from "../sidecar/roots.ts";

// `vp run logs:probe -- [--log-root <dir>] [--file <path>] [--json] [--all]` prints the shape of
// the log lines under the log roots the server would watch (PLAN chunk 15a, X2): line types,
// payload types, key sets and versions, counts only. Never a value: every name that is printed
// matches a strict pattern, anything else prints as a placeholder. Safe to paste into an issue.
// `--file` prints one file's parser health counters and token totals instead. Without `--all` it
// reads the files modified in the last 24 h, like the server.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Type names are plain lowercase words; anything shaped like an id prints as a placeholder.
const NAME = /^[a-z][a-z0-9_.:-]{0,39}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const MAX_CHILD_KEYS = 40;
// A path whose children were more than this many distinct names is a map keyed by data.
const MAX_DISTINCT_KEYS = 80;
// Structure is camelCase or snake_case words. Ids (a map keyed by tool call id) and file names
// fail the shape test and print as a placeholder.
const isKey = (key: string) =>
  KEY.test(key) &&
  /^[A-Za-z][A-Za-z0-9]*(_[a-z0-9]+)*$/.test(key) &&
  (key.match(/\d/g)?.length ?? 0) <= 2 &&
  (key.match(/[A-Z]/g)?.length ?? 0) <= 5;
const MAX_DEPTH = 3;

function fail(message: string): never {
  console.error(`logs-probe: ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--"));
const flags: string[] = [];
let file: string | undefined;
let json = false;
let all = false;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--json") json = true;
  else if (arg === "--all") all = true;
  else if (arg === "--log-root" || arg === "--file") {
    const value = argv[++i];
    if (value === undefined) fail(`${arg} needs a value`);
    if (arg === "--file") file = value;
    else flags.push(value);
  } else fail(`unknown flag ${arg} (use --log-root <dir>, --file <path>, --json, --all)`);
}

const tilde = (p: string) => {
  const home = homedir();
  return p === home || p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
};

if (file !== undefined) {
  const { parseClaudeText } = await import("../sidecar/parsers/claude.ts");
  // The parser's own counters, with nothing but the file's text going in.
  const { state } = parseClaudeText(
    readFileSync(file, "utf8"),
    { path: file, identity: "probe" },
    {
      resolveProjectKey: () => "probe",
      rootProjectKey: () => "probe",
      readMeta: () => undefined,
    },
  );
  const health = state.health;
  if (json) console.log(JSON.stringify(health, null, 2));
  else {
    console.log(`file: ${tilde(file)}`);
    console.log(`lines: ${health.lines}`);
    console.log(
      `malformed: ${health.malformed}  unknown: ${health.unknown}  oversize: ${health.oversize}  ignored: ${health.ignored}  usage drift: ${health.drift}`,
    );
    for (const [cls, offset] of Object.entries(health.firstOffsets)) {
      console.log(`first ${cls} at byte ${offset}`);
    }
    console.log(`events: ${health.events}`);
    const t = health.tokens;
    console.log(
      `tokens: in ${t.in}  out ${t.out}  cacheRead ${t.cacheRead}  cacheWrite ${t.cacheWrite}`,
    );
    if (health.versions.length > 0) console.log(`versions: ${health.versions.join(" ")}`);
  }
  process.exit(0);
}

const resolution = resolveRoots({
  flags,
  noLogs: false,
  env: process.env,
  platform: process.platform,
  homedir: homedir(),
  cwd: process.cwd(),
  readConfig: (path) => readFileSync(path, "utf8"),
});
if (resolution.kind === "error") fail(`${resolution.message} (${tilde(resolution.configPath)})`);
if (resolution.kind === "none") fail(`no log roots (${resolution.reason})`);

interface Survey {
  files: number;
  lines: number;
  malformed: number;
  types: Map<string, number>;
  payloadTypes: Map<string, number>;
  blockTypes: Map<string, number>;
  versions: Map<string, number>;
  keys: Map<string, Map<string, number>>;
}

const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
const safeName = (value: unknown): string =>
  typeof value === "string" && NAME.test(value) && (value.match(/\d/g)?.length ?? 0) <= 2
    ? value
    : value === undefined
      ? "-"
      : value === null
        ? "null"
        : "<other>";

function walk(
  value: unknown,
  path: string,
  depth: number,
  keys: Map<string, Map<string, number>>,
  typeName: string,
): void {
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) walk(item, `${path}[]`, depth, keys, typeName);
    return;
  }
  if (typeof value !== "object" || value === null || depth > MAX_DEPTH) return;
  const entries = Object.entries(value);
  const bag = keys.get(`${typeName} ${path}`) ?? new Map<string, number>();
  keys.set(`${typeName} ${path}`, bag);
  if (entries.length > MAX_CHILD_KEYS) {
    bump(bag, `<${entries.length > 400 ? "400+" : "many"} keys>`);
    return;
  }
  for (const [key, child] of entries) {
    bump(bag, isKey(key) ? key : "<key>");
    if (isKey(key)) walk(child, path === "" ? key : `${path}.${key}`, depth + 1, keys, typeName);
  }
}

function survey(path: string, into: Survey): Promise<void> {
  into.files++;
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }) });
  return new Promise((resolve, reject) => {
    rl.on("line", (line) => {
      if (line.trim() === "") return;
      into.lines++;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        into.malformed++;
        return;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        into.malformed++;
        return;
      }
      const o = value as Record<string, unknown>;
      const type = safeName(o.type);
      const sub = o.subtype === undefined ? "" : `/${safeName(o.subtype)}`;
      bump(into.types, `${type}${sub}`);
      const payload = o.payload as { type?: unknown } | undefined;
      if (payload && typeof payload === "object") {
        bump(into.payloadTypes, `${type}/${safeName(payload.type)}`);
      }
      const message = o.message as { content?: unknown; stop_reason?: unknown } | undefined;
      if (message && typeof message === "object") {
        if (Array.isArray(message.content)) {
          for (const block of message.content.slice(0, 50)) {
            const b = block as { type?: unknown; is_error?: unknown };
            bump(
              into.blockTypes,
              `${type}.${safeName(b?.type)}${b?.is_error === true ? " is_error" : ""}`,
            );
          }
        } else if (typeof message.content === "string") bump(into.blockTypes, `${type}.string`);
        if (message.stop_reason !== undefined) {
          bump(into.blockTypes, `${type} stop_reason=${safeName(message.stop_reason)}`);
        }
      }
      const version = o.version ?? (o.cli_version as unknown);
      if (typeof version === "string")
        bump(into.versions, VERSION.test(version) ? version : "<other>");
      walk(o, "", 0, into.keys, `${type}${sub}`);
    });
    rl.on("close", resolve);
    rl.on("error", reject);
  });
}

function listFiles(root: string, since: number): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const full = `${entry.parentPath}/${entry.name}`;
    try {
      if (all || statSync(full).mtimeMs >= since) out.push(full);
    } catch {
      // vanished between listing and stat
    }
  }
  return out;
}

// The names to print for one path, or a count when it is a map keyed by data.
const keyNames = (bag: Map<string, number>): string[] =>
  bag.size > MAX_DISTINCT_KEYS ? [`<${bag.size} distinct names>`] : [...bag.keys()].sort();

const byKey = (a: [string, unknown], b: [string, unknown]) => (a[0] < b[0] ? -1 : 1);

const sorted = (map: Map<string, number>) =>
  [...map].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

const results: { root: string; source: string; survey: Survey }[] = [];
const since = Date.now() - MAX_AGE_MS;
for (const root of resolution.roots) {
  const s: Survey = {
    files: 0,
    lines: 0,
    malformed: 0,
    types: new Map(),
    payloadTypes: new Map(),
    blockTypes: new Map(),
    versions: new Map(),
    keys: new Map(),
  };
  for (const path of listFiles(root.path, since)) await survey(path, s);
  results.push({ root: tilde(root.path), source: root.source, survey: s });
}

if (json) {
  const plain = (map: Map<string, number>) => Object.fromEntries(sorted(map));
  console.log(
    JSON.stringify(
      results.map(({ root, source, survey: s }) => ({
        root,
        source,
        window: all ? "all" : "24h",
        files: s.files,
        lines: s.lines,
        malformed: s.malformed,
        types: plain(s.types),
        payloadTypes: plain(s.payloadTypes),
        blockTypes: plain(s.blockTypes),
        versions: plain(s.versions),
        keys: Object.fromEntries([...s.keys].sort(byKey).map(([k, v]) => [k, keyNames(v)])),
      })),
      null,
      2,
    ),
  );
} else {
  for (const { root, source, survey: s } of results) {
    console.log(`root ${root} (${source}, ${all ? "all files" : "last 24 h"})`);
    console.log(`  ${s.files} files, ${s.lines} lines, ${s.malformed} not JSON`);
    const section = (title: string, map: Map<string, number>) => {
      if (map.size === 0) return;
      console.log(`  ${title}:`);
      for (const [name, n] of sorted(map)) console.log(`    ${String(n).padStart(8)}  ${name}`);
    };
    section("line types", s.types);
    section("payload types", s.payloadTypes);
    section("message content", s.blockTypes);
    section("versions", s.versions);
    console.log("  key sets (type, path: keys):");
    for (const [k, v] of [...s.keys].sort(byKey)) {
      console.log(`    ${k}: ${keyNames(v).join(",")}`);
    }
  }
}
