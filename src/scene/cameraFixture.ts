import type { CampusFrame } from "./camera.ts";

// The campus the camera tests use: a 28 x 28 box about the origin, 3 high. The rig takes its
// bounds from `setCampus`, so the tests do not depend on the real campus layout.
export const FIXTURE_CAMPUS: CampusFrame = {
  bounds: { halfX: 14, halfZ: 14, maxY: 3 },
  home: { minX: -14, maxX: 14, minZ: -14, maxZ: 14, maxY: 3 },
};
