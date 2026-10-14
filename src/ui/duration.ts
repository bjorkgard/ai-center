const FALLBACK_MS = 250;

// The --dur-ui token (design D18) in milliseconds; 250 when the token is missing or unreadable.
export function uiDurationMs(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--dur-ui").trim();
  const ms = raw.endsWith("ms")
    ? parseFloat(raw)
    : raw.endsWith("s")
      ? parseFloat(raw) * 1000
      : NaN;
  return Number.isFinite(ms) ? ms : FALLBACK_MS;
}
