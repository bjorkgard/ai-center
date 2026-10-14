import { OrthographicCamera, Vector3 } from "three";
import { expect, test } from "vite-plus/test";
import { createFakeSignals } from "../fake.ts";
import { MATERIALS } from "../materials.ts";
import { VAPOUR_DRAWS, buildPlant } from "./buildPlant.ts";
import { TOWER_COUNT } from "./plantLayout.ts";

const camera = () => {
  const cam = new OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
  cam.position.set(30, 30, 30);
  cam.lookAt(-35, 3, -10);
  cam.updateMatrixWorld();
  return cam;
};
const signalsAt = (duty: number, t = 0) =>
  createFakeSignals({ seed: 1, now: () => t, dutyOverride: () => duty });

test("the vapour is one draw call for the tower group, on the library vapour material", () => {
  const plant = buildPlant(1);
  const vapour = plant.group.children.filter(
    (c) => (c as { material?: unknown }).material === MATERIALS.vapour,
  );
  expect(vapour).toHaveLength(VAPOUR_DRAWS);
  expect(VAPOUR_DRAWS).toBe(1);
  expect(plant.vapour.count).toBe(TOWER_COUNT * 60);
  // Four meshes in all: towers, chillers, fans and vapour.
  expect(plant.group.children).toHaveLength(4);
  plant.dispose();
});

test("at scene time 0 the plant shows 60 vapour particles per tower at duty 1 and none at duty 0 (E26)", () => {
  const plant = buildPlant(1);
  plant.update(signalsAt(1), 0, camera(), false);
  // Every particle has a fade above 0 at time 0 (E26), so all 60 per tower show.
  expect(plant.shownParticles).toBe(TOWER_COUNT * 60);
  plant.dispose();
  const idle = buildPlant(1);
  idle.update(signalsAt(0), 0, camera(), false);
  expect(idle.shownParticles).toBe(0);
  idle.dispose();
});

test("reduced motion shows 30% of the vapour, and the first tower's particles follow duty linearly", () => {
  const full = buildPlant(1);
  full.update(signalsAt(1), 0, camera(), true);
  expect(full.shownParticles).toBeLessThanOrEqual(TOWER_COUNT * 18);
  expect(full.shownParticles).toBeGreaterThanOrEqual(TOWER_COUNT * 18 - 1);
  full.dispose();
  const half = buildPlant(1);
  half.update(signalsAt(0.5), 0, camera(), false);
  expect(half.shownParticles).toBeLessThanOrEqual(TOWER_COUNT * 30);
  expect(half.shownParticles).toBeGreaterThanOrEqual(TOWER_COUNT * 30 - 1);
  half.dispose();
});

test("billboards are ordered far to near along the view direction after an update", () => {
  const plant = buildPlant(1);
  const cam = camera();
  plant.update(signalsAt(1, 3), 3, cam, false);
  const forward = new Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const matrix = plant.vapour.instanceMatrix.array;
  let last = Infinity;
  for (let slot = 0; slot < plant.vapour.count; slot++) {
    const at = new Vector3(matrix[slot * 16 + 12], matrix[slot * 16 + 13], matrix[slot * 16 + 14]);
    const depth = at.sub(cam.position).dot(forward);
    expect(depth).toBeLessThanOrEqual(last + 1e-4);
    last = depth;
  }
  plant.dispose();
});

test("the fans turn with the signals' angle, and the plumes are not pickable", () => {
  const plant = buildPlant(1);
  let t = 0;
  const signals = createFakeSignals({ seed: 1, now: () => t, dutyOverride: () => 1 });
  plant.update(signals, t, camera(), false);
  const first = Array.from(plant.fans.instanceMatrix.array.slice(0, 16));
  t = 0.5;
  plant.update(signals, t, camera(), false);
  const second = Array.from(plant.fans.instanceMatrix.array.slice(0, 16));
  expect(second).not.toEqual(first);
  const hits: unknown[] = [];
  plant.vapour.raycast({ ray: { intersectsSphere: () => true } } as never, hits as never);
  expect(hits).toHaveLength(0);
  plant.dispose();
});

test("the plant casts shadows from the towers and chillers only", () => {
  const plant = buildPlant(1);
  expect(plant.towers.castShadow).toBe(true);
  expect(plant.chillers.castShadow).toBe(true);
  expect(plant.fans.castShadow).toBe(false);
  expect(plant.vapour.castShadow).toBe(false);
  plant.dispose();
});

test("a look-dev layout with one tower draws 60 particles of tower 0", () => {
  const plant = buildPlant(1, { towers: [{ x: 6, z: -2 }], chillers: [] });
  plant.update(signalsAt(1), 0, camera(), false);
  expect(plant.vapour.count).toBe(60);
  expect(plant.shownParticles).toBeGreaterThanOrEqual(59);
  plant.dispose();
});

test("a hidden particle is drawn at scale 0, a shown one at its size", () => {
  const plant = buildPlant(1);
  plant.update(signalsAt(0.5), 0, camera(), false);
  const matrix = plant.vapour.instanceMatrix.array;
  const opacity = plant.vapour.geometry.getAttribute("instanceOpacity");
  let hidden = 0;
  let shown = 0;
  for (let slot = 0; slot < plant.vapour.count; slot++) {
    const scale = Math.hypot(matrix[slot * 16], matrix[slot * 16 + 1], matrix[slot * 16 + 2]);
    if (opacity.getX(slot) > 0) {
      shown++;
      expect(scale).toBeGreaterThan(0);
    } else {
      hidden++;
      expect(scale).toBe(0);
    }
  }
  expect(hidden).toBeGreaterThan(0);
  expect(shown).toBeGreaterThan(0);
  plant.dispose();
});

// Steps the plant through 1 s of scene time at 20 frames a second and returns the turn rate it
// measured from the fan matrices it drew.
function measuredFanRate(duty: number, reducedMotion: boolean): number | null {
  const plant = buildPlant(1);
  let t = 0;
  const signals = createFakeSignals({ seed: 1, now: () => t, dutyOverride: () => duty });
  for (let k = 0; k <= 20; k++) {
    t = k * 0.05;
    plant.update(signals, t, camera(), reducedMotion);
  }
  const rate = plant.fanTurnRate;
  plant.dispose();
  return rate;
}

test("the plant measures the fan turn rate it draws: 0.5 at duty 1, 0.05 at duty 0, 0.125 under reduced motion", () => {
  expect(measuredFanRate(1, false)).toBeCloseTo(0.5, 2);
  expect(measuredFanRate(0, false)).toBeCloseTo(0.05, 2);
  expect(measuredFanRate(1, true)).toBeCloseTo(0.125, 2);
});

test("no fan rate is measured before time has passed", () => {
  const plant = buildPlant(1);
  plant.update(signalsAt(1), 0, camera(), false);
  expect(plant.fanTurnRate).toBeNull();
  plant.dispose();
});

test("the fan turn rate stays right across the angle wrap from +pi to -pi", () => {
  const plant = buildPlant(1);
  let t = 0;
  const signals = createFakeSignals({ seed: 1, now: () => t, dutyOverride: () => 1 });
  let wraps = 0;
  let windows = 0;
  let last: number | null = null;
  let previous = Number.NaN;
  // 3 s at duty 1 is 1.5 turns, so the angle passes the wrap at least once.
  for (let k = 0; k <= 60; k++) {
    t = k * 0.05;
    plant.update(signals, t, camera(), false);
    const m = plant.group.children[2] as unknown as { instanceMatrix: { array: Float32Array } };
    const angle = Math.atan2(m.instanceMatrix.array[8], m.instanceMatrix.array[0]);
    const rate = plant.fanTurnRate;
    if (rate !== last) {
      windows++;
      expect(rate).toBeCloseTo(0.5, 2);
      last = rate;
    }
    if (angle < previous - Math.PI) wraps++;
    previous = angle;
  }
  expect(wraps).toBeGreaterThan(0);
  expect(windows).toBeGreaterThan(5);
  plant.dispose();
});
