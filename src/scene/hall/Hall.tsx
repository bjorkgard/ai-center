import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { useStore } from "../../app/store/index.ts";
import type { CameraRig } from "../camera.ts";
import { buildHall } from "./buildHall.ts";
import { getSignAtlas } from "./signAtlas.ts";
import { SignBinding, getSignPanels } from "./signPanels.ts";

// Until chunk 08 places halls and chunk 18 feeds real names, hall A carries a fictional name
// (never read from the machine, D16).
const PLACEHOLDER = { letter: "A", project: "Northwind" };

// A stable default, so a parent re-render does not re-register the panel.
const ORIGIN: [number, number, number] = [0, 0, 0];

interface HallProps {
  // The hall's slot 0-11: its sign atlas region and its panel instance.
  slot?: number;
  at?: [number, number, number];
}

// One data hall at `at`: the merged body and the windows. The roof state is the shared clipping
// plane (roof.ts); its sign panel is an instance of the one shared panel mesh (SignPanelMesh).
export function Hall({ slot = 0, at = ORIGIN }: HallProps) {
  const built = useMemo(() => buildHall({ slots: 16, rows: 2 }), []);
  const atlas = useMemo(() => getSignAtlas(), []);
  const panels = useMemo(() => getSignPanels(), []);
  const binding = useMemo(() => new SignBinding(panels, built.signCentre), [panels, built]);

  useEffect(() => {
    atlas.setSign(slot, PLACEHOLDER.letter, PLACEHOLDER.project);
  }, [atlas, slot]);

  // Runs after every render but acts only when the slot or the position's numbers change.
  useEffect(() => binding.sync(slot, at));
  useEffect(() => () => binding.release(), [binding]);

  useEffect(() => () => built.dispose(), [built]);

  return (
    <group position={at}>
      <primitive object={built.body} dispose={null} />
      <primitive object={built.windows} dispose={null} />
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
