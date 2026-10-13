import { create } from "zustand";
import { clearToastTimers, createToastSlice, type ToastSlice } from "./toasts.ts";
import { createUiSlice, initialUi, type UiSlice } from "./ui.ts";

export type Store = UiSlice & ToastSlice;

export const useStore = create<Store>()((...a) => ({
  ...createUiSlice(...a),
  ...createToastSlice(...a),
}));

// Test helper: put every slice back to its initial state.
export function resetStore(): void {
  clearToastTimers();
  useStore.setState({ ...initialUi(), toasts: [] });
}

export type { QualityTier, SafeArea, WebglReason, WebglStatus } from "./ui.ts";
