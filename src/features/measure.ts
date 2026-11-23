import type { EdgeInfo, FaceInfo } from '../store/doc';
import { cross, dot, length, normalize, sub, type V3 } from '../viewport/math';
import { fmtNum } from './words';

/**
 * What Onshape shows in the corner for whatever is selected: a length, an area or a radius for one thing, and the
 * distance or angle between two, where there's one to give.
 */
export interface MeasureRow { label: string; value: string }
/** What's measured, and the line a distance runs along, to draw in the view. */
export interface Measured { rows: MeasureRow[]; line: [V3, V3] | null }

const mm = (v: number) => `${fmtNum(v)} mm`;
const deg = (radians: number) => `${fmtNum((radians * 180) / Math.PI)}°`;
const same = (a: V3, b: V3) => length(sub(a, b)) < 1e-6 * Math.max(1, length(a));
const parallel = (a: V3, b: V3) => Math.abs(Math.abs(dot(normalize(a), normalize(b))) - 1) < 1e-7;

/** A round edge's centre: a whole circle's from either side of it, an arc's through its ends and middle. */
function circleCenter(e: EdgeInfo): V3 | null {
  if (e.curve !== 'circle') return null;
  if (same(e.start, e.end)) return [(e.start[0] + e.midpoint[0]) / 2, (e.start[1] + e.midpoint[1]) / 2, (e.start[2] + e.midpoint[2]) / 2];
  const a = e.start, b = e.midpoint, c = e.end;
  const ab = sub(b, a), ac = sub(c, a);
  const n = cross(ab, ac);
  const nn = dot(n, n);
  if (nn < 1e-18) return null;
  const t1 = cross(n, ab), t2 = cross(ac, n);
  const k1 = dot(ac, ac) / (2 * nn), k2 = dot(ab, ab) / (2 * nn);
  return [a[0] + t1[0] * k1 + t2[0] * k2, a[1] + t1[1] * k1 + t2[1] * k2, a[2] + t1[2] * k1 + t2[2] * k2];
}
/** The normal of a round edge's plane. */
const circleNormal = (e: EdgeInfo, c: V3) => normalize(cross(sub(e.start, c), sub(e.midpoint, c)));

/** How far a point is from a line through `at` along `dir`. */
const toLine = (p: V3, at: V3, dir: V3) => length(cross(sub(p, at), normalize(dir)));

/** A straight edge's direction, a face's axis or a plane's normal: what an angle is measured by. */
const lineDir = (e: EdgeInfo): V3 => normalize(sub(e.end, e.start));

/** An axis to measure from, if the thing has one: a round face's, or a round edge's centre line. */
function axisOf(x: { face?: FaceInfo; edge?: EdgeInfo }): { at: V3; dir: V3 } | null {
  if (x.face?.axis) {
    // Level with the middle of the face, so a line drawn from it is where the face is.
    const { point, direction } = x.face.axis;
    const u = normalize(direction);
    const k = dot(sub(x.face.center, point), u);
    return { at: [point[0] + u[0] * k, point[1] + u[1] * k, point[2] + u[2] * k], dir: direction };
  }
  const c = x.edge ? circleCenter(x.edge) : null;
  return c && x.edge ? { at: c, dir: circleNormal(x.edge, c) } : null;
}

/** The nearest points of two lines, each through a point along a direction. */
function closest(p: V3, d: V3, q: V3, e: V3): [V3, V3] {
  const r = sub(p, q);
  const a = dot(d, d), b = dot(d, e), c = dot(e, e), dd = dot(d, r), ee = dot(e, r);
  const den = a * c - b * b;
  const s = Math.abs(den) < 1e-12 ? 0 : (b * ee - c * dd) / den;
  const t = Math.abs(den) < 1e-12 ? ee / c : (a * ee - b * dd) / den;
  return [[p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s], [q[0] + e[0] * t, q[1] + e[1] * t, q[2] + e[2] * t]];
}
const onPlane = (p: V3, at: V3, n: V3): V3 => {
  const u = normalize(n);
  const k = dot(sub(at, p), u);
  return [p[0] + u[0] * k, p[1] + u[1] * k, p[2] + u[2] * k];
};
const mid = (e: EdgeInfo): V3 => e.midpoint;

export function measure(faces: FaceInfo[], edges: EdgeInfo[]): Measured {
  const rows: MeasureRow[] = [];
  let line: [V3, V3] | null = null;
  if (faces.length === 1 && !edges.length) {
    const f = faces[0];
    rows.push({ label: 'Area', value: `${fmtNum(f.area)} mm²` });
    if (f.radius) rows.push({ label: 'Diameter', value: mm(2 * f.radius) }, { label: 'Radius', value: mm(f.radius) });
    return { rows, line };
  }
  if (edges.length === 1 && !faces.length) {
    const e = edges[0];
    if (e.curve === 'circle' && e.radius) {
      if (same(e.start, e.end)) rows.push({ label: 'Diameter', value: mm(2 * e.radius) });
      rows.push({ label: 'Radius', value: mm(e.radius) });
      rows.push({ label: same(e.start, e.end) ? 'Circumference' : 'Arc length', value: mm(e.length) });
    } else rows.push({ label: 'Length', value: mm(e.length) });
    return { rows, line };
  }
  const things = [...faces.map((face) => ({ face })), ...edges.map((edge) => ({ edge }))] as { face?: FaceInfo; edge?: EdgeInfo }[];
  if (things.length === 2) {
    const [a, b] = things;
    const flat = (x: typeof a) => x.face?.surface === 'plane';
    const straight = (x: typeof a) => x.edge?.curve === 'line';
    // Two flat faces: apart if they're parallel, or else at an angle.
    if (flat(a) && flat(b)) {
      const n = a.face!.normal;
      if (parallel(n, b.face!.normal)) {
        rows.push({ label: 'Distance', value: mm(Math.abs(dot(sub(b.face!.center, a.face!.center), normalize(n)))) });
        line = [a.face!.center, onPlane(a.face!.center, b.face!.center, n)];
      }
      else rows.push({ label: 'Angle', value: deg(Math.acos(Math.min(1, Math.abs(dot(normalize(n), normalize(b.face!.normal)))))) });
    } else if (straight(a) && straight(b)) {
      const da = lineDir(a.edge!), db = lineDir(b.edge!);
      if (parallel(da, db)) {
        rows.push({ label: 'Distance', value: mm(toLine(b.edge!.start, a.edge!.start, da)) });
        line = closest(mid(a.edge!), da, mid(b.edge!), db);
        line = [mid(a.edge!), line[1]];
      } else {
        rows.push({ label: 'Angle', value: deg(Math.acos(Math.min(1, Math.abs(dot(da, db))))) });
        // Lines that don't meet are still some way apart, as Onshape gives it.
        const n = normalize(cross(da, db));
        const gap = Math.abs(dot(sub(b.edge!.start, a.edge!.start), n));
        if (gap > 1e-6) {
          rows.push({ label: 'Distance', value: mm(gap) });
          line = closest(a.edge!.start, da, b.edge!.start, db);
        }
      }
    } else if ((flat(a) && straight(b)) || (flat(b) && straight(a))) {
      const [p, l] = flat(a) ? [a, b] : [b, a];
      const n = normalize(p.face!.normal);
      const d = lineDir(l.edge!);
      if (Math.abs(dot(n, d)) < 1e-7) {
        rows.push({ label: 'Distance', value: mm(Math.abs(dot(sub(l.edge!.start, p.face!.center), n))) });
        line = [mid(l.edge!), onPlane(mid(l.edge!), p.face!.center, n)];
      }
      else rows.push({ label: 'Angle', value: deg(Math.asin(Math.min(1, Math.abs(dot(n, d))))) });
    } else {
      const axA = axisOf(a), axB = axisOf(b);
      if (axA && axB) {
        // Two holes or pins: how far apart their centres are.
        if (parallel(axA.dir, axB.dir)) {
          rows.push({ label: 'Center distance', value: mm(toLine(axB.at, axA.at, axA.dir)) });
          line = [axA.at, closest(axA.at, axA.dir, axB.at, axB.dir)[1]];
        }
        else rows.push({ label: 'Angle between axes', value: deg(Math.acos(Math.min(1, Math.abs(dot(normalize(axA.dir), normalize(axB.dir)))))) });
      } else if ((axA && flat(b)) || (axB && flat(a))) {
        const [ax, p] = axA ? [axA, b] : [axB!, a];
        const n = normalize(p.face!.normal);
        if (Math.abs(dot(n, normalize(ax.dir))) < 1e-7) rows.push({ label: 'Distance from axis', value: mm(Math.abs(dot(sub(ax.at, p.face!.center), n))) });
        else if (parallel(n, ax.dir) && (a.edge || b.edge)) rows.push({ label: 'Distance from center', value: mm(Math.abs(dot(sub(ax.at, p.face!.center), n))) });
        if (rows.length) line = [ax.at, onPlane(ax.at, p.face!.center, n)];
      } else if ((axA && straight(b)) || (axB && straight(a))) {
        const [ax, l] = axA ? [axA, b] : [axB!, a];
        const d = lineDir(l.edge!);
        if (parallel(d, ax.dir)) {
          rows.push({ label: 'Distance from axis', value: mm(toLine(ax.at, l.edge!.start, d)) });
          line = [ax.at, closest(ax.at, ax.dir, l.edge!.start, d)[1]];
        }
      }
    }
  }
  if (faces.length > 1) rows.push({ label: faces.length === things.length ? 'Total area' : 'Area', value: `${fmtNum(faces.reduce((t, f) => t + f.area, 0))} mm²` });
  if (edges.length > 1) rows.push({ label: edges.length === things.length ? 'Total length' : 'Length', value: mm(edges.reduce((t, e) => t + e.length, 0)) });
  // A line of no length has nothing to show.
  if (line && length(sub(line[0], line[1])) < 1e-9) line = null;
  return { rows, line };
}
