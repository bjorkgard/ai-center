import { Raycaster, Vector2, type Camera, type Mesh, type Object3D } from "three";

const raycaster = new Raycaster();

// True when the nearest mesh under the pointer is the ground (`userData.ground`). Lines such as
// the grid are skipped, and a click on nothing at all is not empty ground.
export function isEmptyGround(
  scene: Object3D,
  camera: Camera,
  ndc: { x: number; y: number },
): boolean {
  const meshes: Mesh[] = [];
  scene.traverse((object) => {
    if ((object as Mesh).isMesh) meshes.push(object as Mesh);
  });
  raycaster.setFromCamera(new Vector2(ndc.x, ndc.y), camera);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  return hit?.object.userData.ground === true;
}
