import { useMemo } from "react";
import type { Material } from "three";
import { Ground } from "./Ground.tsx";
import { LightRig } from "./LightRig.tsx";
import type { CameraRig } from "./camera.ts";
import { Hall, SignPanelMesh } from "./hall/Hall.tsx";
import { SLAB, createLookDevSignals, type Vec3 } from "./lookdevLayout.ts";
import { MATERIALS } from "./materials.ts";
import { SignalsContext, useSignals } from "./signals.ts";

// A box on a library material, placed by its centre.
function Block(props: { at: Vec3; size: Vec3; material: Material; shadow?: boolean }) {
  const { at, size, material, shadow = true } = props;
  return (
    <mesh position={at} material={material} castShadow={shadow} receiveShadow>
      <boxGeometry args={size} />
    </mesh>
  );
}

// Vendor trim along the slab's front edge, and a cyan fibre run with a bend on the ground.
function Trim() {
  const z = SLAB.depth / 2 + 0.06;
  return (
    <>
      <Block
        at={[-2.5, 0.1, z]}
        size={[2.8, 0.12, 0.12]}
        material={MATERIALS.claude}
        shadow={false}
      />
      <Block
        at={[2.5, 0.1, z]}
        size={[2.8, 0.12, 0.12]}
        material={MATERIALS.codex}
        shadow={false}
      />
      <Block
        at={[0.4, 0.05, 3.7]}
        size={[8.8, 0.1, 0.1]}
        material={MATERIALS.fibre}
        shadow={false}
      />
      <Block
        at={[4.8, 0.05, 1.6]}
        size={[0.1, 0.1, 4.2]}
        material={MATERIALS.fibre}
        shadow={false}
      />
    </>
  );
}

// The look-dev vignette (CEO C17): every material of the library once, under the shared rig.
// Later chunks add their materials here.
export function LookDevScene({ shadows, rig }: { shadows: boolean; rig: CameraRig }) {
  // The 8-rack row is the hall's own instances, fed a fixed row of statuses.
  const base = useSignals();
  const signals = useMemo(() => createLookDevSignals(base), [base]);
  return (
    <SignalsContext.Provider value={signals}>
      <LightRig shadows={shadows} />
      <Ground />
      <Hall />
      <SignPanelMesh rig={rig} frozen />
      <Trim />
    </SignalsContext.Provider>
  );
}
