import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { useStore } from "../../app/store/index.ts";
import type { CameraRig } from "../camera.ts";
import { useSignals } from "../signals.ts";
import { buildHall } from "./buildHall.ts";
import { RackInstances } from "./rackInstances.ts";
import { registerLeds, reportShown } from "./racksDev.ts";
import { getSignAtlas } from "./signAtlas.ts";
import { SignBinding, getSignPanels } from "./signPanels.ts";

// A stable default, so a parent re-render does not re-register the panel.
const ORIGIN: [number, number, number] = [0, 0, 0];

interface HallProps {
  // The hall's slot 0-11: its sign atlas region and its panel instance.
  slot?: number;
  at?: [number, number, number];
}

// One data hall at `at`: the merged body, the windows and its racks. The roof state is the shared
// clipping plane (roof.ts); its sign panel is an instance of the one shared panel mesh
// (SignPanelMesh). The hall owns one rack and one LED InstancedMesh, allocated once; every frame
// it reads its rack count and LED load from SceneSignals at scene time.
export function Hall({ slot = 0, at = ORIGIN }: HallProps) {
  const signals = useSignals();
  const sign = signals.hallSign(slot);
  const built = useMemo(() => buildHall({ slots: 16, rows: 2 }), []);
  const racks = useMemo(() => new RackInstances(), []);
  const atlas = useMemo(() => getSignAtlas(), []);
  const panels = useMemo(() => getSignPanels(), []);
  const binding = useMemo(() => new SignBinding(panels, built.signCentre), [panels, built]);

  // Runs after every render but acts only when the slot or the position's numbers change.
  useEffect(() => binding.sync(slot, at));
  useEffect(() => () => binding.release(), [binding]);

  // After the sync above: a hall that did not get the slot's panel leaves the slot's text alone.
  useEffect(() => {
    binding.writeSign(atlas, slot, sign.letter, sign.project);
  }, [atlas, binding, slot, sign.letter, sign.project]);

  useEffect(() => () => built.dispose(), [built]);
  useEffect(() => () => racks.dispose(), [racks]);
  useEffect(() => registerLeds(slot, racks), [slot, racks]);

  useFrame((state) => {
    racks.setRackCount(signals.rackCount(slot));
    reportShown(slot, racks.rackCount);
    racks.update(signals, slot, state.clock.elapsedTime, useStore.getState().reducedMotion);
  });

  return (
    <group position={at}>
      <primitive object={built.body} dispose={null} />
      <primitive object={built.windows} dispose={null} />
      <primitive object={racks.racks} dispose={null} />
      <primitive object={racks.leds} dispose={null} />
    </group>
  );
}

// The one draw for every hall's panel. Mount it once per view; it re-checks each panel against
// the camera on every frame, so any camera change (drag, glide, key, projection) is seen. Frozen
// frames and reduced motion cut the 200 ms fade.
export function SignPanelMesh({ rig, frozen }: { rig: CameraRig; frozen: boolean }) {
  const panels = useMemo(() => getSignPanels(), []);
  useEffect(() => () => panels.dispose(), [panels]);
  useFrame(() => {
    panels.update(rig, performance.now(), frozen || useStore.getState().reducedMotion);
  });
  return <primitive object={panels.mesh} dispose={null} />;
}
