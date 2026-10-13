import { BlendFunction, ToneMappingMode } from "postprocessing";
import {
  ACESFilmicToneMapping,
  Color,
  HalfFloatType,
  MeshStandardMaterial,
  PCFShadowMap,
  SRGBColorSpace,
  type DirectionalLight,
  type PerspectiveCamera,
  type WebGLRenderer,
} from "three";
import { viewPlan, type Load } from "./scene.ts";

// One constant for both views (RW1, E8). Nothing here is left to a library
// default: @react-three/postprocessing and postprocessing default differently.
export const RENDER = {
  maxPixelRatio: 2,
  background: "#070a12",
  renderer: { antialias: true, alpha: false, powerPreference: "high-performance" } as const,
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
  ambient: { color: "#8fa6c8", intensity: 1.1 },
  light: { color: "#ffffff", intensity: 3, shadowBias: -0.0005 },
  camera: { near: 0.1, far: 400 },
} as const;

export class ComposerInitError extends Error {}

// A composer that throws while being built becomes a ComposerInitError, which the
// page reports as composer-init instead of a generic init failure.
export function guardComposer<T>(build: () => T): T {
  try {
    return build();
  } catch (err) {
    throw new ComposerInitError(err instanceof Error ? err.message : String(err));
  }
}

export function pixelRatio(): number {
  return Math.min(window.devicePixelRatio, RENDER.maxPixelRatio);
}

export function applyRendererSettings(renderer: WebGLRenderer): void {
  renderer.setPixelRatio(pixelRatio());
  renderer.toneMapping = RENDER.toneMapping;
  renderer.outputColorSpace = RENDER.outputColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = RENDER.shadow.type;
}

export function configureCamera(camera: PerspectiveCamera, load: Load): void {
  const plan = viewPlan(load);
  camera.fov = plan.camera.fov;
  camera.near = RENDER.camera.near;
  camera.far = RENDER.camera.far * load;
  camera.position.set(...plan.camera.position);
  camera.lookAt(plan.centre.x, 0, plan.centre.z);
  camera.updateProjectionMatrix();
}

export function configureLight(light: DirectionalLight, load: Load): void {
  const plan = viewPlan(load);
  const { shadowExtent, far } = plan.light;
  light.position.set(...plan.light.position);
  light.target.position.set(plan.centre.x, 0, plan.centre.z);
  light.target.updateMatrixWorld();
  light.castShadow = true;
  light.shadow.mapSize.set(RENDER.shadow.mapSize, RENDER.shadow.mapSize);
  light.shadow.bias = RENDER.light.shadowBias;
  const cam = light.shadow.camera;
  cam.left = -shadowExtent;
  cam.right = shadowExtent;
  cam.top = shadowExtent;
  cam.bottom = -shadowExtent;
  cam.near = 0.5;
  cam.far = far;
  cam.updateProjectionMatrix();
}

export interface SharedMaterials {
  hall: MeshStandardMaterial;
  rack: MeshStandardMaterial;
  led: MeshStandardMaterial;
  disposeEvents(): number;
  dispose(): void;
}

// All halls share one set of materials, which must survive churn (RW6). Each
// receives a dispose-event counter (E9): a survivor reads 0.
export function createSharedMaterials(): SharedMaterials {
  const hall = new MeshStandardMaterial({ color: "#16293d", flatShading: true, roughness: 0.9 });
  const rack = new MeshStandardMaterial({ color: "#3b4d66", flatShading: true, roughness: 0.6 });
  // Colour above 1 so lit LEDs exceed the bloom luminance threshold in the HDR buffer.
  const led = new MeshStandardMaterial({ flatShading: true, roughness: 0.4 });
  led.color = new Color().setScalar(2.5);
  const all = [hall, rack, led];
  let events = 0;
  const count = () => {
    events++;
  };
  for (const m of all) m.addEventListener("dispose", count);
  return {
    hall,
    rack,
    led,
    disposeEvents: () => events,
    dispose() {
      for (const m of all) m.removeEventListener("dispose", count);
      for (const m of all) m.dispose();
    },
  };
}
