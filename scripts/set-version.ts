import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function setVersion(version: string, file = "package.json"): void {
  if (!semver.test(version)) {
    throw new Error(`not a semver version: "${version}"`);
  }
  const text = readFileSync(file, "utf8");
  const next = text.replace(/^(  "version": )"[^"]*"/m, `$1"${version}"`);
  if (next === text && !text.includes(`"version": "${version}"`)) {
    throw new Error(`no top-level "version" field in ${file}`);
  }
  writeFileSync(file, next);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    setVersion(process.argv[2] ?? "", process.argv[3]);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
