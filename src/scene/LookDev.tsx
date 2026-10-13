import type { Material } from "three";
import { Ground } from "./Ground.tsx";
import { LightRig } from "./LightRig.tsx";
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

const WALL = { height: 1.8, thickness: 0.4 };
const WINDOWS = 7;

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

function Hall() {
  const wallZ = -SLAB.depth / 2 + WALL.thickness / 2;
  const wallFaceZ = wallZ + WALL.thickness / 2;
  const wallY = SLAB.height + WALL.height / 2;
  return (
    <>
      <Block
        at={[0, SLAB.height / 2, 0]}
        size={[SLAB.width, SLAB.height, SLAB.depth]}
        material={MATERIALS.concrete}
      />
      <Block
        at={[0, wallY, wallZ]}
        size={[SLAB.width, WALL.height, WALL.thickness]}
        material={MATERIALS.slate}
      />
      <Block
        at={[0, SLAB.height + WALL.height + 0.05, wallZ]}
        size={[SLAB.width + 0.2, 0.1, WALL.thickness + 0.2]}
        material={MATERIALS.roof}
      />
      {Array.from({ length: WINDOWS }, (_, i) => (
        <Block
          key={i}
          at={[(i - (WINDOWS - 1) / 2) * 1.1, wallY + 0.35, wallFaceZ + 0.02]}
          size={[0.5, 0.35, 0.04]}
          material={MATERIALS.window}
          shadow={false}
        />
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
        at={[-2, 0.1, z]}
        size={[3.6, 0.12, 0.12]}
        material={MATERIALS.claude}
        shadow={false}
      />
      <Block at={[2, 0.1, z]} size={[3.6, 0.12, 0.12]} material={MATERIALS.codex} shadow={false} />
      <Block
        at={[0.4, 0.05, 3.1]}
        size={[8.8, 0.1, 0.1]}
        material={MATERIALS.fibre}
        shadow={false}
      />
      <Block at={[4.8, 0.05, 1]} size={[0.1, 0.1, 4.2]} material={MATERIALS.fibre} shadow={false} />
    </>
  );
}

// The look-dev vignette (CEO C17): every material of the library once, under the shared rig.
// Later chunks add their materials here.
export function LookDevScene({ shadows }: { shadows: boolean }) {
  return (
    <>
      <LightRig shadows={shadows} />
      <Ground />
      <Hall />
      <RackRow />
      <Trim />
    </>
  );
}
