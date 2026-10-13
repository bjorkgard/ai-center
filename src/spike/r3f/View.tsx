import { Canvas, type RootState } from "@react-three/fiber";
import { Bloom, EffectComposer, ToneMapping } from "@react-three/postprocessing";
import type { EffectComposer as EffectComposerImpl } from "postprocessing";
import {
  Component,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  InstancedBufferAttribute,
  type DirectionalLight,
  type InstancedMesh,
  type PerspectiveCamera,
} from "three";
import { DrawCallCounter, type SpikeViewHandle } from "../shared/bench.ts";
import { writeLedColors, type FakeStore } from "../shared/fakeStore.ts";
import {
  RENDER,
  applyRendererSettings,
  configureCamera,
  configureLight,
  createSharedMaterials,
  pixelRatio,
  type SharedMaterials,
} from "../shared/render.ts";
import {
  BASE_HALLS,
  fillLedMatrices,
  fillRackMatrices,
  hallOrigin,
  hallSize,
  ledsPerHall,
  racksPerHall,
  type Load,
} from "../shared/scene.ts";

export type R3FErrorKind = "init" | "composer" | "churn";

interface HallEntry {
  index: number;
  racks: InstancedMesh;
  leds: InstancedMesh;
  seen: number;
}

// Imperative side of the view: the frame writer, hall registry and the promises
// that tell the bench when React has actually mounted or unmounted halls.
class Controller {
  readonly entries: HallEntry[] = [];
  readonly shared: SharedMaterials = createSharedMaterials();
  readonly load: Load;
  readonly store: FakeStore;
  desired = BASE_HALLS;
  private bloom: boolean;
  state: RootState | null = null;
  private counter: DrawCallCounter | null = null;
  private composer: EffectComposerImpl | null = null;
  private reported = false;
  private countListeners = new Set<() => void>();
  private waiters: (() => void)[] = [];
  private onReady: (view: SpikeViewHandle) => void;
  private onError: (kind: R3FErrorKind, error: Error) => void;

  constructor(opts: {
    load: Load;
    bloom: boolean;
    store: FakeStore;
    onReady: (view: SpikeViewHandle) => void;
    onError: (kind: R3FErrorKind, error: Error) => void;
  }) {
    this.load = opts.load;
    this.bloom = opts.bloom;
    this.store = opts.store;
    this.onReady = opts.onReady;
    this.onError = opts.onError;
  }

  readonly view: SpikeViewHandle = {
    canvas: undefined as unknown as HTMLCanvasElement,
    frame: (t) => {
      const state = this.state;
      if (!state) return;
      this.counter!.begin();
      for (let i = 0; i < this.entries.length; i++) {
        const entry = this.entries[i];
        const colours = entry.leds.instanceColor!;
        writeLedColors(colours.array as Float32Array, this.store.values(entry.index));
        colours.needsUpdate = true;
      }
      state.advance(t);
      this.counter!.end();
    },
    addHalls: (n) => {
      this.desired += n;
      this.notifyCount();
      return this.settled();
    },
    removeHalls: (n) => {
      this.desired -= n;
      this.notifyCount();
      return this.settled();
    },
    snapshot: () => {
      const info = this.state!.gl.info;
      let racks = 0;
      let leds = 0;
      for (const entry of this.entries) {
        leds += entry.leds.count;
        racks += entry.racks.count;
      }
      return {
        halls: this.entries.length,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
        programs: info.programs?.length ?? 0,
        drawCalls: this.counter!.calls,
        rackInstances: racks,
        ledInstances: leds,
        storeListeners: this.store.listenerCount,
        sharedMaterialDisposeEvents: this.shared.disposeEvents(),
      };
    },
  };

  setBloom(on: boolean) {
    this.bloom = on;
  }

  subscribeCount = (listener: () => void) => {
    this.countListeners.add(listener);
    return () => this.countListeners.delete(listener);
  };
  getCount = () => this.desired;

  private notifyCount() {
    for (const listener of this.countListeners) listener();
  }

  // Resolves once the mounted halls match the requested count (E16).
  private settled(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      this.check();
    });
  }

  mounted(entry: HallEntry) {
    this.entries.push(entry);
    this.check();
  }

  unmounted(entry: HallEntry) {
    this.entries.splice(this.entries.indexOf(entry), 1);
    this.check();
  }

  created = (state: RootState) => {
    applyRendererSettings(state.gl);
    configureCamera(state.camera as PerspectiveCamera, this.load);
    this.counter = new DrawCallCounter(state.gl.info);
    this.state = state;
    (this.view as { canvas: HTMLCanvasElement }).canvas = state.gl.domElement;
    this.check();
  };

  bindLight(light: DirectionalLight | null) {
    if (light) configureLight(light, this.load);
  }

  bindComposer(composer: EffectComposerImpl | null | undefined) {
    this.composer = composer ?? null;
    if (!composer) return;
    const started = performance.now();
    const poll = () => {
      if (this.composer !== composer) return;
      if (composer.passes.length >= 2) this.check();
      else if (performance.now() - started > 5000) {
        this.onError("composer", new Error("composer never built its passes"));
      } else setTimeout(poll, 16);
    };
    poll();
  }

  fail(kind: R3FErrorKind, error: Error) {
    this.onError(kind, error);
  }

  private check() {
    if (this.entries.length === this.desired && this.waiters.length > 0) {
      const waiting = this.waiters;
      this.waiters = [];
      for (const resolve of waiting) resolve();
    }
    const composerReady =
      !this.bloom || (this.composer !== null && this.composer.passes.length >= 2);
    if (
      !this.reported &&
      this.state &&
      this.entries.length === BASE_HALLS &&
      this.desired === BASE_HALLS &&
      composerReady
    ) {
      this.reported = true;
      this.onReady(this.view);
    }
  }
}

export class Boundary extends Component<
  { onError: (error: Error) => void; children?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// Each hall owns its geometry (declared as JSX children, which R3F disposes on
// unmount). The materials are shared and passed by prop, so R3F leaves them alone.
function Hall({ index, ctl }: { index: number; ctl: Controller }) {
  const racks = useRef<InstancedMesh>(null);
  const leds = useRef<InstancedMesh>(null);
  const size = hallSize(ctl.load);
  const origin = hallOrigin(index, ctl.load);

  useLayoutEffect(() => {
    const rackMesh = racks.current!;
    const ledMesh = leds.current!;
    fillRackMatrices(rackMesh.instanceMatrix.array as Float32Array, ctl.load);
    fillLedMatrices(ledMesh.instanceMatrix.array as Float32Array, ctl.load);
    ledMesh.instanceColor = new InstancedBufferAttribute(
      new Float32Array(ledsPerHall(ctl.load) * 3),
      3,
    );
    writeLedColors(ledMesh.instanceColor.array as Float32Array, ctl.store.values(index));
    const entry: HallEntry = { index, racks: rackMesh, leds: ledMesh, seen: 0 };
    const unsubscribe = ctl.store.subscribe((version) => {
      entry.seen = version;
    });
    ctl.mounted(entry);
    return () => {
      unsubscribe();
      ctl.unmounted(entry);
    };
  }, [ctl, index]);

  return (
    <group position={[origin.x, 0, origin.z]}>
      <mesh material={ctl.shared.hall} position={[0, size.height / 2, 0]} receiveShadow>
        <boxGeometry args={[size.width, size.height, size.depth]} />
      </mesh>
      <instancedMesh
        ref={racks}
        args={[undefined, undefined, racksPerHall(ctl.load)]}
        material={ctl.shared.rack}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
      <instancedMesh
        ref={leds}
        args={[undefined, undefined, ledsPerHall(ctl.load)]}
        material={ctl.shared.led}
      >
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>
    </group>
  );
}

function Halls({ ctl }: { ctl: Controller }) {
  const count = useSyncExternalStore(ctl.subscribeCount, ctl.getCount);
  return Array.from({ length: count }, (_, i) => <Hall key={i} index={i} ctl={ctl} />);
}

export function R3FView(props: {
  load: Load;
  bloom: boolean;
  store: FakeStore;
  onReady: (view: SpikeViewHandle) => void;
  onError: (kind: R3FErrorKind, error: Error) => void;
}) {
  const { load, store, bloom } = props;
  const [ctl] = useState(
    () =>
      new Controller({
        load,
        bloom,
        store,
        onReady: props.onReady,
        onError: props.onError,
      }),
  );
  useLayoutEffect(() => {
    ctl.setBloom(bloom);
  }, [ctl, bloom]);
  const attachLight = useCallback((light: DirectionalLight | null) => ctl.bindLight(light), [ctl]);
  const attachComposer = useCallback(
    (composer: EffectComposerImpl | null | undefined) => ctl.bindComposer(composer),
    [ctl],
  );

  return (
    <div className="absolute inset-0">
      <Boundary onError={(error) => ctl.fail("init", error)}>
        <Canvas
          frameloop="never"
          dpr={pixelRatio()}
          gl={RENDER.renderer}
          shadows={{ enabled: true, type: RENDER.shadow.type }}
          camera={{ fov: 40, near: RENDER.camera.near, far: RENDER.camera.far * load }}
          onCreated={(state) => ctl.created(state)}
        >
          <color attach="background" args={[RENDER.background]} />
          <ambientLight color={RENDER.ambient.color} intensity={RENDER.ambient.intensity} />
          <directionalLight
            ref={attachLight}
            color={RENDER.light.color}
            intensity={RENDER.light.intensity}
          />
          <Boundary onError={(error) => ctl.fail("churn", error)}>
            <Halls ctl={ctl} />
          </Boundary>
          {bloom && (
            <Boundary onError={(error) => ctl.fail("composer", error)}>
              <EffectComposer
                ref={attachComposer}
                multisampling={RENDER.composer.multisampling}
                frameBufferType={RENDER.composer.frameBufferType}
                depthBuffer={RENDER.composer.depthBuffer}
                stencilBuffer={RENDER.composer.stencilBuffer}
              >
                <Bloom {...RENDER.bloom} />
                <ToneMapping {...RENDER.toneMappingEffect} />
              </EffectComposer>
            </Boundary>
          )}
        </Canvas>
      </Boundary>
    </div>
  );
}
