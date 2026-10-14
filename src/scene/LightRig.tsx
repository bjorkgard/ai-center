import { Vector3 } from "three";
import { RENDER } from "./render.ts";

const SHADOW_EXTENT = 12;

// The campus view passes the radius of the shadow camera's square (chunk 08): the light then
// stands back along the same direction and the shadow camera covers the whole campus.
const LIGHT_DISTANCE = 1.5; // times the radius [estimated]
const SHADOW_FAR = 4; // times the radius

// The lighting rig every view shares (design D14): hemisphere, one shadow-casting
// directional and a low night fill.
export function LightRig({ shadows, radius }: { shadows: boolean; radius?: number }) {
  const { hemisphere, moon, fill } = RENDER.rig;
  const extent = radius ?? SHADOW_EXTENT;
  const position: [number, number, number] =
    radius === undefined
      ? [...moon.position]
      : new Vector3(...moon.position).setLength(radius * LIGHT_DISTANCE).toArray();
  return (
    <>
      <hemisphereLight args={[hemisphere.sky, hemisphere.ground, hemisphere.intensity]} />
      <ambientLight color={fill.color} intensity={fill.intensity} />
      <directionalLight
        color={moon.color}
        intensity={moon.intensity}
        position={position}
        castShadow={shadows}
        shadow-mapSize={[RENDER.shadow.mapSize, RENDER.shadow.mapSize]}
        shadow-bias={moon.shadowBias}
        shadow-camera-left={-extent}
        shadow-camera-right={extent}
        shadow-camera-top={extent}
        shadow-camera-bottom={-extent}
        {...(radius === undefined ? {} : { "shadow-camera-far": radius * SHADOW_FAR })}
      />
    </>
  );
}
