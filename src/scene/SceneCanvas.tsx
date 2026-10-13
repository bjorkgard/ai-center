import { Canvas, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, ToneMapping } from "@react-three/postprocessing";
import type { EffectComposer as EffectComposerImpl } from "postprocessing";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MeshStandardMaterial, type WebGLRenderer } from "three";
import type { AppParams } from "../app/params.ts";
import { useStore, type QualityTier } from "../app/store/index.ts";
import {
  composerFailed,
  markComposerFailed,
  composerRestored,
  INITIAL_COMPOSER,
  type ComposerDeps,
} from "./composerState.ts";
import { createCameraRig, type CameraRig } from "./camera.ts";
import { installSceneDev } from "./devHooks.ts";
import { DrawCallCounter } from "./drawCalls.ts";
import { createRenderDriver, type RenderDriver } from "./loop/driver.ts";
import { createFrameMonitor } from "./loop/monitor.ts";
import { MarkPass } from "./MarkPass.ts";
import { applyRendererSettings, pixelRatio, qualitySettings, RENDER } from "./render.ts";
import { logScene } from "./sceneLog.ts";
import { reportSceneFailure } from "./failure.ts";
import { SceneBoundary, SceneContentBoundary } from "./SceneBoundary.tsx";
import { setSceneProbe } from "./stats.ts";
import { transitionSceneError, transitionWebgl } from "./transitions.ts";
import { glFactory, precheckWebgl, watchContext } from "./webgl.ts";

// RenderPass, MarkPass and the merged EffectPass.
const COMPOSER_PASSES = 3;

// Mutable bridge between the React tree and the frame callback (no re-render per frame).
class SceneControl {
  frameThrow: string | null = null;
  composerGen = 0;
  private markFn: (() => void) | null = null;
  private composer: EffectComposerImpl | null = null;
  private expectComposer = false;
  private stopFn: (() => void) | null = null;

  setComposerGen(gen: number) {
    this.composerGen = gen;
  }
  setFrameThrow(message: string | null) {
    this.frameThrow = message;
  }
  setStop(fn: (() => void) | null) {
    this.stopFn = fn;
  }
  stopDriver() {
    this.stopFn?.();
  }
  setMark(fn: (() => void) | null) {
    this.markFn = fn;
  }
  mark() {
    this.markFn?.();
  }
  bindComposer(composer: EffectComposerImpl | null) {
    this.composer = composer;
  }
  setExpectComposer(value: boolean) {
    this.expectComposer = value;
  }
  get bloom() {
    return this.expectComposer;
  }
  get composerReady() {
    return !this.expectComposer || (this.composer?.passes.length ?? 0) >= COMPOSER_PASSES;
  }
}

// Test scene for 04a: a cube on a ground plane with a faint grid, one neutral light
// and one temporary neutral material. 04c brings the rig and the material library.
function TestScene({ shadows }: { shadows: boolean }) {
  const material = useMemo(
    () => new MeshStandardMaterial({ color: "#4b5468", roughness: 0.9, metalness: 0 }),
    [],
  );
  useEffect(() => () => material.dispose(), [material]);
  return (
    <>
      <directionalLight
        color={RENDER.light.color}
        intensity={RENDER.light.intensity}
        position={[6, 10, 4]}
        castShadow={shadows}
        shadow-mapSize={[RENDER.shadow.mapSize, RENDER.shadow.mapSize]}
        shadow-bias={RENDER.light.shadowBias}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
      />
      <mesh position={[0, 0.8, 0]} material={material} castShadow receiveShadow>
        <boxGeometry args={[1, 1.6, 1]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={material} receiveShadow>
        <planeGeometry args={[40, 40]} />
      </mesh>
      <gridHelper args={[40, 40, "#2a3550", "#2a3550"]} position={[0, 0.01, 0]} />
    </>
  );
}

// `gen` is read once at mount, so the probe shows which build is live.
function Composer({ control, gen, boom }: { control: SceneControl; gen: number; boom: boolean }) {
  const mountedGen = useRef(gen);
  useEffect(() => {
    control.setComposerGen(mountedGen.current);
  }, [control]);
  const markPass = useMemo(() => new MarkPass(() => control.mark()), [control]);
  if (boom) throw new Error("composer boom");
  return (
    <EffectComposer
      ref={(composer: EffectComposerImpl | null) => control.bindComposer(composer)}
      multisampling={RENDER.composer.multisampling}
      frameBufferType={RENDER.composer.frameBufferType}
      depthBuffer={RENDER.composer.depthBuffer}
      stencilBuffer={RENDER.composer.stencilBuffer}
    >
      <primitive object={markPass} />
      <Bloom {...RENDER.bloom} />
      <ToneMapping {...RENDER.toneMappingEffect} />
    </EffectComposer>
  );
}

function composerDeps(control: SceneControl): ComposerDeps {
  return { log: logScene, unbind: () => control.bindComposer(null) };
}

function Thrower({ message }: { message: string }): never {
  throw new Error(message);
}

// The composer owns tone mapping while it is mounted, so only the first apply sets it.
function applyTier(gl: WebGLRenderer, tier: QualityTier, first: boolean): void {
  const toneMapping = gl.toneMapping;
  applyRendererSettings(gl, tier);
  if (!first) gl.toneMapping = toneMapping;
}

interface RuntimeProps {
  rig: CameraRig;
  params: AppParams;
  control: SceneControl;
  onReady: (ready: boolean) => void;
  onRestored: () => void;
}

// Everything that needs the R3F state: the driver, the monitor, the context watcher,
// the camera hand-over and the renderer settings. Each effect returns its stop (E25).
function SceneRuntime({ rig, params, control, onReady, onRestored }: RuntimeProps) {
  const advance = useThree((s) => s.advance);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const set = useThree((s) => s.set);
  const quality = useStore((s) => s.quality);
  const driverRef = useRef<RenderDriver | null>(null);
  const firstApply = useRef(true);

  useEffect(() => {
    applyTier(gl, quality, firstApply.current);
    firstApply.current = false;
    scene.traverse((object) => {
      const material = (object as { material?: { needsUpdate: boolean } }).material;
      if (material) material.needsUpdate = true;
    });
    driverRef.current?.invalidateFrozen();
  }, [gl, scene, quality]);

  useEffect(() => {
    rig.setViewport({ width: size.width, height: size.height });
    driverRef.current?.invalidateFrozen();
  }, [rig, size]);

  useEffect(
    () =>
      rig.subscribe((camera) => {
        set({ camera });
        driverRef.current?.notifyCameraMotion();
        driverRef.current?.invalidateFrozen();
      }),
    [rig, set],
  );

  useEffect(
    () =>
      watchContext(gl.domElement, (change) => {
        const why = {
          restoring: "context lost",
          unavailable: "no restore within 10 s",
          ok: "context restored",
        }[change.status];
        transitionWebgl(change.status, change.reason, why);
        if (change.status === "ok") {
          onRestored();
          driverRef.current?.invalidateFrozen();
        }
      }),
    [gl, onRestored],
  );

  useEffect(() => {
    const counter = new DrawCallCounter(gl.info);
    const monitor = createFrameMonitor();
    let frames = 0;
    let ready = false;
    control.setMark(() => counter.markScene());

    const driver = createRenderDriver({
      calm: params.calm,
      freeze: params.freeze,
      render: (sceneSeconds) => {
        if (control.frameThrow) throw new Error(control.frameThrow);
        if (useStore.getState().webgl !== "ok") return;
        if (!control.composerReady) {
          driver.invalidateFrozen();
          return;
        }
        counter.begin();
        advance(sceneSeconds);
        counter.end();
        frames++;
        if (!ready) {
          ready = true;
          onReady(true);
        }
      },
      onFatal: (message) => transitionSceneError(message, "3 consecutive frame errors"),
      onFrame: (interval, cap) => monitor.feed(interval, cap),
      onPause: (paused) => monitor.setPaused(paused),
      onDiscontinuity: () => monitor.discontinuity(),
    });
    driverRef.current = driver;

    const probe = {
      read: () => ({
        frames,
        sceneCalls: counter.sceneCalls,
        postCalls: counter.postCalls,
        triangles: gl.info.render.triangles,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        programs: gl.info.programs?.length ?? 0,
        capFps: driver.state.capFps,
        mode: driver.state.mode,
        frameErrors: driver.errorCount,
        projection: rig.projection,
        bloom: control.bloom,
        composerGen: control.composerGen,
      }),
      toggleProjection: () => rig.toggle(),
    };
    setSceneProbe(probe);

    const stopDriver = driver.start();
    control.setStop(stopDriver);
    const onInput = () => driver.notifyInput();
    const inputs = ["pointermove", "pointerdown", "keydown", "wheel"] as const;
    for (const type of inputs) window.addEventListener(type, onInput, { passive: true });

    return () => {
      for (const type of inputs) window.removeEventListener(type, onInput);
      stopDriver();
      control.setStop(null);
      monitor.stop();
      setSceneProbe(null);
      control.setMark(null);
      driverRef.current = null;
      onReady(false);
    };
  }, [advance, gl, rig, params.calm, params.freeze, control, onReady]);

  return null;
}

function Scene({ params, onReady }: { params: AppParams; onReady: (ready: boolean) => void }) {
  // Throws WebGLUnavailableError, which the outer boundary maps to the WebGL card.
  useState(() => precheckWebgl(params.webgl));

  const quality = useStore((s) => s.quality);
  const settings = qualitySettings(quality);
  const [rig] = useState(() =>
    createCameraRig({ width: window.innerWidth, height: window.innerHeight }),
  );
  const [control] = useState(() => new SceneControl());
  const [composer, setComposer] = useState(INITIAL_COMPOSER);
  const [thrown, setThrown] = useState<string | null>(null);
  const [composerBoom, setComposerBoom] = useState(false);

  const bloom = settings.bloom && !composer.failed;
  useEffect(() => control.setExpectComposer(bloom), [control, bloom]);

  const onRestored = useCallback(() => {
    logScene("composer remount after context restore");
    setComposer(composerRestored);
  }, [setComposer]);

  useEffect(() => {
    if (!params.dev) return;
    return installSceneDev({
      throwInScene: setThrown,
      throwInFrame: (message) => control.setFrameThrow(message),
      throwInComposer: () => setComposerBoom(true),
    });
  }, [params.dev, control]);

  return (
    <div className="absolute inset-0">
      <Canvas
        frameloop="never"
        dpr={pixelRatio(settings.pixelRatioCap)}
        gl={glFactory}
        shadows={settings.shadows ? { enabled: true, type: RENDER.shadow.type } : false}
        camera={rig.ortho}
      >
        <color attach="background" args={[RENDER.background]} />
        <SceneRuntime
          rig={rig}
          params={params}
          control={control}
          onReady={onReady}
          onRestored={onRestored}
        />
        <SceneContentBoundary stopDriver={() => control.stopDriver()}>
          <TestScene shadows={settings.shadows} />
          {thrown !== null && <Thrower message={thrown} />}
        </SceneContentBoundary>
        {bloom && (
          <SceneBoundary
            key={composer.gen}
            onError={(error) => {
              setComposerBoom(false);
              composerFailed(INITIAL_COMPOSER, error, composerDeps(control));
              setComposer(markComposerFailed);
            }}
          >
            <Composer control={control} gen={composer.gen} boom={composerBoom} />
          </SceneBoundary>
        )}
      </Canvas>
    </div>
  );
}

export function SceneCanvas(props: { params: AppParams; onReady: (ready: boolean) => void }) {
  return (
    <SceneBoundary onError={reportSceneFailure}>
      <Scene {...props} />
    </SceneBoundary>
  );
}
