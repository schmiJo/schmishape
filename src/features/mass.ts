import type { MeshData } from '../engine/client';

/**
 * Onshape's mass properties, worked out from the parts' meshes: where the centre of mass is and the moments of inertia
 * about it, for a uniform density. Volume and area come from the kernel, which knows them exactly, and the mesh's
 * inertia is scaled to that volume.
 */
export interface MassProps { volume: number; center: [number, number, number]; inertia: number[][] }

/** For the faces given, by the mesh's own numbers. Each triangle is turned to face out by its normals first. */
export function meshMass(m: MeshData, faces: Set<number>): MassProps | null {
  const P = m.positions, N = m.normals, F = m.faceIds, I = m.indices;
  let v = 0;
  const s = [0, 0, 0];
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let t = 0; t + 2 < I.length; t += 3) {
    const ia = I[t], ib = I[t + 1], ic = I[t + 2];
    if (!faces.has(F[ia])) continue;
    let a = [P[ia * 3], P[ia * 3 + 1], P[ia * 3 + 2]];
    let b = [P[ib * 3], P[ib * 3 + 1], P[ib * 3 + 2]];
    const cc = [P[ic * 3], P[ic * 3 + 1], P[ic * 3 + 2]];
    // Not every face's triangles wind the same way, but the normals all point out.
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [cc[0] - a[0], cc[1] - a[1], cc[2] - a[2]];
    const g = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const n = [0, 1, 2].map((k) => N[ia * 3 + k] + N[ib * 3 + k] + N[ic * 3 + k]);
    if (g[0] * n[0] + g[1] * n[1] + g[2] * n[2] < 0) [a, b] = [b, a];
    const det = a[0] * (b[1] * cc[2] - b[2] * cc[1]) - a[1] * (b[0] * cc[2] - b[2] * cc[0]) + a[2] * (b[0] * cc[1] - b[1] * cc[0]);
    v += det / 6;
    const sum = [a[0] + b[0] + cc[0], a[1] + b[1] + cc[1], a[2] + b[2] + cc[2]];
    for (let i = 0; i < 3; i++) {
      s[i] += (det * sum[i]) / 24;
      // A tetrahedron from the origin: det / 120 × (aaᵀ + bbᵀ + ccᵀ + (a+b+c)(a+b+c)ᵀ).
      for (let j = 0; j < 3; j++) c[i][j] += (det / 120) * (a[i] * a[j] + b[i] * b[j] + cc[i] * cc[j] + sum[i] * sum[j]);
    }
  }
  if (Math.abs(v) < 1e-12) return null;
  const center: [number, number, number] = [s[0] / v, s[1] / v, s[2] / v];
  // Moved to the centre of mass, then the inertia tensor from the second moments.
  const cm = c.map((row, i) => row.map((x, j) => x - v * center[i] * center[j]));
  const tr = cm[0][0] + cm[1][1] + cm[2][2];
  const inertia = cm.map((row, i) => row.map((x, j) => (i === j ? tr - x : -x)));
  return { volume: v, center, inertia };
}

/** Densities in g/cm³, as a material picker offers them. */
export const MATERIALS: { name: string; density: number }[] = [
  { name: 'Steel', density: 7.85 },
  { name: 'Stainless steel', density: 8.0 },
  { name: 'Aluminum 6061', density: 2.7 },
  { name: 'Brass', density: 8.5 },
  { name: 'Copper', density: 8.96 },
  { name: 'Titanium', density: 4.43 },
  { name: 'ABS', density: 1.04 },
  { name: 'PLA', density: 1.24 },
  { name: 'Nylon', density: 1.14 },
  { name: 'Wood (oak)', density: 0.75 },
];
