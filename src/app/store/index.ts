import { create } from "zustand";
import { createDataSlice, initialData, setWarnClock, type DataSlice } from "./data.ts";
import { clearToastTimers, createToastSlice, type ToastSlice } from "./toasts.ts";
import { createUiSlice, initialUi, type UiSlice } from "./ui.ts";

export type Store = UiSlice & ToastSlice & DataSlice;

export const useStore = create<Store>()((...a) => ({
  ...createUiSlice(...a),
  ...createToastSlice(...a),
  ...createDataSlice(...a),
}));

// Test helper: put every slice back to its initial state.
export function resetStore(): void {
  clearToastTimers();
  useStore.getState().disconnect();
  setWarnClock();
  useStore.setState({ ...initialUi(), ...initialData(), toasts: [] });
}

export type { QualityTier, SafeArea, WebglReason, WebglStatus } from "./ui.ts";
