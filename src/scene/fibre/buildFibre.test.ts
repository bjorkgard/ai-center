import { InstancedMesh, Matrix4, Mesh, Vector3 } from "three";
import { expect, test, vi } from "vite-plus/test";
import { createFakeSignals } from "../fake.ts";
import { MATERIALS } from "../materials.ts";
import { buildFibre } from "./buildFibre.ts";
import type { Vec3 } from "./route.ts";
import { PACKET, packetCount } from "./packets.ts";

const signalsAt = (t = 0, rate?: number) =>
  createFakeSignals({
    seed: 1,
    now: () => t,
    packetRateOverride: rate === undefined ? undefined : () => rate,
  });

// The drawn position of every packet of a line (hidden ones are scaled to 0).
function drawn(mesh: InstancedMesh, line: number): Vector3[] {
  const out: Vector3[] = [];
  const m = new Matrix4();
  for (let j = 0; j < PACKET.cap; j++) {
    mesh.getMatrixAt(line * PACKET.cap + j, m);
    if (m.elements[0] === 0) continue;
    out.push(new Vector3().setFromMatrixPosition(m));
  }
  return out;
}

test("the network is three draws: the tubes, the junction boxes and one packet mesh for every line", () => {
  const fibre = buildFibre(6);
  const meshes = fibre.group.children as Mesh[];
  expect(meshes).toHaveLength(3);
  expect(meshes.map((m) => m.material)).toEqual([
    MATERIALS.fibre,
    MATERIALS.site,
    MATERIALS.packet,
  ]);
  expect(fibre.packets.count).toBe(6 * PACKET.cap);
  expect(meshes.every((m) => !m.castShadow)).toBe(true);
  expect(fibre.lineCount).toBe(6);
  fibre.dispose();
});

test("at scene time 0 each line holds its capped packet count, spread along its length (E26)", () => {
  const fibre = buildFibre(12);
  fibre.update(signalsAt(0), 0, false);
  let capped = 0;
  fibre.network.lines.forEach((line, i) => {
    const shown = drawn(fibre.packets, i);
    expect(shown).toHaveLength(packetCount(line.length, PACKET.defaultRate));
    if (shown.length === PACKET.cap) capped++;
    // Each packet is on the line's centre line, at the height of the tube.
    for (const p of shown) expect(p.y).toBeGreaterThanOrEqual(0.1);
  });
  // Long lines hit the cap of 12.
  expect(capped).toBeGreaterThan(0);
  expect(fibre.shownPackets).toBeGreaterThan(40);
  fibre.dispose();
});

// The distance along `line` of the point on its centre line nearest `p`.
function alongLine(line: readonly Vec3[], p: Vector3): number {
  let best = Infinity;
  let at = 0;
  let run = 0;
  for (let k = 1; k < line.length; k++) {
    const a = new Vector3(...line[k - 1]);
    const seg = new Vector3(...line[k]).sub(a);
    const len = seg.length();
    const f = len > 0 ? Math.min(1, Math.max(0, p.clone().sub(a).dot(seg) / (len * len))) : 0;
    const dist = a.clone().addScaledVector(seg, f).distanceTo(p);
    if (dist < best) {
      best = dist;
      at = run + f * len;
    }
    run += len;
  }
  return at;
}

test("the drawn packets of every line sit evenly over its length, wrap gap included, at any time", () => {
  const fibre = buildFibre(12);
  for (const t of [0, 7.3]) {
    fibre.update(signalsAt(t), t, false);
    fibre.network.lines.forEach((line, i) => {
      const shown = drawn(fibre.packets, i);
      const along = shown.map((p) => alongLine(line.rounded, p)).sort((a, b) => a - b);
      const L = line.length;
      const want = L / shown.length;
      for (let j = 1; j < along.length; j++) {
        expect(Math.abs(along[j] - along[j - 1] - want)).toBeLessThan(0.05);
        expect(along[j] - along[j - 1]).toBeGreaterThanOrEqual(PACKET.spacing - 0.05);
      }
      if (along.length > 1) {
        const wrap = L + along[0] - along[along.length - 1];
        expect(Math.abs(wrap - want)).toBeLessThan(0.05);
        expect(wrap).toBeGreaterThanOrEqual(PACKET.spacing - 0.05);
      }
    });
  }
  fibre.dispose();
});

test("a rate of 0 shows no packets and a rate of 10 fills every line to its cap", () => {
  const fibre = buildFibre(4);
  fibre.update(signalsAt(0, 0), 0, false);
  expect(fibre.shownPackets).toBe(0);
  fibre.update(signalsAt(0, 10), 0, false);
  fibre.network.lines.forEach((line, i) =>
    expect(drawn(fibre.packets, i)).toHaveLength(packetCount(line.length, 10)),
  );
  fibre.dispose();
});

test("packets move at 2.5 units a second, and at 25% of that under reduced motion, as drawn", () => {
  const fibre = buildFibre(2);
  const speed = (reduced: boolean) => {
    let t = 0;
    const signals = createFakeSignals({ seed: 1, now: () => t });
    // Warm up the measurement over 1 s of 60 fps frames, then read it.
    for (let k = 0; k <= 60; k++) {
      t = k / 60;
      fibre.update(signals, t, reduced);
    }
    return fibre.packetSpeed;
  };
  // Not enough time has passed yet: no rate.
  expect(fibre.packetSpeed).toBeNull();
  expect(speed(false)).toBeCloseTo(2.5, 1);
  const fresh = buildFibre(2);
  let t = 0;
  const signals = createFakeSignals({ seed: 1, now: () => t });
  for (let k = 0; k <= 60; k++) {
    t = k / 60;
    fresh.update(signals, t, true);
  }
  expect(fresh.packetSpeed).toBeCloseTo(0.625, 1);
  fibre.dispose();
  fresh.dispose();
});

test("disposing frees every geometry and the instance buffers, so a rebuild leaks nothing", () => {
  const fibre = buildFibre(5);
  const geometries = (fibre.group.children as Mesh[]).map((m) => m.geometry);
  const geometrySpies = geometries.map(() => vi.fn());
  geometries.forEach((g, i) => g.addEventListener("dispose", geometrySpies[i]));
  const meshSpy = vi.fn();
  fibre.packets.addEventListener("dispose", meshSpy);
  fibre.dispose();
  for (const spy of geometrySpies) expect(spy).toHaveBeenCalledTimes(1);
  expect(meshSpy).toHaveBeenCalledTimes(1);
});

test("a smaller hall set builds fewer lines and fewer packets", () => {
  const four = buildFibre(4);
  const eight = buildFibre(8);
  expect(four.lineCount).toBe(4);
  expect(eight.lineCount).toBe(8);
  expect(eight.packets.count).toBeGreaterThan(four.packets.count);
  four.dispose();
  eight.dispose();
});
