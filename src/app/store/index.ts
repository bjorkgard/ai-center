import { create } from "zustand";
import { createUiSlice, initialUi, type UiSlice } from "./ui.ts";

export type Store = UiSlice;

export const useStore = create<Store>()((...a) => ({
  ...createUiSlice(...a),
}));

// Test helper: put every slice back to its initial state.
export function resetStore(): void {
  useStore.setState({ ...initialUi() });
}

export type { QualityTier, SafeArea, WebglReason, WebglStatus } from "./ui.ts";
