const QUERY = "(prefers-reduced-motion: reduce)";

// Follows the OS setting live (design D20). Returns the stop function for the effect cleanup.
export function watchReducedMotion(
  set: (value: boolean) => void,
  matchMedia: (query: string) => MediaQueryList = (q) => window.matchMedia(q),
): () => void {
  const mql = matchMedia(QUERY);
  set(mql.matches);
  const onChange = (event: { matches: boolean }) => set(event.matches);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
