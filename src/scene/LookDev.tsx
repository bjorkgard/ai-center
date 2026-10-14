import { useEffect, useMemo } from "react";
import type { Material } from "three";
import { Ground } from "./Ground.tsx";
import { LightRig } from "./LightRig.tsx";
import type { CameraRig } from "./camera.ts";
import { fenceBayGeometry, treeGeometry } from "./campus/parts.ts";
import { Hall, SignPanelMesh } from "./hall/Hall.tsx";
import { SLAB, createLookDevSignals, type Vec3 } from "./lookdevLayout.ts";
import { PACKET } from "./fibre/packets.ts";
import { MATERIALS } from "./materials.ts";
import { Plant } from "./plant/Plant.tsx";
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
      {[-2.2, 0.6, 3.4].map((x) => (
        <mesh key={x} position={[x, 0.13, 3.7]} material={MATERIALS.packet}>
          <sphereGeometry args={[PACKET.radius, 8, 4]} />
        </mesh>
      ))}
    </>
  );
}

// One tree and one fence bay from the campus parts (chunk 08), on the shared tree and concrete
// materials, beside the hall.
function SitePair() {
  const tree = useMemo(() => treeGeometry(), []);
  const bay = useMemo(() => fenceBayGeometry(), []);
  useEffect(
    () => () => {
      tree.dispose();
      bay.dispose();
    },
    [tree, bay],
  );
  return (
    <>
      <mesh
        geometry={tree}
        material={MATERIALS.tree}
        position={[-5.6, 0, 3.4]}
        castShadow
        receiveShadow
      />
      <mesh geometry={bay} material={MATERIALS.concrete} position={[-3.4, 0, 5.4]} receiveShadow />
    </>
  );
}

// One cooling tower with its vapour and fan (chunk 09), beside the hall; the tower is tower 0 of
// the plant, so it reads that tower's particles.
const TOWER_SPOT = { towers: [{ x: 6.2, z: -2.6 }], chillers: [] };

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
      <SitePair />
      <Plant seed={1} layout={TOWER_SPOT} />
    </SignalsContext.Provider>
  );
}
