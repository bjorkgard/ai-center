import type { CardKind } from "../scene/cards/select.ts";
import type { WebglReason, WebglStatus } from "../app/store/index.ts";

export { TOAST_MS } from "../app/store/toasts.ts";

// "Restoring 3D view" lasts while the context restores, and is hidden while any card shows (DR5).
export function restoringToastVisible(webgl: WebglStatus, card: CardKind | null): boolean {
  return webgl === "restoring" && card === null;
}

// "3D view restored" follows restoring -> ok, or a late restore of the lost card (DR6).
export function restoreToastFor(
  prev: { status: WebglStatus; reason: WebglReason | null },
  next: WebglStatus,
  card: CardKind | null,
): boolean {
  if (next !== "ok" || card !== null) return false;
  return prev.status === "restoring" || (prev.status === "unavailable" && prev.reason === "lost");
}

// Items that left the wanted list keep an exit animation, except the restoring toast when a card
// is shown: it must not linger over the card (DR5).
export function departedToasts<T extends { id: number; restoring: boolean }>(
  previous: T[],
  wanted: { id: number }[],
  card: CardKind | null,
): T[] {
  const ids = new Set(wanted.map((w) => w.id));
  return previous.filter((p) => !ids.has(p.id) && !(p.restoring && card !== null));
}
