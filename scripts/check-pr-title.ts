const TYPES = [
  "feat",
  "fix",
  "docs",
  "chore",
  "test",
  "refactor",
  "perf",
  "ci",
  "build",
  "style",
  "revert",
];

const CONVENTIONAL = new RegExp(`^(${TYPES.join("|")})(\\([\\w./-]+\\))?!?: \\S.*$`);

export function checkPrTitle(title: string): string[] {
  if (CONVENTIONAL.test(title)) return [];
  return [
    `PR title "${title}" is not a Conventional Commit: expected "<type>(<scope>)!: <subject>" with type one of ${TYPES.join(", ")}`,
  ];
}

if (process.argv[1]?.endsWith("check-pr-title.ts")) {
  const problems = checkPrTitle(process.env.PR_TITLE ?? "");
  for (const problem of problems) console.error(problem);
  process.exit(problems.length === 0 ? 0 : 1);
}
