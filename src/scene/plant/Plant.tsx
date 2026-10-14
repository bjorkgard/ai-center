import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { useStore } from "../../app/store/index.ts";
import { useSignals } from "../signals.ts";
import { buildPlant, type PlantLayout } from "./buildPlant.ts";

// The cooling plant: towers, chillers, turning fans and the vapour (chunk 09). Every frame it
// reads the duty, each particle's age and each fan's angle from SceneSignals at scene time.
export function Plant({ seed, layout }: { seed: number; layout?: PlantLayout }) {
  const signals = useSignals();
  const built = useMemo(() => buildPlant(seed, layout), [seed, layout]);
  useEffect(() => () => built.dispose(), [built]);
  useFrame((state) => {
    built.update(signals, state.clock.elapsedTime, state.camera, useStore.getState().reducedMotion);
  });
  return <primitive object={built.group} dispose={null} />;
}
