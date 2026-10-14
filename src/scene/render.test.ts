import { PCFShadowMap } from "three";
import { expect, test, vi } from "vite-plus/test";
import {
  RENDER,
  applyRendererSettings,
  guardDisposeEvents,
  pixelRatio,
  qualitySettings,
} from "./render.ts";

test("the shared shadow type is PCFShadowMap, not the removed PCFSoftShadowMap", () => {
  expect(RENDER.shadow.type).toBe(PCFShadowMap);
});

test("powerPreference is the browser default (C16)", () => {
  expect(RENDER.renderer.powerPreference).toBe("default");
});

test("qualitySettings table", () => {
  expect(qualitySettings("high")).toEqual({ shadows: true, bloom: true, pixelRatioCap: 2 });
  expect(qualitySettings("medium")).toEqual({ shadows: true, bloom: false, pixelRatioCap: 1.5 });
  expect(qualitySettings("low")).toEqual({ shadows: false, bloom: false, pixelRatioCap: 1 });
});

test("pixelRatio is capped by the tier", () => {
  vi.stubGlobal("window", { devicePixelRatio: 3 });
  try {
    expect(pixelRatio()).toBe(2);
    expect(pixelRatio(1.5)).toBe(1.5);
    vi.stubGlobal("window", { devicePixelRatio: 1 });
    expect(pixelRatio(2)).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("applyRendererSettings applies the tier", () => {
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  try {
    const r = {
      setPixelRatio: vi.fn(),
      toneMapping: 0,
      outputColorSpace: "",
      shadowMap: { enabled: false, type: 0 },
    };
    applyRendererSettings(r as never, "low");
    expect(r.setPixelRatio).toHaveBeenCalledWith(1);
    expect(r.shadowMap.enabled).toBe(false);
    expect(r.toneMapping).toBe(RENDER.toneMapping);
    expect(r.outputColorSpace).toBe(RENDER.outputColorSpace);
    applyRendererSettings(r as never);
    expect(r.setPixelRatio).toHaveBeenLastCalledWith(2);
    expect(r.shadowMap.enabled).toBe(true);
    expect(r.shadowMap.type).toBe(RENDER.shadow.type);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("guardDisposeEvents counts dispose events and stops after release (E9)", () => {
  const listeners = new Set<() => void>();
  const material = {
    addEventListener: (_: "dispose", fn: () => void) => listeners.add(fn),
    removeEventListener: (_: "dispose", fn: () => void) => listeners.delete(fn),
  };
  const guard = guardDisposeEvents([material]);
  expect(guard.events()).toBe(0);
  for (const fn of listeners) fn();
  expect(guard.events()).toBe(1);
  guard.release();
  expect(listeners.size).toBe(0);
});

test("applyRendererSettings turns local clipping on in every tier (CEO W-RW14)", () => {
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  try {
    for (const tier of ["high", "medium", "low"] as const) {
      const r = {
        setPixelRatio: vi.fn(),
        toneMapping: 0,
        outputColorSpace: "",
        localClippingEnabled: false,
        shadowMap: { enabled: false, type: 0 },
      };
      applyRendererSettings(r as never, tier);
      expect(r.localClippingEnabled, tier).toBe(true);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
