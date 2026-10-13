import type { StateCreator } from "zustand";

export const TOAST_MS = 6000;

export interface Toast {
  id: number;
  text: string;
}

export interface ToastSlice {
  toasts: Toast[];
  pushToast(text: string, ms?: number): number;
  dismissToast(id: number): void;
}

let nextId = 1;
const timers = new Set<ReturnType<typeof setTimeout>>();

// Test helper: drop every pending auto-dismiss timer.
export function clearToastTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

// Newest first. A normal toast removes itself after `ms` (design D12).
export const createToastSlice: StateCreator<ToastSlice, [], [], ToastSlice> = (set, get) => ({
  toasts: [],
  pushToast: (text, ms = TOAST_MS) => {
    const id = nextId++;
    set({ toasts: [{ id, text }, ...get().toasts] });
    const timer = setTimeout(() => {
      timers.delete(timer);
      get().dismissToast(id);
    }, ms);
    timers.add(timer);
    return id;
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
});
