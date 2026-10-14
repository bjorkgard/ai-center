import { BlendFunction, ToneMappingMode } from "postprocessing";
import {
  ACESFilmicToneMapping,
  HalfFloatType,
  PCFShadowMap,
  SRGBColorSpace,
  type WebGLRenderer,
} from "three";
import type { QualityTier } from "../app/store/ui.ts";

// One constant for every consumer (RW1, E8). Nothing here is left to a library
// default: @react-three/postprocessing and postprocessing default differently.
export const RENDER = {
  maxPixelRatio: 2,
  background: "#070a12",
  renderer: { antialias: true, alpha: false, powerPreference: "default" } as const,
  toneMapping: ACESFilmicToneMapping,
  outputColorSpace: SRGBColorSpace,
  shadow: { type: PCFShadowMap, mapSize: 2048 },
  composer: {
    multisampling: 4,
    frameBufferType: HalfFloatType,
    depthBuffer: true,
    stencilBuffer: false,
  },
  bloom: {
    blendFunction: BlendFunction.SCREEN,
    intensity: 1.2,
    luminanceThreshold: 0.6,
    luminanceSmoothing: 0.2,
    mipmapBlur: true,
    radius: 0.85,
    levels: 8,
  },
  toneMappingEffect: { mode: ToneMappingMode.ACES_FILMIC },
  // Night rig (design D14): cool moonlight with the one shadow, a dim sky/ground hemisphere
  // and a low flat fill so the shaded faces never go black.
  rig: {
    hemisphere: { sky: "#6a82b4", ground: "#141824", intensity: 1.3 },
    moon: { color: "#b4c2ea", intensity: 3.6, position: [8, 12, 5], shadowBias: -0.0005 },
    fill: { color: "#34406a", intensity: 0.7 },
  },
  camera: { near: 0.1, far: 400 },
} as const;

export interface QualitySettings {
  shadows: boolean;
  bloom: boolean;
  pixelRatioCap: number;
}

const QUALITY: Record<QualityTier, QualitySettings> = {
  high: { shadows: true, bloom: true, pixelRatioCap: 2 },
  medium: { shadows: true, bloom: false, pixelRatioCap: 1.5 },
  low: { shadows: false, bloom: false, pixelRatioCap: 1 },
};

export function qualitySettings(tier: QualityTier): QualitySettings {
  return QUALITY[tier];
}

export function pixelRatio(cap: number = RENDER.maxPixelRatio): number {
  return Math.min(window.devicePixelRatio, cap);
}

export function applyRendererSettings(renderer: WebGLRenderer, tier: QualityTier = "high"): void {
  const q = qualitySettings(tier);
  renderer.setPixelRatio(pixelRatio(q.pixelRatioCap));
  renderer.toneMapping = RENDER.toneMapping;
  renderer.outputColorSpace = RENDER.outputColorSpace;
  renderer.shadowMap.enabled = q.shadows;
  renderer.shadowMap.type = RENDER.shadow.type;
  // The hall body's roof plane is a local clipping plane; three's shadow pass checks this too
  // (WebGLShadowMap.js:442).
  renderer.localClippingEnabled = true;
}

interface DisposeSource {
  addEventListener(type: "dispose", listener: () => void): void;
  removeEventListener(type: "dispose", listener: () => void): void;
}

// Shared materials must survive churn (RW6). Each receives a dispose-event
// counter (E9): a survivor reads 0.
export function guardDisposeEvents(materials: readonly DisposeSource[]): {
  events(): number;
  release(): void;
} {
  let events = 0;
  const count = () => {
    events++;
  };
  for (const m of materials) m.addEventListener("dispose", count);
  return {
    events: () => events,
    release() {
      for (const m of materials) m.removeEventListener("dispose", count);
    },
  };
}
