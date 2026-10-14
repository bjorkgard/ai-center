const KEEP = 20;
const PREFIX = "[scene]";
const LEVELS = ["log", "info", "warn", "error"] as const;

let lines: string[] = [];

function record(line: string): void {
  lines.push(line);
  if (lines.length > KEEP) lines = lines.slice(-KEEP);
}

export function lastSceneLines(): string[] {
  return [...lines];
}

export function clearSceneLines(): void {
  lines = [];
}

// One console line per transition (S-RW40); the same line feeds "Copy error details".
export function logScene(message: string): void {
  const line = `${PREFIX} ${message}`;
  console.info(line);
  if (!capturing) record(line);
}

let capturing = 0;
let originals: (typeof console.log)[] = [];

// Keeps the last 20 [scene] console lines from every level, including the
// driver's own console.error lines. Reference counted: the first install patches
// console, the last stop restores it, so StrictMode mount/unmount pairs are safe.
export function installSceneLogCapture(): () => void {
  if (capturing++ === 0) {
    originals = LEVELS.map((level) => console[level]);
    LEVELS.forEach((level, i) => {
      console[level] = (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].startsWith(PREFIX)) record(args[0]);
        originals[i].apply(console, args);
      };
    });
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--capturing === 0) {
      LEVELS.forEach((level, i) => {
        console[level] = originals[i];
      });
    }
  };
}
