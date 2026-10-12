import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const PINNED = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/;

function collectUses(node: unknown, found: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectUses(item, found);
  } else if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "uses" && typeof value === "string") found.push(value);
      else collectUses(value, found);
    }
  }
}

export function checkWorkflow(name: string, text: string): string[] {
  const problems: string[] = [];
  const doc: unknown = parse(text);
  if (doc === null || typeof doc !== "object" || !("permissions" in doc)) {
    problems.push(`${name}: no top-level permissions: key`);
  }
  const uses: string[] = [];
  collectUses(doc, uses);
  for (const ref of uses) {
    if (ref.startsWith("./")) continue;
    if (!PINNED.test(ref)) {
      problems.push(`${name}: uses: ${ref} is not pinned to a 40-character commit SHA`);
    }
  }
  return problems;
}

export function checkDirectory(dir: string): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .flatMap((file) => checkWorkflow(file, readFileSync(join(dir, file), "utf8")));
}

if (process.argv[1]?.endsWith("check-workflows.ts")) {
  const problems = checkDirectory(".github/workflows");
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
