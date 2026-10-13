import { useStore, type WebglReason, type WebglStatus } from "../app/store/index.ts";
import { logScene } from "./sceneLog.ts";

// The only writers of the store webgl and sceneError fields: each change logs
// one [scene] line with the transition and its reason (S-RW40).
export function transitionWebgl(status: WebglStatus, reason: WebglReason | undefined, why: string) {
  const store = useStore.getState();
  const next = status === "ok" ? null : (reason ?? null);
  if (store.webgl === status && store.webglReason === next) return;
  const from = store.webgl;
  store.setWebgl(status, reason);
  logScene(`webgl ${from} -> ${status}${next ? ` (${next})` : ""}: ${why}`);
}

export function transitionSceneError(message: string, why: string) {
  const store = useStore.getState();
  if (store.sceneError?.message === message) return;
  store.setSceneError({ message });
  logScene(`sceneError ${store.sceneError ? "set" : "none"} -> set: ${why} (${message})`);
}
