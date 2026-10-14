import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { BufferGeometry, Float32BufferAttribute } from "three";
import { useStore } from "../../app/store/index.ts";
import type { CameraRig } from "../camera.ts";
import { Hall, SignPanelMesh } from "../hall/Hall.tsx";
import { getSignAtlas } from "../hall/signAtlas.ts";
import { Ground } from "../Ground.tsx";
import { LightRig } from "../LightRig.tsx";
import { MATERIALS } from "../materials.ts";
import { buildCampus } from "./buildCampus.ts";
import { placedHalls, showWaypoints, subscribeCampus } from "./campusDev.ts";
import { groundArea, shadowRadius, slotPosition } from "./layout.ts";
import { Plant } from "../plant/Plant.tsx";
import { buildWaypoints } from "./waypoints.ts";

// The waypoint graph as line segments just above the roads (dev toggle, CEO W-RW12).
function WaypointLines() {
  const geometry = useMemo(() => {
    const graph = buildWaypoints();
    const at = new Map(graph.nodes.map((n) => [n.id, n]));
    const points: number[] = [];
    for (const [a, b] of graph.edges) {
      const p = at.get(a)!;
      const q = at.get(b)!;
      points.push(p.x, 0.15, p.z, q.x, 0.15, q.z);
    }
    return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(points, 3));
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <lineSegments geometry={geometry} material={MATERIALS.waypoints} />;
}

// The campus view (chunk 08): the ground, the light, the site furniture, the cooling plant
// (chunk 09) and the placed halls. A, B
// and any further placed hall stand in their slots; every other slot shows its pad. The marks
// (pad numbers, monument wordmark) re-check the camera on every frame and fade 200 ms; frozen
// frames and reduced motion cut the fade.
export function CampusScene({
  shadows,
  rig,
  frozen,
  seed,
}: {
  shadows: boolean;
  rig: CameraRig;
  frozen: boolean;
  seed: number;
}) {
  const atlas = useMemo(() => getSignAtlas(), []);
  const built = useMemo(() => buildCampus(seed, atlas), [seed, atlas]);
  const placed = useSyncExternalStore(subscribeCampus, placedHalls);
  const waypoints = useSyncExternalStore(subscribeCampus, showWaypoints);

  useEffect(() => built.setPlaced(placed), [built, placed]);
  useEffect(() => () => built.dispose(), [built]);
  useFrame(() => {
    const snap = frozen || useStore.getState().reducedMotion;
    built.marks.update(rig, performance.now(), snap);
    built.monument.update(rig, performance.now(), snap);
  });

  return (
    <>
      <LightRig shadows={shadows} radius={shadowRadius()} />
      <Ground area={groundArea()} />
      <primitive object={built.group} dispose={null} />
      <Plant seed={seed} />
      {Array.from({ length: placed }, (_, slot) => {
        const { x, z } = slotPosition(slot);
        return <Hall key={slot} slot={slot} at={[x, 0, z]} />;
      })}
      <SignPanelMesh rig={rig} frozen={frozen} />
      {waypoints && <WaypointLines />}
    </>
  );
}
