// Every global the app declares lives here.
declare const __APP_VERSION__: string;

interface SceneDevHooks {
  simulateFrameInterval(ms: number | null): void;
  stats(): import("../scene/stats.ts").SceneStats | null;
  state(): {
    webgl: import("./store/ui.ts").WebglStatus;
    quality: import("./store/ui.ts").QualityTier;
    reducedMotion: boolean;
    sceneError: { message: string } | null;
  };
  throwInScene(message: string): void;
  throwInFrame(message: string | null): void;
  throwInComposer(): void;
  // Unmounts the scene content, then mounts it again (04c dispose check).
  remountContent(): Promise<void>;
  // The camera framing and a world point's screen position (05 camera checks).
  camera(): import("../scene/stats.ts").CameraView | null;
  project(point: [number, number, number]): { x: number; y: number } | null;
  // Lights in the scene by three.js type (04c rig completeness check).
  rigLights(): Record<string, number>;
  // Cuts or restores the roof of every hall (chunk 06); anything but true or false warns.
  setRoofCut(on: boolean): void;
  // Forces a quality tier; medium and low run without bloom.
  setQuality(tier: import("./store/ui.ts").QualityTier): void;
  // Opacity of a hall's sign panel by slot 0-11.
  signOpacity(slot: number): number | null;
  // Dispose events the shared material library received since the hooks installed.
  materialDisposeEvents(): number;
  // Disposes one shared library material on purpose, so a test can see the guard count it.
  disposeSharedMaterial(): void;
}

interface Window {
  __sceneReady?: boolean;
  // Only present with dev=1.
  __sceneDev?: SceneDevHooks;
}
