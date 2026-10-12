import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

export const workDir = resolve("node_modules/.cache/synapse-horizon");

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

/** Bundles sidecar/cli.ts to one CommonJS file, shared by `serve` and `build:bin`. */
export async function bundleCli(): Promise<string> {
  mkdirSync(workDir, { recursive: true });
  const outfile = join(workDir, "cli.cjs");
  await build({
    stdin: {
      contents: `import { run } from "./sidecar/cli.ts";\nrun(process.argv.slice(2)).then((code) => process.exit(code));\n`,
      resolveDir: process.cwd(),
      sourcefile: "entry.ts",
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    outfile,
    define: { __CLI_VERSION__: JSON.stringify(version) },
    logLevel: "warning",
  });
  return outfile;
}
