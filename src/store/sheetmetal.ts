import { createSignal } from 'solid-js';
import { engine } from '../engine/client';

/**
 * Sheet metal parts and their flat patterns, as the kernel lays them out: unfolded from the first wall's face, which
 * stays where it is, in a frame of its own whose z goes into the sheet.
 */

export type P2 = [number, number];
export type FlatEdge =
  | { line: [P2, P2] }
  | { arc: [P2, P2]; center: P2; radius: number; ccw: boolean }
  | { points: P2[] };
export interface FlatBend { line: [P2, P2]; degrees: number; radius: number; direction: 'up' | 'down'; width: number }
export interface FlatPattern {
  frame: { origin: number[]; x: number[]; y: number[]; z: number[] };
  thickness: number;
  k_factor: number;
  size: [number, number];
  area: number;
  outline: FlatEdge[];
  bends: FlatBend[];
}
/** A part a sheet metal feature made, by the kernel's name for it, with its flat pattern or why there's none. */
export interface SheetPart { body: string; flat: FlatPattern | null; error: string | null }

/** The sheet metal parts as the history stands at the rollback bar. */
export const [sheetParts, setSheetParts] = createSignal<SheetPart[]>([]);
/** Whether the flat pattern is on show, beside the model, as Onshape's flat view is. */
export const [flatOpen, setFlatOpen] = createSignal(false);
/** The part it shows, when there's more than one. */
export const [flatBody, setFlatBody] = createSignal<string | null>(null);
/** The bend lit in the drawing and the table, by its place in the list. */
export const [litBend, setLitBend] = createSignal<number | null>(null);

export const isSheetMetalFeature = (f: { type?: string } | undefined) => f?.type === 'sheet_metal';

/** The part a feature made is named for it, f2, or f2.1 when it made several. */
const madeBy = (body: string) => Number(/^f(\d+)/.exec(body)?.[1] ?? NaN);

/** Which parts sheet metal features made, in the order they're listed. */
export function sheetMetalBodies(features: any[], parts: { name: string }[]): string[] {
  const ids = new Set(features.filter((f) => isSheetMetalFeature(f) && !f.suppressed).map((f) => f.id as number));
  return parts.map((p) => p.name).filter((name) => ids.has(madeBy(name)));
}

/** Each sheet metal part laid flat, as the history stood after `upto`, or at its end. */
export async function loadSheetParts(features: any[], parts: { name: string }[], upto: number | null): Promise<SheetPart[]> {
  const out: SheetPart[] = [];
  for (const body of sheetMetalBodies(features, parts)) {
    const r = await engine.call('flat_pattern', { body, ...(upto !== null ? { upto } : {}) });
    if (r.ok) out.push({ body, flat: JSON.parse(r.text), error: null });
    else out.push({ body, flat: null, error: r.text.replace(/^invalid (input|profile): /i, '').replace(/^\w/, (c) => c.toUpperCase()) });
  }
  return out;
}

/** The part the flat pattern shows: the one picked, or else the first. */
export function shownSheet(): SheetPart | null {
  const all = sheetParts();
  return all.find((p) => p.body === flatBody()) ?? all[0] ?? null;
}

/** A point on an edge's way, for the edges that join up into loops. */
const ends = (e: FlatEdge): [P2, P2] => ('line' in e ? e.line : 'arc' in e ? e.arc : [e.points[0], e.points[e.points.length - 1]]);
const same = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6 * Math.max(1, Math.abs(a[0]), Math.abs(a[1]));

/** Points along an edge, close enough to draw or measure it by. */
export function edgePoints(e: FlatEdge, steps = 24): P2[] {
  if ('line' in e) return e.line;
  if ('points' in e) return e.points;
  const [a, b] = e.arc;
  const [cx, cy] = e.center;
  const t0 = Math.atan2(a[1] - cy, a[0] - cx);
  let span = Math.atan2(b[1] - cy, b[0] - cx) - t0;
  if (e.ccw && span <= 0) span += 2 * Math.PI;
  if (!e.ccw && span >= 0) span -= 2 * Math.PI;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const t = t0 + (span * i) / steps;
    return [cx + e.radius * Math.cos(t), cy + e.radius * Math.sin(t)] as P2;
  });
}

/** The same edge, run the other way. */
export function reversed(e: FlatEdge): FlatEdge {
  if ('line' in e) return { line: [e.line[1], e.line[0]] };
  if ('points' in e) return { points: [...e.points].reverse() };
  return { arc: [e.arc[1], e.arc[0]], center: e.center, radius: e.radius, ccw: !e.ccw };
}

/**
 * The outline split into its loops, the outside first and then each hole, each edge turned to run on from the one
 * before. A loop that doesn't close is kept as far as it joins up, so nothing is left out.
 */
export function flatLoops(outline: FlatEdge[]): FlatEdge[][] {
  const left = [...outline];
  const loops: FlatEdge[][] = [];
  while (left.length) {
    const loop = [left.shift()!];
    const start = ends(loop[0])[0];
    let tip = ends(loop[0])[1];
    while (!same(tip, start)) {
      const i = left.findIndex((e) => same(ends(e)[0], tip) || same(ends(e)[1], tip));
      if (i < 0) break;
      const [found] = left.splice(i, 1);
      const e = same(ends(found)[0], tip) ? found : reversed(found);
      tip = ends(e)[1];
      loop.push(e);
    }
    loops.push(loop);
  }
  const extent = (loop: FlatEdge[]) => {
    const pts = loop.flatMap((e) => edgePoints(e, 8));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  };
  return loops.sort((a, b) => extent(b) - extent(a));
}

/** The box the outline fills. */
export function flatBounds(flat: FlatPattern): { min: P2; max: P2 } {
  const pts = flat.outline.flatMap((e) => edgePoints(e));
  if (!pts.length) return { min: [0, 0], max: [0, 0] };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
}

const fmt = (n: number) => {
  const t = (Math.abs(n) < 5e-7 ? 0 : n).toFixed(6).replace(/\.?0+$/, '');
  return t === '-0' ? '0' : t;
};
const deg = (p: P2, c: P2) => {
  const a = (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI;
  return a < 0 ? a + 360 : a;
};

/**
 * The flat pattern as a DXF, in millimetres, for a laser or a press brake: the outside on OUTLINE, holes on HOLES, and
 * bend lines dashed on BEND_UP and BEND_DOWN, each with a note of its direction, angle and inside radius on BEND_NOTES.
 * AutoCAD R12, which everything reads.
 */
export function flatDxf(flat: FlatPattern): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === 'number' ? fmt(value) : value);
  const layers: [string, number, string][] = [['OUTLINE', 7, 'CONTINUOUS'], ['HOLES', 7, 'CONTINUOUS'], ['BEND_UP', 3, 'DASHED'], ['BEND_DOWN', 1, 'DASHED'], ['BEND_NOTES', 8, 'CONTINUOUS']];
  const { min, max } = flatBounds(flat);
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$INSUNITS'); g(70, 4);
  g(9, '$EXTMIN'); g(10, min[0]); g(20, min[1]);
  g(9, '$EXTMAX'); g(10, max[0]); g(20, max[1]);
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2);
  g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
  g(0, 'LTYPE'); g(2, 'DASHED'); g(70, 0); g(3, '__ __ __'); g(72, 65); g(73, 2); g(40, 9); g(49, 6); g(49, -3);
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
  for (const [name, color, ltype] of layers) { g(0, 'LAYER'); g(2, name); g(70, 0); g(62, color); g(6, ltype); }
  g(0, 'ENDTAB');
  g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const line = (layer: string, a: P2, b: P2) => { g(0, 'LINE'); g(8, layer); g(10, a[0]); g(20, a[1]); g(30, 0); g(11, b[0]); g(21, b[1]); g(31, 0); };
  flatLoops(flat.outline).forEach((loop, i) => {
    const layer = i === 0 ? 'OUTLINE' : 'HOLES';
    for (const e of loop) {
      if ('line' in e) line(layer, e.line[0], e.line[1]);
      else if ('points' in e) e.points.slice(1).forEach((p, k) => line(layer, e.points[k], p));
      else if (same(e.arc[0], e.arc[1])) { g(0, 'CIRCLE'); g(8, layer); g(10, e.center[0]); g(20, e.center[1]); g(30, 0); g(40, e.radius); }
      else {
        // A DXF arc always runs anticlockwise, from its start angle to its end angle.
        const [from, to] = e.ccw ? e.arc : [e.arc[1], e.arc[0]];
        g(0, 'ARC'); g(8, layer); g(10, e.center[0]); g(20, e.center[1]); g(30, 0); g(40, e.radius); g(50, deg(from, e.center)); g(51, deg(to, e.center));
      }
    }
  });
  const height = Math.max(1, Math.min(5, Math.min(max[0] - min[0], max[1] - min[1]) / 25));
  for (const b of flat.bends) {
    const layer = b.direction === 'up' ? 'BEND_UP' : 'BEND_DOWN';
    line(layer, b.line[0], b.line[1]);
    const [a, c] = b.line;
    let along = (Math.atan2(c[1] - a[1], c[0] - a[0]) * 180) / Math.PI;
    // Upright enough to read: never upside down.
    if (along > 90) along -= 180;
    if (along <= -90) along += 180;
    // Beside the line rather than on it, on the side it reads from.
    const t = (along * Math.PI) / 180;
    const mid: P2 = [(a[0] + c[0]) / 2 - Math.sin(t) * height * 0.6, (a[1] + c[1]) / 2 + Math.cos(t) * height * 0.6];
    g(0, 'TEXT'); g(8, 'BEND_NOTES'); g(10, mid[0]); g(20, mid[1]); g(30, 0); g(40, height);
    g(1, `${b.direction.toUpperCase()} ${fmt(Math.round(b.degrees * 100) / 100)}%%d R${fmt(Math.round(b.radius * 1000) / 1000)}`);
    g(50, along); g(72, 1); g(73, 1); g(11, mid[0]); g(21, mid[1]); g(31, 0);
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}
