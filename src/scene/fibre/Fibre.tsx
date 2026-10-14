import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useStore } from "../../app/store/index.ts";
import { placedHalls, subscribeCampus } from "../campus/campusDev.ts";
import { useSignals } from "../signals.ts";
import { buildFibre } from "./buildFibre.ts";

// The fibre lines and their packets (chunk 10). The lines are rebuilt when the placed-hall set
// changes and the old geometry is disposed (CEO W-RW11); every frame the packets read their
// phase from SceneSignals at scene time.
export function Fibre() {
  const signals = useSignals();
  const placed = useSyncExternalStore(subscribeCampus, placedHalls);
  const built = useMemo(() => buildFibre(placed), [placed]);
  useEffect(() => () => built.dispose(), [built]);
  useFrame((state) => {
    built.update(signals, state.clock.elapsedTime, useStore.getState().reducedMotion);
  });
  return <primitive object={built.group} dispose={null} />;
}
