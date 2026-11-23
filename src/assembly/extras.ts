/**
 * What an assembly makes of its instances after the mates are solved, as the kernel's assemblies do: patterns and
 * replicates, which place copies from wherever their instances end up so they follow them, and exploded views, which
 * only move what's shown. Plain math, given a way to find each instance's part.
 */
import { add, cross, dot, quatFromBasis, quatMul, quatNormalize, quatRotate, scale, sub, type Quat, type V3 } from '../viewport/math';
import { faceSpots, findSpot } from './connectors';
import type { AssemblyData, ConnectorRef, InstanceData } from './model';
import type { PartMesh } from './parts';
import { apply, type Frame, type Pose } from './solver';

/** A copy a pattern or replicate places: an id of its own, the instance it copies, and where it goes. */
export interface Copy { id: string; of: InstanceData; pose: Pose; from: string }

const conj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
export const compose = (a: Pose, b: Pose): Pose => ({ p: add(a.p, quatRotate(a.q, b.p)), q: quatNormalize(quatMul(a.q, b.q)) });
export const inverse = (a: Pose): Pose => ({ p: scale(quatRotate(conj(a.q), a.p), -1), q: conj(a.q) });
const frameAsPose = (f: Frame): Pose => ({ p: f.o, q: quatFromBasis(f.x, cross(f.z, f.x), f.z) });
const turnAbout = (point: V3, axis: V3, degrees: number): Pose => {
  const h = (degrees * Math.PI) / 360;
  const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
  const q: Quat = [(axis[0] / n) * Math.sin(h), (axis[1] / n) * Math.sin(h), (axis[2] / n) * Math.sin(h), Math.cos(h)];
  return { p: sub(point, quatRotate(q, point)), q };
};

const AXES: Record<'x' | 'y' | 'z', V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** Where a pattern's axis is in the assembly: one of X, Y and Z through the origin, or along a connector's Z, following its part. */
export function patternAxis(data: AssemblyData, axis: PatternAxis, partOf: (i: InstanceData) => PartMesh | undefined): { point: V3; dir: V3 } | null {
  if (typeof axis === 'string') return { point: [0, 0, 0], dir: AXES[axis] };
  const inst = data.instances.find((i) => i.id === axis.instance);
  const part = inst && partOf(inst);
  const f = part ? findSpot(part, axis.connector) ?? axis.connector.frame : axis.connector.frame;
  if (!inst) return null;
  return { point: apply(inst.pose, f.o), dir: quatRotate(inst.pose.q, f.z) };
}

export type PatternAxis = 'x' | 'y' | 'z' | { instance: string; connector: ConnectorRef };

/**
 * The places a replicate's copies go on its connector's instance: every other face like the connector's own, a cylinder
 * of the same radius the same way, a ball of the same radius, or a flat face facing the same way, at the same kind of
 * spot on it, in that part's coordinates.
 */
export function replicatePlaces(part: PartMesh, c: ConnectorRef): Frame[] {
  const own = part.faces.find((f) => f.key === c.ref);
  if (!own || c.kind !== 'face') return [];
  const mine = findSpot(part, c) ?? c.frame;
  const same = (k: string) => {
    const f = part.faces.find((x) => x.key === k)!;
    if (f.surface !== own.surface) return false;
    if (f.surface === 'plane') return dot(f.normal, own.normal) > 1 - 1e-6;
    if (Math.abs((f.radius ?? 0) - (own.radius ?? 0)) > 1e-6 * Math.max(1, own.radius ?? 1)) return false;
    if (f.surface === 'cylinder' || f.surface === 'cone') return !!f.axis && !!own.axis && Math.abs(dot(f.axis.direction, own.axis.direction)) > 1 - 1e-6;
    return f.surface === 'sphere';
  };
  const keys = [...new Set(part.faces.map((f) => f.key))].filter((k) => k !== c.ref && same(k));
  const out: Frame[] = [];
  const seen: V3[] = [mine.o];
  for (const k of keys) {
    const i = part.faces.findIndex((f) => f.key === k);
    const spots = faceSpots(part, i).filter((s) => s.how === c.how);
    // The spot on this face where the connector's is on its own: for a hole, the same end of its axis.
    let best: Frame | null = null, score = -Infinity;
    for (const s of spots) {
      const d = dot(sub(s.frame.o, mine.o), mine.z);
      const v = -Math.abs(d) + (dot(s.frame.z, mine.z) > 0 ? 1e6 : 0);
      if (v > score) { score = v; best = s.frame; }
    }
    if (!best || seen.some((o) => Math.hypot(o[0] - best!.o[0], o[1] - best!.o[1], o[2] - best!.o[2]) < 1e-6)) continue;
    seen.push(best.o);
    // Pointing the way the connector does.
    const z = dot(best.z, mine.z) < 0 ? scale(best.z, -1) : best.z;
    out.push({ o: best.o, z, x: mine.x });
  }
  return out;
}

/** Every copy that patterns and replicates place, from where their instances are now. */
export function derivedCopies(data: AssemblyData, partOf: (i: InstanceData) => PartMesh | undefined): Copy[] {
  const out: Copy[] = [];
  const byId = new Map(data.instances.map((i) => [i.id, i]));
  for (const p of data.patterns ?? []) {
    if (p.suppressed) continue;
    const axis = patternAxis(data, p.axis, partOf);
    if (!axis) continue;
    for (let k = 1; k < p.count; k++) {
      const move: Pose = p.type === 'linear'
        ? { p: scale(axis.dir, (p.spacing * k) / (Math.hypot(...axis.dir) || 1)), q: [0, 0, 0, 1] }
        : turnAbout(axis.point, axis.dir, p.degrees * k);
      for (const id of p.of) {
        const seed = byId.get(id);
        if (seed && !seed.hidden) out.push({ id: `${p.id}.${k}.${id}`, of: seed, pose: compose(move, seed.pose), from: p.id });
      }
    }
  }
  for (const r of data.replicates ?? []) {
    if (r.suppressed) continue;
    const target = byId.get(r.target);
    const part = target && partOf(target);
    if (!target || !part) continue;
    const at = frameAsPose(findSpot(part, r.connector) ?? r.connector.frame);
    const places = replicatePlaces(part, r.connector);
    places.forEach((f, k) => {
      // Moved in the target part's coordinates from the connector's place to this one, then put back in the assembly.
      const local = compose(frameAsPose(f), inverse(at));
      const move = compose(target.pose, compose(local, inverse(target.pose)));
      for (const id of r.of) {
        const seed = byId.get(id);
        if (seed && !seed.hidden) out.push({ id: `${r.id}.${k + 1}.${id}`, of: seed, pose: compose(move, seed.pose), from: r.id });
      }
    });
  }
  return out;
}

/**
 * How far each instance moves in an exploded view shown `amount` of the way, 0 to 1: its steps go one after another,
 * each moving the instances it lists, and the copies of them, by its shift.
 */
export function explodeShifts(data: AssemblyData, explodeId: string, amount: number): Map<string, V3> {
  const out = new Map<string, V3>();
  const e = (data.explodes ?? []).find((x) => x.id === explodeId);
  if (!e || !e.steps.length) return out;
  const t = Math.max(0, Math.min(1, amount)) * e.steps.length;
  e.steps.forEach((s, i) => {
    const share = Math.max(0, Math.min(1, t - i));
    if (!share) return;
    for (const id of s.instances) out.set(id, add(out.get(id) ?? [0, 0, 0], scale(s.shift, share)));
  });
  return out;
}
