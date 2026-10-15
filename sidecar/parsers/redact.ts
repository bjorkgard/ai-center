import { posix } from "node:path";

export const REDACTED = "[redacted]";
export const OUTSIDE = "[outside project]";

/** Text is examined only up to here, so the cost of a line never depends on its length (C101). */
const WINDOW = 4096;
/** The longest text any event carries (task text, file paths). */
const CUT = 120;
const MIN_SECRET = 32;
const MIN_ENTROPY = 4.0;
// Split on whitespace, quotes, brackets, commas, semicolons and `=` so `KEY=value` is judged by
// its value. Every pattern below is anchored on one token, so the whole pass is linear.
const TOKEN = /[^\s"'`<>()[\]{},;=]+/g;
const TRAILING = /[.,:!?]+$/;
const KEY_PREFIXES: RegExp[] = [
  /^(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}/,
  /^gh[pousr]_[A-Za-z0-9]{20,}/,
  /^github_pat_[A-Za-z0-9_]{20,}/,
  /^xox[abprs]-[A-Za-z0-9-]{8,}/,
  /^(?:AKIA|ASIA)[0-9A-Z]{16}/,
  /^AIza[0-9A-Za-z_-]{30,}/,
  /^glpat-[A-Za-z0-9_-]{16,}/,
  /^npm_[A-Za-z0-9]{30,}/,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];
const DRIVE = /^[A-Za-z]:[\\/]/;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  let n = 0;
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
    n++;
  }
  let bits = 0;
  for (const c of counts.values()) bits -= (c / n) * Math.log2(c / n);
  return bits;
}

/** A secret by shape: a known key prefix, a long hex string, or a long high-entropy mixed one. */
function isSecret(word: string): boolean {
  if (KEY_PREFIXES.some((re) => re.test(word))) return true;
  if (word.length < MIN_SECRET) return false;
  if (/^[0-9a-fA-F]+$/.test(word)) return word.length !== 40 && word.length !== 64;
  return /[A-Za-z]/.test(word) && /\d/.test(word) && entropy(word) >= MIN_ENTROPY;
}

const isAbsolute = (word: string): boolean =>
  DRIVE.test(word) || word.startsWith("~/") || (word.startsWith("/") && !word.startsWith("//"));

/** A word that is a path: absolute with at least two segments (a lone `/commit` is a command). */
const looksLikePath = (word: string): boolean =>
  DRIVE.test(word) ||
  word.startsWith("~/") ||
  (word.startsWith("/") && !word.startsWith("//") && word.indexOf("/", 1) > 0);

/** The working root itself, written alone (`/repo`), is a path even with one segment. */
const isRoot = (word: string, root: string | undefined): boolean =>
  root !== undefined && root.length > 1 && word === root.replace(/\/+$/, "");

function mapPath(word: string, root: string | undefined): string {
  if (word.startsWith("~") || DRIVE.test(word)) {
    // A drive path can still be inside a Windows root.
    if (!DRIVE.test(word) || root === undefined || !DRIVE.test(root)) return OUTSIDE;
    return insideRoot(word.replaceAll("\\", "/"), root.replaceAll("\\", "/"), true);
  }
  if (root === undefined || root === "" || DRIVE.test(root)) return OUTSIDE;
  return insideRoot(word, root, false);
}

function insideRoot(path: string, root: string, ignoreCase: boolean): string {
  const p = posix.normalize(path);
  const r = posix.normalize(root).replace(/\/+$/, "");
  if (r === "") return OUTSIDE;
  const [pc, rc] = ignoreCase ? [p.toLowerCase(), r.toLowerCase()] : [p, r];
  if (pc === rc || pc === `${rc}/`) return ".";
  if (pc.startsWith(`${rc}/`)) return p.slice(r.length + 1).replace(/\/+$/, "");
  return OUTSIDE;
}

function cut(text: string): string {
  if (text.length <= CUT) return text;
  const end = text.charCodeAt(CUT - 1);
  // Do not leave half of a surrogate pair at the cut.
  return text.slice(0, end >= 0xd800 && end <= 0xdbff ? CUT - 1 : CUT);
}

/**
 * Task text and other free text on its way into an event (R2, D16, E10, E11): examined up to
 * 4 KiB, secrets become `[redacted]`, absolute paths outside `root` become `[outside project]`
 * and inside it relative, then the result is cut to 120 characters.
 */
export function redact(text: string, root: string | undefined): string {
  const window = text.length > WINDOW ? text.slice(0, WINDOW) : text;
  let out = "";
  let last = 0;
  let previous = "";
  for (const match of window.matchAll(TOKEN)) {
    const raw = match[0];
    const start = match.index;
    const trailing = TRAILING.exec(raw)?.[0] ?? "";
    const word = trailing === "" ? raw : raw.slice(0, raw.length - trailing.length);
    let next = word;
    if (looksLikePath(word) || isRoot(word, root)) next = mapPath(word, root);
    else if (previous === "bearer" && word.length >= 8) next = REDACTED;
    else if (isSecret(word)) next = REDACTED;
    previous = word.toLowerCase();
    if (next !== word) {
      out += window.slice(last, start) + next + trailing;
      last = start + raw.length;
    }
  }
  return cut(out + window.slice(last));
}

/** A file path headed for `filesTouched`: the same path and secret rules, per path segment. */
export function redactPath(path: string, root: string | undefined): string {
  if (isAbsolute(path)) return mapPath(path, root);
  if (path.startsWith("../") || path === "..") return OUTSIDE;
  const segments = path.split("/").map((segment) => (isSecret(segment) ? REDACTED : segment));
  return cut(segments.join("/"));
}
