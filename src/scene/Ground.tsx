import { useEffect, useMemo } from "react";
import { BufferGeometry, Float32BufferAttribute } from "three";
import { MATERIALS } from "./materials.ts";

const SIZE = 40;

// Line pairs for a square grid, one unit apart, laid just above the plane.
function gridGeometry(size: number): BufferGeometry {
  const half = size / 2;
  const points: number[] = [];
  for (let i = -half; i <= half; i++) {
    points.push(i, 0, -half, i, 0, half, -half, 0, i, half, 0, i);
  }
  return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
}

// The ground plane with its subtle grid, both on library materials.
export function Ground() {
  const grid = useMemo(() => gridGeometry(SIZE), []);
  useEffect(() => () => grid.dispose(), [grid]);
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={MATERIALS.ground} receiveShadow>
        <planeGeometry args={[SIZE, SIZE]} />
      </mesh>
      <lineSegments geometry={grid} material={MATERIALS.grid} position={[0, 0.01, 0]} />
    </>
  );
}
