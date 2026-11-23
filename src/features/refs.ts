import { drawn, pointsOf, polyline, toWorld, type V2 } from '../sketch/geometry';
import { doc, type EdgeInfo, type FaceInfo } from '../store/doc';
import { DEFAULT_PLANES, sketchPlane } from '../store/planes';
import type { V3 } from '../viewport/math';
import { edgeWord, faceWord, fmtNum } from './words';

/**
 * Points, lines and planes as the kernel names them wherever a feature takes one, found under the pointer, and put
 * into words for the dialog's boxes.
 */

export interface PointSpot { ref: unknown; at: V3 }
export interface LineSpot { ref: unknown; a: V3; b: V3 }

const sketchName = (id: number) => doc.features.find((f) => f.id === id)?.name ?? `Sketch ${id}`;
const nameOf = (id: number) => doc.features.find((f) => f.id === id)?.name ?? `Feature ${id}`;
const fmtPoint = (p: number[]) => `(${p.map((c) => fmtNum(c)).join(', ')})`;

/** The points of the sketches on show that a plane can go through: line and arc ends, centres, and points. */
export function sketchPointSpots(sketches: any[]): PointSpot[] {
  const out: PointSpot[] = [];
  for (const f of sketches) {
    const plane = sketchPlane(f);
    for (const e of f.sketch?.entities ?? []) {
      for (const p of pointsOf(e)) {
        // Only what constraints can name: a point, or a curve's start, end or centre.
        if (!/^\d+(\.(start|end|center))?$/.test(p.ref)) continue;
        out.push({ ref: { sketch: f.id, point: p.ref }, at: toWorld(plane, p.p) });
      }
    }
  }
  return out;
}

/** The straight lines of the sketches on show. */
export function sketchLineSpots(sketches: any[]): LineSpot[] {
  const out: LineSpot[] = [];
  for (const f of sketches) {
    const plane = sketchPlane(f);
    for (const e of f.sketch?.entities ?? []) {
      const d = drawn(e);
      if (d.type === 'line' && d.start && d.end) out.push({ ref: { sketch: f.id, line: e.id }, a: toWorld(plane, d.start), b: toWorld(plane, d.end) });
    }
  }
  return out;
}

/** A sketch's curves in the part, as pieces of line, each with the curve it's from: what a sweep path takes. */
export function sketchCurveSegments(f: any): { entity: number; a: V3; b: V3 }[] {
  const plane = sketchPlane(f);
  const out: { entity: number; a: V3; b: V3 }[] = [];
  for (const e of f.sketch?.entities ?? []) {
    if (e.construction || e.type === 'point') continue;
    const pts = polyline(e);
    for (let i = 0; i + 1 < pts.length; i++) out.push({ entity: e.id, a: toWorld(plane, pts[i]), b: toWorld(plane, pts[i + 1]) });
  }
  return out;
}

/** A sweep path in words: a sketch's curves, or an edge. */
export function pathWords(ref: any, edges?: EdgeInfo[]): { name: string; size: string } {
  if (ref && typeof ref.sketch === 'number' && Object.keys(ref).length === 1) {
    const f = doc.features.find((x) => x.id === ref.sketch);
    const length = f ? sketchCurveSegments(f).reduce((t, s) => t + Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]), 0) : 0;
    return { name: `Curves of ${sketchName(ref.sketch)}`, size: length ? `${fmtNum(length)} mm` : '' };
  }
  return edgeWords(ref, edges);
}

/** A part's corners, once each, with the faces that meet there and where. */
const cornerCache = new WeakMap<EdgeInfo[], PointSpot[]>();
export function corners(edges: EdgeInfo[]): (PointSpot & { faces: string[] })[] {
  const had = cornerCache.get(edges);
  if (had) return had as (PointSpot & { faces: string[] })[];
  const seen = new Map<string, PointSpot & { faces: string[] }>();
  for (const e of edges) {
    for (const [v, at] of [[e.start_vertex, e.start], [e.end_vertex, e.end]] as const) {
      if (!v || !at) continue;
      const key = at.map((c) => c.toFixed(5)).join(',');
      if (!seen.has(key)) seen.set(key, { ref: { faces: v.faces, near: at }, at, faces: v.faces });
    }
  }
  const list = [...seen.values()];
  cornerCache.set(edges, list);
  return list;
}

/** Where a point reference is, for drawing it. */
export function pointWhere(ref: any): V3 | null {
  if (ref === 'origin') return [0, 0, 0];
  if (Array.isArray(ref) && ref.length === 3 && ref.every((c) => typeof c === 'number')) return ref as V3;
  if (ref && Array.isArray(ref.near)) return ref.near as V3;
  if (ref && typeof ref.sketch === 'number' && typeof ref.point === 'string') {
    const f = doc.features.find((x) => x.id === ref.sketch);
    if (!f) return null;
    for (const e of f.sketch?.entities ?? []) {
      const p = pointsOf(e).find((q) => q.ref === ref.point);
      if (p) return toWorld(sketchPlane(f), p.p);
    }
  }
  return null;
}

/** Where a sketch line reference is, for drawing it. */
export function lineWhere(ref: any): [V3, V3] | null {
  if (!ref || typeof ref.sketch !== 'number' || typeof ref.line !== 'number') return null;
  const f = doc.features.find((x) => x.id === ref.sketch);
  const e = f?.sketch?.entities?.find((x: any) => x.id === ref.line);
  const d = e && drawn(e);
  return d?.start && d.end ? [toWorld(sketchPlane(f), d.start as V2), toWorld(sketchPlane(f), d.end as V2)] : null;
}

const facesNamed = (faces: FaceInfo[] | undefined, ref: unknown) => faces?.filter((x) => x.name === ref || x.key === ref) ?? [];
const area = (list: FaceInfo[]) => (list.length ? `${fmtNum(list.reduce((t, f) => t + f.area, 0))} mm²` : '');

/** A plane reference in words, with a size or place beside it. */
export function planeWords(ref: any, faces?: FaceInfo[]): { name: string; size: string } {
  const i = DEFAULT_PLANES.indexOf(ref);
  if (i >= 0) return { name: `${['Top', 'Front', 'Right'][i]} plane`, size: '' };
  if (typeof ref === 'number') return { name: nameOf(ref), size: '' };
  if (typeof ref === 'string') {
    const list = facesNamed(faces, ref);
    return { name: faceWord(list[0]?.surface ?? 'plane'), size: area(list) };
  }
  if (ref && Array.isArray(ref.normal)) return { name: 'Plane', size: `through ${fmtPoint(ref.point ?? [0, 0, 0])}` };
  return { name: 'Plane', size: '' };
}

const POINT_PART: Record<string, string> = { start: 'Start', end: 'End', center: 'Center' };

/** A point reference in words. */
export function pointWords(ref: any): { name: string; size: string } {
  if (ref === 'origin') return { name: 'Origin', size: '' };
  if (Array.isArray(ref)) return { name: 'Point', size: fmtPoint(ref) };
  if (ref && Array.isArray(ref.faces)) return { name: 'Vertex', size: ref.near ? fmtPoint(ref.near) : '' };
  if (ref && typeof ref.sketch === 'number') {
    const part = String(ref.point ?? '').split('.')[1];
    return { name: `${part ? `${POINT_PART[part] ?? 'Point'} of a curve` : 'Sketch point'}`, size: sketchName(ref.sketch) };
  }
  return { name: 'Point', size: '' };
}

/** An edge selection's edge, by the selection it was picked with. */
const edgeOf = (edges: EdgeInfo[] | undefined, sel: unknown) => edges?.find((e) => JSON.stringify(e.select) === JSON.stringify(sel));

/** A line reference in words. */
export function lineWords(ref: any, faces?: FaceInfo[], edges?: EdgeInfo[]): { name: string; size: string } {
  if (ref && typeof ref.sketch === 'number' && typeof ref.line === 'number') {
    const at = lineWhere(ref);
    return { name: 'Sketch line', size: at ? `${sketchName(ref.sketch)}, ${fmtNum(Math.hypot(at[1][0] - at[0][0], at[1][1] - at[0][1], at[1][2] - at[0][2]))} mm` : sketchName(ref.sketch) };
  }
  if (ref && 'axis_of' in ref) {
    const of = ref.axis_of;
    if (typeof of === 'string') return { name: `Axis of ${faceWord(facesNamed(faces, of)[0]?.surface).toLowerCase()}`, size: '' };
    const e = edgeOf(edges, of);
    return { name: `Axis of ${edgeWord(e?.curve).toLowerCase()}`, size: e?.radius ? `R ${fmtNum(e.radius)} mm` : '' };
  }
  if (ref && Array.isArray(ref.direction)) return { name: 'Line', size: `along ${fmtPoint(ref.direction)}` };
  return edgeWords(ref && 'edge' in ref ? ref.edge : ref, edges);
}

/** An edge in words. */
export function edgeWords(sel: unknown, edges?: EdgeInfo[]): { name: string; size: string } {
  const e = edgeOf(edges, sel);
  return { name: edgeWord(e?.curve), size: e ? `${fmtNum(e.length)} mm` : '' };
}

/** The sketches a dialog's points and lines come from, so they stay on show while it's open. */
export function sketchesIn(value: unknown): number[] {
  const out: number[] = [];
  const walk = (v: any) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.sketch === 'number' && ('point' in v || 'line' in v || Object.keys(v).length === 1)) out.push(v.sketch);
    }
  };
  walk(value);
  return out;
}
