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
}

interface Window {
  __sceneReady?: boolean;
  // Only present with dev=1.
  __sceneDev?: SceneDevHooks;
}
