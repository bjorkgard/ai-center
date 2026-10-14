import type { StateCreator } from "zustand";

export type QualityTier = "high" | "medium" | "low";
export type WebglStatus = "ok" | "restoring" | "unavailable";
export type WebglReason = "start" | "lost";

export interface SafeArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiState {
  reducedMotion: boolean;
  quality: QualityTier;
  webgl: WebglStatus;
  webglReason: WebglReason | null;
  sceneError: { message: string } | null;
  safeArea: SafeArea;
  // The canvas minus the top bar and tab strip: what home() frames the campus in (decision H1).
  homeArea: SafeArea;
  rightPanelOpen: boolean;
}

export interface UiActions {
  setReducedMotion(value: boolean): void;
  setQuality(tier: QualityTier): void;
  setWebgl(status: WebglStatus, reason?: WebglReason): void;
  setSceneError(error: { message: string } | null): void;
  setSafeArea(area: SafeArea): void;
  setHomeArea(area: SafeArea): void;
  setRightPanelOpen(open: boolean): void;
}

export type UiSlice = UiState & UiActions;

export function initialUi(): UiState {
  const inWindow = typeof window !== "undefined";
  return {
    reducedMotion: false,
    quality: "high",
    webgl: "ok",
    webglReason: null,
    sceneError: null,
    safeArea: {
      x: 0,
      y: 0,
      width: inWindow ? window.innerWidth : 0,
      height: inWindow ? window.innerHeight : 0,
    },
    homeArea: {
      x: 0,
      y: 0,
      width: inWindow ? window.innerWidth : 0,
      height: inWindow ? window.innerHeight : 0,
    },
    rightPanelOpen: false,
  };
}

export const createUiSlice: StateCreator<UiSlice, [], [], UiSlice> = (set) => ({
  ...initialUi(),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
  setQuality: (quality) => set({ quality }),
  setWebgl: (webgl, reason) =>
    set({ webgl, webglReason: webgl === "ok" ? null : (reason ?? null) }),
  setSceneError: (sceneError) => set({ sceneError }),
  setSafeArea: (safeArea) => set({ safeArea }),
  setHomeArea: (homeArea) => set({ homeArea }),
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
});
