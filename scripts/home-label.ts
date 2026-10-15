import * as nodePath from "node:path";

/**
 * `p` with the home directory written as `~`, so output does not carry the user name. Whether `p`
 * is under `home` is decided by `path.relative`, so it follows the platform's separator and, on
 * Windows, drive and case rules (`C:\Users\Alice2` is not under `C:\Users\Alice`).
 */
export function homeLabel(
  p: string,
  home: string,
  path: Pick<typeof nodePath, "relative" | "isAbsolute" | "parse" | "resolve" | "sep"> = nodePath,
): string {
  if (home === "" || path.resolve(home) === path.parse(path.resolve(home)).root) return p;
  const rel = path.relative(home, p);
  if (rel === "") return "~";
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return p;
  return `~${path.sep}${rel}`;
}
