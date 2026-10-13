import {
  BloomEffect,
  EffectComposer,
  EffectPass,
  RenderPass,
  ToneMappingEffect,
} from "postprocessing";
import {
  AmbientLight,
  BoxGeometry,
  Color,
  DirectionalLight,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  NoToneMapping,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { DrawCallCounter, type SpikeViewHandle } from "../shared/bench.ts";
import { writeLedColors, type FakeStore } from "../shared/fakeStore.ts";
import {
  ComposerInitError,
  RENDER,
  applyRendererSettings,
  configureCamera,
  configureLight,
  createSharedMaterials,
} from "../shared/render.ts";
import {
  fillLedMatrices,
  fillRackMatrices,
  hallOrigin,
  hallSize,
  ledsPerHall,
  racksPerHall,
  BASE_HALLS,
  type Load,
} from "../shared/scene.ts";

export interface VanillaView extends SpikeViewHandle {
  setBloom(on: boolean): void;
  dispose(): void;
}

interface Hall {
  index: number;
  group: Group;
  slab: Mesh;
  racks: InstancedMesh;
  leds: InstancedMesh;
  seen: number;
  unsubscribe(): void;
}

// Direct three.js: a WebGLRenderer, the pmndrs postprocessing composer and
// explicit disposal. Everything the R3F view declares in JSX is spelled out here.
export function createVanillaView(
  container: HTMLElement,
  opts: { load: Load; bloom: boolean; store: FakeStore },
): VanillaView {
  const { load, store } = opts;
  const renderer = new WebGLRenderer({ ...RENDER.renderer });
  applyRendererSettings(renderer);
  const counter = new DrawCallCounter(renderer.info);
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  container.appendChild(canvas);

  const scene = new Scene();
  scene.background = new Color(RENDER.background);
  scene.add(new AmbientLight(RENDER.ambient.color, RENDER.ambient.intensity));
  const light = new DirectionalLight(RENDER.light.color, RENDER.light.intensity);
  configureLight(light, load);
  scene.add(light, light.target);
  const camera = new PerspectiveCamera();
  configureCamera(camera, load);
  const shared = createSharedMaterials();

  const halls: Hall[] = [];
  let composer: EffectComposer | null = null;

  const size = { width: 0, height: 0 };
  const resize = () => {
    size.width = container.clientWidth;
    size.height = container.clientHeight;
    renderer.setSize(size.width, size.height);
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
    composer?.setSize(size.width, size.height);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  function createHall(index: number): Hall {
    const dims = hallSize(load);
    const origin = hallOrigin(index, load);
    const slab = new Mesh(new BoxGeometry(dims.width, dims.height, dims.depth), shared.hall);
    slab.position.y = dims.height / 2;
    slab.receiveShadow = true;
    const racks = new InstancedMesh(new BoxGeometry(1, 1, 1), shared.rack, racksPerHall(load));
    fillRackMatrices(racks.instanceMatrix.array as Float32Array, load);
    racks.castShadow = true;
    racks.receiveShadow = true;
    const leds = new InstancedMesh(new BoxGeometry(1, 1, 1), shared.led, ledsPerHall(load));
    fillLedMatrices(leds.instanceMatrix.array as Float32Array, load);
    leds.instanceColor = new InstancedBufferAttribute(new Float32Array(ledsPerHall(load) * 3), 3);
    writeLedColors(leds.instanceColor.array as Float32Array, store.values(index));
    const group = new Group();
    group.position.set(origin.x, 0, origin.z);
    group.add(slab, racks, leds);
    const hall: Hall = {
      index,
      group,
      slab,
      racks,
      leds,
      seen: 0,
      unsubscribe: store.subscribe((version) => {
        hall.seen = version;
      }),
    };
    return hall;
  }

  function disposeHall(hall: Hall) {
    hall.unsubscribe();
    scene.remove(hall.group);
    hall.slab.geometry.dispose();
    hall.racks.geometry.dispose();
    hall.leds.geometry.dispose();
    hall.racks.dispose();
    hall.leds.dispose();
  }

  function buildComposer(): EffectComposer {
    try {
      const built = new EffectComposer(renderer, { ...RENDER.composer });
      built.addPass(new RenderPass(scene, camera));
      built.addPass(
        new EffectPass(
          camera,
          new BloomEffect({ ...RENDER.bloom }),
          new ToneMappingEffect({ ...RENDER.toneMappingEffect }),
        ),
      );
      built.setSize(size.width, size.height);
      return built;
    } catch (err) {
      throw new ComposerInitError(err instanceof Error ? err.message : String(err));
    }
  }

  function setBloom(on: boolean) {
    if (on && !composer) {
      composer = buildComposer();
      renderer.toneMapping = NoToneMapping;
    } else if (!on && composer) {
      composer.dispose();
      composer = null;
      renderer.toneMapping = RENDER.toneMapping;
    }
  }

  function addHalls(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const hall = createHall(halls.length);
      halls.push(hall);
      scene.add(hall.group);
    }
    return Promise.resolve();
  }

  for (let i = 0; i < BASE_HALLS; i++) {
    const hall = createHall(i);
    halls.push(hall);
    scene.add(hall.group);
  }

  const view: VanillaView = {
    canvas,
    frame() {
      counter.begin();
      for (let i = 0; i < halls.length; i++) {
        const colours = halls[i].leds.instanceColor!;
        writeLedColors(colours.array as Float32Array, store.values(halls[i].index));
        colours.needsUpdate = true;
      }
      if (composer) composer.render(0);
      else renderer.render(scene, camera);
      counter.end();
    },
    addHalls,
    removeHalls(n) {
      for (let i = 0; i < n; i++) disposeHall(halls.pop()!);
      return Promise.resolve();
    },
    snapshot() {
      let racks = 0;
      let leds = 0;
      for (const hall of halls) {
        racks += hall.racks.count;
        leds += hall.leds.count;
      }
      return {
        halls: halls.length,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        programs: renderer.info.programs?.length ?? 0,
        drawCalls: counter.calls,
        rackInstances: racks,
        ledInstances: leds,
        storeListeners: store.listenerCount,
        sharedMaterialDisposeEvents: shared.disposeEvents(),
      };
    },
    setBloom,
    dispose() {
      observer.disconnect();
      while (halls.length > 0) disposeHall(halls.pop()!);
      composer?.dispose();
      composer = null;
      shared.dispose();
      renderer.dispose();
      canvas.remove();
    },
  };
  try {
    setBloom(opts.bloom);
  } catch (err) {
    view.dispose();
    throw err;
  }
  return view;
}
