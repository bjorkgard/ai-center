import { Canvas, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, ToneMapping } from "@react-three/postprocessing";
import type { EffectComposer as EffectComposerImpl } from "postprocessing";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Vector3, type WebGLRenderer } from "three";
import type { AppParams, ViewName } from "../app/params.ts";
import { useStore, type QualityTier } from "../app/store/index.ts";
import {
  composerFailed,
  markComposerFailed,
  composerRestored,
  INITIAL_COMPOSER,
  type ComposerDeps,
} from "./composerState.ts";
import { uiDurationMs } from "../ui/duration.ts";
import { createCameraRig, ORTHO_ZOOM, type CameraRig } from "./camera.ts";
import {
  createCameraControls,
  stepCamera,
  wakeOnRigMotion,
  type CameraControls,
} from "./controls.ts";
import { attachCameraKeys } from "./keyboard.ts";
import { isEmptyGround } from "./pick.ts";
import { installSceneDev } from "./devHooks.ts";
import { DrawCallCounter } from "./drawCalls.ts";
import { createRenderDriver, type RenderDriver } from "./loop/driver.ts";
import { createFrameMonitor } from "./loop/monitor.ts";
import { Ground } from "./Ground.tsx";
import { LightRig } from "./LightRig.tsx";
import { LookDevScene } from "./LookDev.tsx";
import { CampusScene } from "./campus/Campus.tsx";
import { placedHalls, subscribeCampus } from "./campus/campusDev.ts";
import { campusBounds, campusHome } from "./campus/layout.ts";
import { Hall, SignPanelMesh } from "./hall/Hall.tsx";
import { HALL_FRAMING } from "./hall/hallLayout.ts";
import { subscribeRacks } from "./hall/racksDev.ts";
import { subscribeRoof } from "./hall/roof.ts";
import { LOOKDEV_FRAMING } from "./lookdevFraming.ts";
import { MarkPass } from "./MarkPass.ts";
import { setBloomGlow } from "./materials.ts";
import { createSceneSignals } from "./sceneSignals.ts";
import { SignalsContext } from "./signals.ts";
import { applyRendererSettings, pixelRatio, qualitySettings, RENDER } from "./render.ts";
import { logScene } from "./sceneLog.ts";
import { reportSceneFailure } from "./failure.ts";
import { SceneBoundary, SceneContentBoundary } from "./SceneBoundary.tsx";
import { shaderErrorCount } from "./shaderErrors.ts";
import { setSceneProbe } from "./stats.ts";
import { transitionSceneError, transitionWebgl } from "./transitions.ts";
import { glFactory, precheckWebgl, watchContext } from "./webgl.ts";

// RenderPass, MarkPass and the merged EffectPass.
const COMPOSER_PASSES = 3;

const CAMERA_HELP_ID = "camera-help";
const CAMERA_HELP =
  "Arrow keys pan, plus and minus zoom, Q and E rotate, 0 returns home, P switches perspective.";

// The dev-menu glide test (DR11) flies out to this spot and back home.
const GLIDE_TEST = { far: new Vector3(8, 0, -6), zoom: 140 };

// Hands the scene its data through SceneSignals, evaluated at scene time (the R3F clock, which
// the driver sets to the frozen-aware scene seconds). Chunks 18 and 22 swap the implementation.
function SignalsScope({
  view,
  seed,
  children,
}: {
  view: ViewName;
  seed: number;
  children: ReactNode;
}) {
  const clock = useThree((s) => s.clock);
  const signals = useMemo(
    () => createSceneSignals(view, seed, () => clock.elapsedTime),
    [view, seed, clock],
  );
  return <SignalsContext.Provider value={signals}>{children}</SignalsContext.Provider>;
}

// The hall view: one hall with the roof cut away, under the shared rig (chunk 06). The racks view
// is the same hall with 16 racks.
function HallScene({
  shadows,
  rig,
  frozen,
}: {
  shadows: boolean;
  rig: CameraRig;
  frozen: boolean;
}) {
  return (
    <>
      <LightRig shadows={shadows} />
      <Ground />
      <Hall />
      <SignPanelMesh rig={rig} frozen={frozen} />
    </>
  );
}

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

// Reports the content's own mount and unmount effects, so a remount can wait for the real commit.
function MountSignal({ onMount, onUnmount }: { onMount: () => void; onUnmount: () => void }) {
  useEffect(() => {
    onMount();
    return onUnmount;
  }, [onMount, onUnmount]);
  return null;
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
  bloom: boolean;
}

// Everything that needs the R3F state: the driver, the monitor, the context watcher,
// the camera hand-over and the renderer settings. Each effect returns its stop (E25).
function SceneRuntime({ rig, params, control, onReady, onRestored, bloom }: RuntimeProps) {
  const advance = useThree((s) => s.advance);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const set = useThree((s) => s.set);
  const quality = useStore((s) => s.quality);
  const driverRef = useRef<RenderDriver | null>(null);
  const controlsRef = useRef<CameraControls | null>(null);
  const firstApply = useRef(true);
  const interactive = params.view !== "lookdev";
  const campusView = params.view === "home";
  // The startup pose frames the campus in the safe area (CEO C25) and follows the safe area and
  // the window size until the camera is moved: the key is the framing as the startup left it.
  const startupKey = useRef<string | null>(null);
  const refit = useRef<() => void>(() => {});

  useEffect(() => {
    applyTier(gl, quality, firstApply.current);
    firstApply.current = false;
    scene.traverse((object) => {
      const material = (object as { material?: { needsUpdate: boolean } }).material;
      if (material) material.needsUpdate = true;
    });
    driverRef.current?.invalidateFrozen();
  }, [gl, scene, quality]);

  // Glow materials get x1.5 while bloom is off (WD4); a roof toggle redraws a frozen frame.
  useEffect(() => {
    setBloomGlow(bloom);
    driverRef.current?.invalidateFrozen();
  }, [bloom]);

  useEffect(() => subscribeRoof(() => driverRef.current?.invalidateFrozen()), []);
  useEffect(() => subscribeRacks(() => driverRef.current?.invalidateFrozen()), []);

  // The next home() frames the halls placed now; a placed hall never moves the camera (CEO C25).
  useEffect(() => {
    if (!campusView) return;
    const frame = () => ({ bounds: campusBounds(), home: campusHome(placedHalls()) });
    rig.setCampus(frame());
    return subscribeCampus(() => {
      rig.setCampus(frame());
      driverRef.current?.invalidateFrozen();
    });
  }, [rig, campusView]);

  useEffect(() => {
    rig.setViewport({ width: size.width, height: size.height });
    refit.current();
    controlsRef.current?.syncLimits();
    driverRef.current?.invalidateFrozen();
  }, [rig, size]);

  useEffect(
    () =>
      rig.subscribe((camera) => {
        set({ camera });
        controlsRef.current?.syncLimits();
        driverRef.current?.notifyCameraMotion();
        driverRef.current?.invalidateFrozen();
      }),
    [rig, set],
  );

  // A glide or key step wakes the loop from calm mode and drops any damping left from a drag.
  useEffect(
    () =>
      wakeOnRigMotion(
        rig,
        () => controlsRef.current,
        () => {
          driverRef.current?.notifyCameraMotion();
          driverRef.current?.invalidateFrozen();
        },
      ),
    [rig],
  );

  // The glide frames the target inside the safe area and follows it while it changes (S-RW37).
  useEffect(() => {
    const key = () => {
      const f = rig.framing;
      return [
        f.target.x,
        f.target.y,
        f.target.z,
        f.zoom,
        f.azimuth,
        f.elevation,
        rig.projection,
      ].join();
    };
    refit.current = () => {
      if (!campusView) return;
      if (startupKey.current !== null && key() !== startupKey.current) return;
      rig.home(0);
      startupKey.current = key();
    };
    rig.setSafeArea(useStore.getState().safeArea);
    rig.setHomeArea(useStore.getState().homeArea);
    refit.current();
    return useStore.subscribe((state, previous) => {
      if (state.safeArea !== previous.safeArea) rig.setSafeArea(state.safeArea);
      if (state.homeArea === previous.homeArea) return;
      rig.setHomeArea(state.homeArea);
      refit.current();
    });
  }, [rig, campusView]);

  // Map controls, the keyboard and the double-click home. The look-dev view stays a fixed shot.
  useEffect(() => {
    if (!interactive) return;
    const el = gl.domElement;
    const controls = createCameraControls(rig, el, {
      reducedMotion: () => useStore.getState().reducedMotion,
      onChange: () => {
        driverRef.current?.notifyCameraMotion();
        driverRef.current?.invalidateFrozen();
      },
    });
    controlsRef.current = controls;
    const stopReduced = useStore.subscribe((state, previous) => {
      if (state.reducedMotion !== previous.reducedMotion) {
        controls.setReducedMotion(state.reducedMotion);
      }
    });
    const detachKeys = attachCameraKeys(
      el,
      { rig, safeArea: () => useStore.getState().safeArea, stepMs: uiDurationMs },
      CAMERA_HELP_ID,
    );
    const onDoubleClick = (event: MouseEvent) => {
      const box = el.getBoundingClientRect();
      const ndc = {
        x: ((event.clientX - box.left) / box.width) * 2 - 1,
        y: -((event.clientY - box.top) / box.height) * 2 + 1,
      };
      if (isEmptyGround(scene, rig.active, ndc)) rig.home();
    };
    el.addEventListener("dblclick", onDoubleClick);

    return () => {
      el.removeEventListener("dblclick", onDoubleClick);
      detachKeys();
      stopReduced();
      controls.dispose();
      controlsRef.current = null;
    };
  }, [gl, scene, rig, interactive]);

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
      update: (now, interval) => stepCamera(rig, controlsRef.current, now, interval),
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
        frameErrors: driver.errorCount + shaderErrorCount(),
        projection: rig.projection,
        bloom: control.bloom,
        composerReady: control.composerReady,
        composerGen: control.composerGen,
      }),
      toggleProjection: () => rig.toggle(),
      glideTest: () => {
        const out = rig.framing.target.distanceTo(GLIDE_TEST.far) > 0.5;
        if (out) rig.glideTo(GLIDE_TEST.far, GLIDE_TEST.zoom);
        else rig.glideTo(new Vector3(0, 0, 0), ORTHO_ZOOM.default);
      },
      camera: () => ({
        target: rig.framing.target.toArray(),
        zoom: rig.framing.zoom,
        azimuth: rig.framing.azimuth,
        elevation: rig.framing.elevation,
        projection: rig.projection,
        animating: rig.animating,
      }),
      project: (point: [number, number, number]) => rig.project(new Vector3(...point)),
      lights: () => {
        const counts: Record<string, number> = {};
        scene.traverse((object) => {
          if ((object as { isLight?: boolean }).isLight) {
            counts[object.type] = (counts[object.type] ?? 0) + 1;
          }
        });
        return counts;
      },
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
  }, [advance, gl, scene, rig, params.calm, params.freeze, control, onReady]);

  return null;
}

function Scene({ params, onReady }: { params: AppParams; onReady: (ready: boolean) => void }) {
  // Throws WebGLUnavailableError, which the outer boundary maps to the WebGL card.
  useState(() => precheckWebgl(params.webgl));

  const quality = useStore((s) => s.quality);
  const settings = qualitySettings(quality);
  const lookdev = params.view === "lookdev";
  const [rig] = useState(() => {
    const created = createCameraRig(
      { width: window.innerWidth, height: window.innerHeight },
      { reducedMotion: () => useStore.getState().reducedMotion },
    );
    if (lookdev) {
      created.setFraming({
        target: new Vector3(...LOOKDEV_FRAMING.target),
        zoom: LOOKDEV_FRAMING.zoom,
      });
    } else if (params.view === "hall" || params.view === "racks") {
      created.setFraming({
        target: new Vector3(...HALL_FRAMING.target),
        zoom: HALL_FRAMING.zoom,
      });
    }
    return created;
  });
  const [control] = useState(() => new SceneControl());
  const [composer, setComposer] = useState(INITIAL_COMPOSER);
  const [thrown, setThrown] = useState<string | null>(null);
  const [composerBoom, setComposerBoom] = useState(false);
  const [contentMounted, setContentMounted] = useState(true);
  const mountWaiter = useRef<(() => void) | null>(null);
  const unmountWaiter = useRef<(() => void) | null>(null);
  const onContentMount = useCallback(() => mountWaiter.current?.(), []);
  const onContentUnmount = useCallback(() => unmountWaiter.current?.(), []);

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
      remountContent: async () => {
        const unmounted = new Promise<void>((resolve) => (unmountWaiter.current = resolve));
        setContentMounted(false);
        await unmounted;
        const mounted = new Promise<void>((resolve) => (mountWaiter.current = resolve));
        setContentMounted(true);
        await mounted;
      },
    });
  }, [params.dev, control]);

  return (
    <div className="pointer-events-auto absolute inset-0">
      {!lookdev && (
        <p id={CAMERA_HELP_ID} className="sr-only">
          {CAMERA_HELP}
        </p>
      )}
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
          bloom={bloom}
        />
        <SceneContentBoundary stopDriver={() => control.stopDriver()}>
          {contentMounted && (
            <SignalsScope view={params.view} seed={params.seed}>
              {lookdev ? (
                <LookDevScene shadows={settings.shadows} rig={rig} />
              ) : params.view === "hall" || params.view === "racks" ? (
                <HallScene shadows={settings.shadows} rig={rig} frozen={params.freeze} />
              ) : (
                <CampusScene
                  shadows={settings.shadows}
                  rig={rig}
                  frozen={params.freeze}
                  seed={params.seed}
                />
              )}
              <MountSignal onMount={onContentMount} onUnmount={onContentUnmount} />
            </SignalsScope>
          )}
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
