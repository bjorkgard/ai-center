import { useEffect, useMemo } from "react";
import { BufferGeometry, Float32BufferAttribute } from "three";
import { MATERIALS } from "./materials.ts";

// The ground plane's rectangle: centre and size in world units.
export interface GroundArea {
  cx: number;
  cz: number;
  width: number;
  depth: number;
  // Grid line spacing, 1 unit unless given: the campus draws one every 4.
  cell?: number;
}

// The hall and look-dev views stand on a 40 x 40 plane about the origin; the campus view passes
// the area derived from the campus extent (chunk 08).
const DEFAULT_AREA: GroundArea = { cx: 0, cz: 0, width: 40, depth: 40 };

// Line pairs for a grid whose lines sit on whole multiples of `cell` in world coordinates, in the
// plane's own coordinates (centre `cx`, `cz`), laid just above it.
function gridGeometry({ cx, cz, width, depth, cell = 1 }: GroundArea): BufferGeometry {
  const halfW = width / 2;
  const halfD = depth / 2;
  const points: number[] = [];
  for (let x = Math.ceil((cx - halfW) / cell) * cell; x <= cx + halfW; x += cell) {
    points.push(x - cx, 0, -halfD, x - cx, 0, halfD);
  }
  for (let z = Math.ceil((cz - halfD) / cell) * cell; z <= cz + halfD; z += cell) {
    points.push(-halfW, 0, z - cz, halfW, 0, z - cz);
  }
  return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
}

// The ground plane with its subtle grid, both on library materials.
export function Ground({ area = DEFAULT_AREA }: { area?: GroundArea }) {
  const { cx, cz, width, depth, cell = 1 } = area;
  const grid = useMemo(
    () => gridGeometry({ cx, cz, width, depth, cell }),
    [cx, cz, width, depth, cell],
  );
  useEffect(() => () => grid.dispose(), [grid]);
  return (
    <group position={[cx, 0, cz]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        material={MATERIALS.ground}
        userData={{ ground: true }}
        receiveShadow
      >
        <planeGeometry args={[width, depth]} />
      </mesh>
      <lineSegments geometry={grid} material={MATERIALS.grid} position={[0, 0.01, 0]} />
    </group>
  );
}
