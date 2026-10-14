export interface ErrorDetailsInput {
  message: string;
  lines: string[];
  version: string;
  userAgent: string;
}

// What "Copy error details" puts on the clipboard (DR14): message, last 20 [scene]
// lines, app version and user agent.
export function buildErrorDetails({ message, lines, version, userAgent }: ErrorDetailsInput) {
  return [
    `Error: ${message}`,
    `App version: ${version}`,
    `User agent: ${userAgent}`,
    "",
    "Last [scene] console lines:",
    ...lines.slice(-20),
    "",
  ].join("\n");
}
