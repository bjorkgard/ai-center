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
  // Sets the rack count of a hall (slot 0-11) to 0-16 racks; out of range input clamps and warns.
  setRackCount(hall: number, n: number): void;
  // Turns the seeded fake LED load on or off; off shows every rack idle and steady.
  setFakeLoad(on: boolean): void;
  // Racks the hall in slot `hall` draws now, as it last reported them (read-only).
  shownRacks(hall: number): number;
  // Linear rgb of a rack's status strip as the frame loop last wrote it, or null.
  ledColor(hall: number, rack: number): [number, number, number] | null;
  // Places halls A.. in the first n slots (2-12); the next home() frames them. Out of range clamps and warns.
  setPlacedHalls(n: number): void;
  // Shows or hides the waypoint graph over the roads.
  setWaypoints(on: boolean): void;
  // Sets the cooling duty 0-1 for vapour and fans (chunk 09); out of range input clamps and warns.
  setDuty(value: number): void;
  // Turns a second of a plant fan as drawn, measured from its matrices (read-only); null before it turns.
  fanTurnRate(): number | null;
  // The duty the plant drew last (read-only); null before the first frame.
  liveDuty(): number | null;
  // Sets the packets a second on every fibre line 0-10 (chunk 10); out of range input clamps and warns.
  setPacketRate(perSecond: number): void;
  // Fibre lines drawn now (read-only); null before the first frame.
  fibreLines(): number | null;
  // Units a second a packet moves as drawn, measured from its matrix (read-only); null before it moves.
  packetSpeed(): number | null;
  // Forces a quality tier; medium and low run without bloom.
  setQuality(tier: import("./store/ui.ts").QualityTier): void;
  // Opacity of a hall's sign panel by slot 0-11.
  signOpacity(slot: number): number | null;
  // Opacity of a sign panel plus its latest fade's start and end on the fader's clock (ms).
  signFade(slot: number): { opacity: number; start: number | null; end: number | null } | null;
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
