import { posix, win32 } from "node:path";
import type { RootSource } from "../src/data/wire.ts";

export interface RootSpec {
  path: string;
  source: RootSource;
}

export interface RootsInput {
  /** Every `--log-root` value, in order. */
  flags: string[];
  noLogs: boolean;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  homedir: string;
  cwd: string;
  /** Returns the config file's text; throws (with `code`) when it cannot be read. */
  readConfig: (path: string) => string;
}

export type Resolution =
  | { kind: "roots"; roots: RootSpec[] }
  | { kind: "none"; reason: string }
  | { kind: "error"; configPath: string; message: string };

/** What a valid config file looks like; printed with every config error and committed as config.example.json. */
export const CONFIG_EXAMPLE = `{
  "logRoots": ["/home/you/.claude/projects", "/home/you/.codex/sessions"]
}
`;

const pathFor = (platform: NodeJS.Platform) => (platform === "win32" ? win32 : posix);

export function configPathFor(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  homedir: string,
): string {
  const path = pathFor(platform);
  let dir: string;
  if (platform === "win32") dir = env.APPDATA || path.join(homedir, "AppData", "Roaming");
  else dir = env.XDG_CONFIG_HOME || path.join(homedir, ".config");
  return path.join(dir, "synapse-horizon", "config.json");
}

export function defaultRoots(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  homedir: string,
): string[] {
  const path = pathFor(platform);
  return [
    path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir, ".claude"), "projects"),
    path.join(env.CODEX_HOME || path.join(homedir, ".codex"), "sessions"),
  ];
}

type ConfigResult = { roots: string[] } | { error: string };

function parseConfig(text: string): ConfigResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "the file must hold a JSON object" };
  }
  const roots = (value as { logRoots?: unknown }).logRoots;
  if (roots === undefined) return { roots: [] };
  if (!Array.isArray(roots) || roots.some((root) => typeof root !== "string")) {
    return { error: '"logRoots" must be an array of strings' };
  }
  return { roots: roots.filter((root) => root !== "") };
}

/**
 * First non-empty source wins and sources never merge: --log-root, SYNAPSE_LOG_ROOTS, the config
 * file, then the defaults. A config file that exists but is unusable is an error, never a fallback.
 */
export function resolveRoots(input: RootsInput): Resolution {
  const { flags, noLogs, env, platform, homedir, cwd, readConfig } = input;
  if (noLogs) return { kind: "none", reason: "--no-logs" };
  const path = pathFor(platform);
  const absolute = (root: string) => path.resolve(cwd, root);

  if (flags.length > 0) {
    return { kind: "roots", roots: flags.map((p) => ({ path: absolute(p), source: "flag" })) };
  }

  const fromEnv = env.SYNAPSE_LOG_ROOTS?.trim() ?? "";
  if (fromEnv === "none") return { kind: "none", reason: "SYNAPSE_LOG_ROOTS=none" };
  const envRoots = fromEnv.split(platform === "win32" ? ";" : ":").filter((p) => p !== "");
  if (envRoots.length > 0) {
    return { kind: "roots", roots: envRoots.map((p) => ({ path: absolute(p), source: "env" })) };
  }

  const configPath = configPathFor(env, platform, homedir);
  let text: string | undefined;
  try {
    text = readConfig(configPath);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "error", configPath, message: `cannot read the config file: ${message}` };
    }
  }
  if (text !== undefined) {
    const parsed = parseConfig(text);
    if ("error" in parsed) {
      return { kind: "error", configPath, message: `invalid config file: ${parsed.error}` };
    }
    if (parsed.roots.length > 0) {
      return {
        kind: "roots",
        roots: parsed.roots.map((p) => ({ path: absolute(p), source: "config" })),
      };
    }
  }

  return {
    kind: "roots",
    roots: defaultRoots(env, platform, homedir).map((p) => ({ path: p, source: "default" })),
  };
}
