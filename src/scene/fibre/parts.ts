import { BufferGeometry, Float32BufferAttribute, SphereGeometry } from "three";
import { box } from "../campus/parts.ts";
import { SITE_COLORS } from "../materials.ts";
import { FIBRE, type Vec3 } from "./route.ts";
import { PACKET } from "./packets.ts";

// The fibre and packet parts (chunk 10), built once per hall set. Triangle caps (eng-review
// Phase 3 E28): packet 48, fibre tube 12 per 0.25 units of length, junction box 12.
const RADIAL = 6;

const unit = (v: readonly number[]): number[] => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
};
const cross = (a: readonly number[], b: readonly number[]) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Open tubes of radius `FIBRE.radius` along each polyline, all in one geometry. A ring sits at
// every vertex, so a straight leg of any length is a single ring of quads: a long run costs 12
// triangles, and a bend costs a few more. Rings keep their orientation by parallel transport.
export function tubeGeometry(paths: readonly (readonly Vec3[])[]): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const path of paths) {
    if (path.length < 2) continue;
    const base = positions.length / 3;
    const dir = path
      .slice(1)
      .map((p, i) => unit([p[0] - path[i][0], p[1] - path[i][1], p[2] - path[i][2]]));
    let u: number[] | null = null;
    path.forEach((p, i) => {
      const before = dir[Math.max(i - 1, 0)];
      const after = dir[Math.min(i, dir.length - 1)];
      const t = unit([before[0] + after[0], before[1] + after[1], before[2] + after[2]]);
      if (u === null) {
        // Start from the axis least along the tangent.
        const axis = [0, 0, 0];
        axis[[0, 1, 2].sort((a, b) => Math.abs(t[a]) - Math.abs(t[b]))[0]] = 1;
        u = unit(cross(t, axis));
      } else {
        const along = dot(u, t);
        u = unit([u[0] - t[0] * along, u[1] - t[1] * along, u[2] - t[2] * along]);
      }
      const v = cross(t, u);
      for (let a = 0; a < RADIAL; a++) {
        const angle = (2 * Math.PI * a) / RADIAL;
        const c = Math.cos(angle) * FIBRE.radius;
        const s = Math.sin(angle) * FIBRE.radius;
        positions.push(
          p[0] + u[0] * c + v[0] * s,
          p[1] + u[1] * c + v[1] * s,
          p[2] + u[2] * c + v[2] * s,
        );
      }
      if (i === 0) return;
      const ring = base + i * RADIAL;
      const last = ring - RADIAL;
      for (let a = 0; a < RADIAL; a++) {
        const a0 = last + a;
        const a1 = last + ((a + 1) % RADIAL);
        indices.push(a0, a1, a0 + RADIAL, a1, a1 + RADIAL, a0 + RADIAL);
      }
    });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// A grey box at a junction or at the top of a hall's climb: one geometry, centred, with a colour
// attribute for the shared site material. An entry box is the same box, flattened by its instance.
export function junctionBoxGeometry(): BufferGeometry {
  return box([0.34, 0.2, 0.34], [0, 0, 0], SITE_COLORS.marking);
}

// A packet: a small sphere on the packet glow material.
export function packetGeometry(): BufferGeometry {
  return new SphereGeometry(PACKET.radius, 8, 4);
}
