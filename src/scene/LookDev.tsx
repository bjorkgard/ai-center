import type { Material } from "three";
import { Ground } from "./Ground.tsx";
import { LightRig } from "./LightRig.tsx";
import type { CameraRig } from "./camera.ts";
import { Hall, SignPanelMesh } from "./hall/Hall.tsx";
import { LED, RACK, RACKS, SLAB, ledPlacements, rackX, type Vec3 } from "./lookdevLayout.ts";
import { MATERIALS, statusLed } from "./materials.ts";

// A box on a library material, placed by its centre.
function Block(props: { at: Vec3; size: Vec3; material: Material; shadow?: boolean }) {
  const { at, size, material, shadow = true } = props;
  return (
    <mesh position={at} material={material} castShadow={shadow} receiveShadow>
      <boxGeometry args={size} />
    </mesh>
  );
}

// 8-rack row, four status LEDs on each (the layout and statuses live in lookdevLayout.ts).
function RackRow() {
  return (
    <>
      {Array.from({ length: RACKS }, (_, i) => (
        <Block
          key={i}
          at={[rackX(i), SLAB.height + RACK.height / 2, RACK.z]}
          size={[RACK.width, RACK.height, RACK.depth]}
          material={MATERIALS.rack}
        />
      ))}
      {ledPlacements().map(({ status, at }, n) => (
        <Block key={n} at={at} size={LED.size} material={statusLed(status)} shadow={false} />
      ))}
    </>
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
  return (
    <>
      <LightRig shadows={shadows} />
      <Ground />
      <Hall />
      <SignPanelMesh rig={rig} frozen />
      <RackRow />
      <Trim />
    </>
  );
}
