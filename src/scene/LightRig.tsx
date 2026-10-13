import { RENDER } from "./render.ts";

const SHADOW_EXTENT = 12;

// The lighting rig every view shares (design D14): hemisphere, one shadow-casting
// directional and a low night fill.
export function LightRig({ shadows }: { shadows: boolean }) {
  const { hemisphere, moon, fill } = RENDER.rig;
  return (
    <>
      <hemisphereLight args={[hemisphere.sky, hemisphere.ground, hemisphere.intensity]} />
      <ambientLight color={fill.color} intensity={fill.intensity} />
      <directionalLight
        color={moon.color}
        intensity={moon.intensity}
        position={moon.position}
        castShadow={shadows}
        shadow-mapSize={[RENDER.shadow.mapSize, RENDER.shadow.mapSize]}
        shadow-bias={moon.shadowBias}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
      />
    </>
  );
}
