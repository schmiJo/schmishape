import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { fitView, setView } from '../commands';
import { activeDef, setValue, addPicks, addRegions, applyPickMask, canonical, dialogFeature, editFeature, flatFace, surfaceRef, pickAxisLine, pickRef, pickTakesPlanes, quadPickable, refOfPlaneQuad, regionPicksShown, regionsTakeFaces, toggleSection, pickBase, pickField, pickKey, pickKind, pickLimit, previewBase, showingFinal, startFeature, takesRegions, togglePick, toggleRegion, values, featureOfFace } from '../features/dialog';
import { axisJson, REF_KINDS } from '../features/defs';
import { corners, lineWhere, lineWords, pathWords, pointWhere, pointWords, sketchCurveSegments, sketchesIn, sketchLineSpots, sketchPointSpots, type LineSpot, type PointSpot } from '../features/refs';
import { edgeWord, faceWord, fmtNum } from '../features/words';
import { cancelSketch, editSketch, finishSketch, looksAtSketch, normalTo, session, sketchLinksOf, startSketch, visibleSketches } from '../sketch/controller';
import { PLANES, planeOnFace, polyline, toWorld, type Plane, type V2 } from '../sketch/geometry';
import { DEFAULT_PLANES, FEATURE_QUAD, frameOfInfo, hiddenPlanes, planeFrame, quadOfRef, setPlanesHidden, sketchPlane, togglePlanes } from '../store/planes';
import { drawSketch } from '../sketch/overlay';
import { measureLine } from './Measure';
import { setSection } from '../store/section';
import { setFlatBody, setFlatOpen, sheetParts } from '../store/sheetmetal';
import { sketchLines, sketchTexts, type RegionPick, type SketchRegion } from '../sketch/regions';
import type { MeshData } from '../engine/client';
import { doc, edgeList, faceList, flushAutosave, mesh, partLooks, sketchRegions, type EdgeInfo, type FaceInfo } from '../store/doc';
import { asmBox, asmClick, asmDown, asmHover, asmMenu, asmMove, asmUp, drawAssemblyOverlay, noteAsmShift } from '../assembly/interaction';
import { inAssembly } from '../store/tabs';
import { hoveredFeature, displayMode, setAppearanceFor, lookPreview, clearSelection, geometryHidden, glProblem, hiddenParts, hoverPlane, mode, selectedFeature, selectedGeometry, selectedRegions, selection, setGlProblem, setHiddenParts, setHoverPlane, setHoverText, setMode, setSelectedFeature, setSelectedGeometry, setSelectedPart, setSelectedRegions, setSelection, sketchesHidden, toggleGeometry } from '../store/ui';
import { FONT } from '../viewport/font';
import { view } from '../viewport/instance';
import { Renderer, type PickHit } from '../viewport/renderer';
import { add, cross, dot, normalize, scale, sub, type V3 } from '../viewport/math';
import { ContextMenu, type MenuItem } from './ContextMenu';
import { ViewCube } from './ViewCube';


function describeFace(f?: FaceInfo) {
  return f ? `${faceWord(f.surface)}  ${f.name}  ${fmtNum(f.area)} mm²` : '';
}
function describeEdge(e?: EdgeInfo) {
  return e ? `${edgeWord(e.curve)}  ${e.name}  ${fmtNum(e.length)} mm` : '';
}

/** A closed area of a sketch on show, where it is in the view's list of them. */
interface ShownRegion { sketch: number; sketchName: string; plane: Plane; region: SketchRegion }
function describeRegion(r?: ShownRegion) {
  return r ? `Sketch region  ${r.sketchName}  ${fmtNum(r.region.area)} mm²` : '';
}

/**
 * A plane's name, lying in the plane at its corner, so it turns and scales with it. The view is orthographic, so
 * the plane maps to the screen by one affine transform. Seen from behind or upside down it flips to stay readable.
 */
/**
 * Which corner each plane's label went in, by name, from the last view that held still. Finding a corner clear of the
 * part reads the pick buffer, which waits on the GPU and, while the view moves, redraws it every frame: with a large
 * model that stalls for seconds. So while the view moves the labels keep their corners, and they're chosen again once it
 * settles.
 */
const labelCorner = new Map<string, number | null>();
let viewKey = '';
let viewSince = 0;
let settleTimer = 0;
const SETTLE_MS = 160;

/** Whether the view has held still long enough to choose corners again. It asks for one more frame once it has. */
function viewSettled(renderer: Renderer) {
  const c = renderer.camera;
  const key = `${c.target.join()}|${c.rot.join()}|${c.halfH}|${c.width}|${c.height}`;
  const now = performance.now();
  if (key !== viewKey) {
    viewKey = key;
    viewSince = now;
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => renderer.invalidate(), SETTLE_MS + 10);
    return false;
  }
  return now - viewSince >= SETTLE_MS;
}

function drawPlaneLabel(ctx: CanvasRenderingContext2D, renderer: Renderer, name: string, plane: Plane, half: number, anyCorner = false, choose = true) {
  const cam = renderer.camera;
  const r = cam.right(), u = cam.up();
  const pxPerMm = cam.height / (cam.halfH * 2);
  const heightMm = half * 0.06;
  if (heightMm * pxPerMm < 6) return;
  const flat = (v: V3): [number, number] => [dot(v, r) * pxPerMm, -dot(v, u) * pxPerMm];
  const fontPx = 40;
  const k = heightMm / fontPx;
  const neg = (v: V3): V3 => scale(v, -1);
  let across = plane.x;
  let down = neg(plane.y);
  const a0 = flat(across), d0 = flat(down);
  if (a0[0] * d0[1] - a0[1] * d0[0] < 0) down = plane.y;
  if (flat(across)[0] < 0) {
    across = neg(across);
    down = neg(down);
  }
  const pad = half * 0.04;
  const ex = flat(across), ey = flat(down);
  ctx.font = `400 ${fontPx}px ${FONT}`;
  const wide = (ctx.measureText(name).width / fontPx) * heightMm;
  // The top left corner as you look at it, and for a plane feature, whichever other corner is clear of the part.
  const spots: [number, number][] = anyCorner ? [[-1, -1], [1, -1], [-1, 1], [1, 1]] : [[-1, -1]];
  const at = (i: number) => {
    const [a, b] = spots[i];
    const from = add(add(plane.origin, scale(across, a * (half - pad) - (a > 0 ? wide : 0))), scale(down, b * (half - pad) - (b > 0 ? heightMm : 0)));
    const [sx, sy] = cam.project(from);
    const middle = (t: number) => [sx + (ex[0] * k * fontPx * t) + (ey[0] * k * fontPx) / 2, sy + (ex[1] * k * fontPx * t) + (ey[1] * k * fontPx) / 2];
    return { sx, sy, middle };
  };
  const onScreen = (x: number, y: number) => x >= 0 && y >= 0 && x <= cam.width && y <= cam.height;
  let corner: number | null;
  if (choose || !labelCorner.has(name)) {
    // Painted on top of everything, so it only shows where it isn't lying across the part.
    corner = spots.findIndex((_, i) => [0, 1, 2].every((t) => { const [x, y] = at(i).middle(t); return onScreen(x, y) && !renderer.overModel(x, y); }));
    if (corner < 0) corner = null;
    labelCorner.set(name, corner);
  } else corner = labelCorner.get(name) ?? null;
  if (corner === null || corner >= spots.length) return;
  const { sx: cx, sy: cy, middle } = at(corner);
  if (!choose && ![0, 1, 2].every((t) => onScreen(middle(t)[0], middle(t)[1]))) return;
  const clear = [cx, cy];
  const [sx, sy] = clear;
  const d = renderer.dpr;
  ctx.setTransform(d * ex[0] * k, d * ex[1] * k, d * ey[0] * k, d * ey[1] * k, d * sx, d * sy);
  ctx.font = `400 ${fontPx}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#4A71A6';
  ctx.fillText(name, 0, 0);
}

/** The faces and edges entirely inside a screen rectangle. */
function withinBox(m: MeshData | null, renderer: Renderer, b: { x: number; y: number; w: number; h: number }) {
  if (!m || !m.indices.length) return null;
  const cam = renderer.camera;
  const r = cam.right(), u = cam.up(), t = cam.target;
  const k = cam.height / (cam.halfH * 2);
  const inside = (x: number, y: number, z: number) => {
    const dx = x - t[0], dy = y - t[1], dz = z - t[2];
    const sx = cam.width / 2 + (dx * r[0] + dy * r[1] + dz * r[2]) * k;
    const sy = cam.height / 2 - (dx * u[0] + dy * u[1] + dz * u[2]) * k;
    return sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h;
  };
  const faceOut = new Uint8Array(m.faces);
  for (let v = 0; v < m.faceIds.length; v++) {
    if (!inside(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2])) faceOut[m.faceIds[v]] = 1;
  }
  const edgeOut = new Uint8Array(m.edges);
  const edgeSeen = new Uint8Array(m.edges);
  for (let i = 0; i < m.segmentIds.length; i++) {
    const e = m.segmentIds[i], o = i * 6;
    edgeSeen[e] = 1;
    if (!inside(m.segments[o], m.segments[o + 1], m.segments[o + 2]) || !inside(m.segments[o + 3], m.segments[o + 4], m.segments[o + 5])) edgeOut[e] = 1;
  }
  const faces: number[] = [], edges: number[] = [];
  faceOut.forEach((out, i) => { if (!out) faces.push(i); });
  edgeOut.forEach((out, i) => { if (!out && edgeSeen[i]) edges.push(i); });
  return { faces, edges };
}

/** The first point on the model under a pixel, with the surface's normal there. The view is orthographic, so every ray runs the same way. */
function surfaceHit(m: MeshData | null, renderer: Renderer, x: number, y: number): { point: V3; normal: V3 } | null {
  if (!m || !m.indices.length) return null;
  const cam = renderer.camera;
  const o = cam.unproject(x, y), d = scale(cam.back(), -1);
  const p = m.positions, idx = m.indices, nor = m.normals;
  const hidden = new Set(hiddenPartFaces(m));
  let best = Infinity, bi = -1, bu = 0, bv = 0;
  for (let i = 0; i < idx.length; i += 3) {
    if (hidden.size && hidden.has(m.faceIds[idx[i]])) continue;
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const tx = o[0] - p[a], ty = o[1] - p[a + 1], tz = o[2] - p[a + 2];
    const u = (tx * px + ty * py + tz * pz) / det;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (t < best) {
      best = t;
      bi = i;
      bu = u;
      bv = v;
    }
  }
  if (bi < 0) return null;
  const w = 1 - bu - bv;
  const a = idx[bi] * 3, b = idx[bi + 1] * 3, c = idx[bi + 2] * 3;
  const normal = normalize([w * nor[a] + bu * nor[b] + bv * nor[c], w * nor[a + 1] + bu * nor[b + 1] + bv * nor[c + 1], w * nor[a + 2] + bu * nor[b + 2] + bv * nor[c + 2]]);
  return { point: add(o, scale(d, best)), normal };
}

/** `#rrggbb` as three numbers from 0 to 1. */
const hexColor = (hex: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
};

const hiddenPartFaces = (m: MeshData) => [...hiddenParts()].flatMap((i) => m.parts[i]?.faces ?? []);

/** Where a rotation turns, the way Onshape picks it: the model under the cursor when the drag starts, or the model's center from empty space. */
function rotationPivot(m: MeshData | null, renderer: Renderer, x: number, y: number): V3 {
  if (!m || !m.indices.length) return [0, 0, 0];
  return surfaceHit(m, renderer, x, y)?.point ?? [(m.min[0] + m.max[0]) / 2, (m.min[1] + m.max[1]) / 2, (m.min[2] + m.max[2]) / 2];
}

function drawOrigin(ctx: CanvasRenderingContext2D, renderer: Renderer, selected: boolean) {
  const d = renderer.dpr;
  const [x, y] = renderer.camera.project([0, 0, 0]);
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.strokeStyle = selected ? '#D97E00' : '#1C2227';
  ctx.fillStyle = selected ? '#D97E00' : '#1C2227';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 1.2, 0, Math.PI * 2);
  ctx.fill();
}

const MARK = '#D97E00';

/**
 * The points and sketch lines a box has picked, and the one under the pointer, drawn over the view. Points that go in
 * order, as a three-point plane's, carry their number.
 */
function drawMarks(ctx: CanvasRenderingContext2D, renderer: Renderer, marks: Marks) {
  const d = renderer.dpr;
  const cam = renderer.camera;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.lineCap = 'round';
  const line = ([a, b]: [V3, V3], width: number, alpha: number) => {
    const [ax, ay] = cam.project(a), [bx, by] = cam.project(b);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = MARK;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  };
  for (const l of marks.lines) line(l, 3, 1);
  if (marks.hoverLine) line(marks.hoverLine, 2.5, 0.6);
  for (const l of marks.hoverLines ?? []) line(l, 2.5, 0.6);
  ctx.globalAlpha = 1;
  ctx.font = `600 11px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  marks.points.forEach((p, i) => {
    const [x, y] = cam.project(p);
    ctx.fillStyle = MARK;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (marks.numbered) {
      ctx.lineWidth = 3;
      ctx.strokeText(String(i + 1), x + 6, y - 4);
      ctx.fillText(String(i + 1), x + 6, y - 4);
    }
  });
  if (marks.hoverPoint) {
    const [x, y] = cam.project(marks.hoverPoint);
    ctx.strokeStyle = MARK;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.stroke();
  }
}

/** A measured distance, dotted between its two nearest points, as Onshape draws it. */
function drawMeasureLine(ctx: CanvasRenderingContext2D, renderer: Renderer, [a, b]: [V3, V3]) {
  const d = renderer.dpr;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  const [ax, ay] = renderer.camera.project(a), [bx, by] = renderer.camera.project(b);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = MARK;
  ctx.fillStyle = MARK;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [x, y] of [[ax, ay], [bx, by]]) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The middle of some regions of a sketch, by area, in its own coordinates. */
function regionsMiddle(regions: SketchRegion[]): V2 | null {
  let area = 0, cx = 0, cy = 0;
  for (const r of regions) {
    const loop = r.loops[0];
    let a = 0, x = 0, y = 0;
    for (let i = 0; i < loop.length; i++) {
      const [x0, y0] = loop[i], [x1, y1] = loop[(i + 1) % loop.length];
      const c = x0 * y1 - x1 * y0;
      a += c;
      x += (x0 + x1) * c;
      y += (y0 + y1) * c;
    }
    if (Math.abs(a) < 1e-12) continue;
    cx += x / 3;
    cy += y / 3;
    area += a;
  }
  return Math.abs(area) > 1e-12 ? [cx / area, cy / area] : null;
}

/** Onshape's arrow on a blind extrude, from where it starts to where it ends: dragging its head sets the depth. */
interface Arrow { from: V3; dir: V3; depth: number; symmetric: boolean; hot: boolean; key: string; signed?: boolean }
const arrowTip = (a: Arrow): V3 => add(a.from, scale(a.dir, a.symmetric ? a.depth / 2 : a.depth));

function drawArrow(ctx: CanvasRenderingContext2D, renderer: Renderer, a: Arrow) {
  const d = renderer.dpr;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  const cam = renderer.camera;
  const [fx, fy] = cam.project(a.from);
  const [tx, ty] = cam.project(arrowTip(a));
  let ux = tx - fx, uy = ty - fy;
  const len = Math.hypot(ux, uy);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = MARK;
  ctx.fillStyle = MARK;
  ctx.lineWidth = a.hot ? 2.5 : 1.75;
  if (len >= 16) {
    ux /= len;
    uy /= len;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    // The head, past the end, so it doesn't cover the face it ends at.
    const s = a.hot ? 13 : 11;
    const hx = tx + ux * s, hy = ty + uy * s;
    ctx.beginPath();
    ctx.moveTo(hx, hy);
    ctx.lineTo(tx - uy * s * 0.42, ty + ux * s * 0.42);
    ctx.lineTo(tx + uy * s * 0.42, ty - ux * s * 0.42);
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(fx, fy, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `600 11px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const text = `${fmtNum(a.depth)} mm`;
  const lx = tx + (len >= 16 ? -uy : 0) * 16 + 10, ly = ty + (len >= 16 ? ux : 0) * 16;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#FFFFFF';
  ctx.strokeText(text, lx, ly);
  ctx.fillStyle = '#7a4a00';
  ctx.fillText(text, lx, ly);
}

/**
 * Onshape's arc on a revolve: from the profile's middle round the axis, as far as it turns, with a head to drag. A point
 * on it is foot + u cos θ + v sin θ, turning right-handed about the axis.
 */
interface Turn { foot: V3; u: V3; v: V3; degrees: number; hot: boolean }
const turnAt = (t: Turn, deg: number): V3 => {
  const a = (deg * Math.PI) / 180;
  return add(t.foot, add(scale(t.u, Math.cos(a)), scale(t.v, Math.sin(a))));
};

function drawTurn(ctx: CanvasRenderingContext2D, renderer: Renderer, t: Turn) {
  const d = renderer.dpr;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  const cam = renderer.camera;
  const n = Math.max(8, Math.ceil(Math.abs(t.degrees) / 4));
  ctx.globalAlpha = 1;
  ctx.strokeStyle = MARK;
  ctx.fillStyle = MARK;
  ctx.lineWidth = t.hot ? 2.5 : 1.75;
  ctx.setLineDash([5, 3]);
  ctx.beginPath();
  const [ax, ay] = cam.project(t.foot), [bx, by] = cam.project(turnAt(t, 0));
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const [x, y] = cam.project(turnAt(t, (t.degrees * i) / n));
    if (i) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
  }
  ctx.stroke();
  const [ex, ey] = cam.project(turnAt(t, t.degrees));
  const [px, py] = cam.project(turnAt(t, t.degrees - Math.sign(t.degrees || 1) * 2));
  let ux = ex - px, uy = ey - py;
  const len = Math.hypot(ux, uy) || 1;
  ux /= len;
  uy /= len;
  const s = t.hot ? 13 : 11;
  ctx.beginPath();
  ctx.moveTo(ex + ux * s, ey + uy * s);
  ctx.lineTo(ex - uy * s * 0.42, ey + ux * s * 0.42);
  ctx.lineTo(ex + uy * s * 0.42, ey - ux * s * 0.42);
  ctx.closePath();
  ctx.fill();
  ctx.font = `600 11px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const text = `${fmtNum(t.degrees)}°`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#FFFFFF';
  ctx.strokeText(text, ex + 14, ey - 10);
  ctx.fillStyle = '#7a4a00';
  ctx.fillText(text, ex + 14, ey - 10);
}

interface Marks { points: V3[]; numbered: boolean; lines: [V3, V3][]; hoverPoint: V3 | null; hoverLine: [V3, V3] | null; hoverLines?: [V3, V3][] }

/** Where a point lands on a plane, seen straight along its normal. */
const ontoPlane = (p: V3, origin: V3, normal: V3) => sub(p, scale(normal, dot(sub(p, origin), normal)));

function GlNotice(props: { problem: 'missing' | 'lost' }) {
  const inEditor = /\bCode\/\d|Electron/.test(navigator.userAgent);
  const [copied, setCopied] = createSignal(false);
  let address!: HTMLInputElement;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
    } catch {
      // Embedded previews often refuse the clipboard. Selecting it leaves Ctrl C one key away.
      address.focus();
      address.select();
    }
  };
  return (
    <div class="gl-notice" data-testid="gl-missing" onPointerDown={(e) => e.stopPropagation()}>
      <Show when={props.problem === 'missing'} fallback={<><h3>The graphics driver stopped responding</h3><p>Your part is saved. It comes back here as soon as the driver does.</p></>}>
        <h3>This window can’t draw 3D</h3>
        <p>{inEditor ? 'VS Code’s built-in preview has graphics turned off, so the model can’t be drawn here.' : 'This browser isn’t providing WebGL2, which schmishape needs to draw the model.'} Open this address in Chrome, Edge or Firefox instead:</p>
        <div class="gl-address">
          <input ref={address} readOnly value={location.href} aria-label="Address to open" onFocus={(e) => e.currentTarget.select()} />
          <button class="btn" onClick={copy}>{copied() ? 'Copied' : 'Copy'}</button>
          <a class="btn primary" href={location.href} target="_blank" rel="noopener">Open in browser</a>
        </div>
      </Show>
    </div>
  );
}

/**
 * Where a plane feature's square is drawn. A plane through a point is centred on it, and one through three on the middle
 * of them. An offset or mid plane of Top,
 * Front or Right lines up with them, and one of a face sits over the middle of the model, where the face is.
 */
function planeCenter(f: any, frame: Plane, modelCenter: V3 | null): V3 {
  const t = f.plane_type;
  // Three points: the middle of them, so all three are on the square.
  if (t === 'three_point') {
    const at = (f.points ?? []).map(pointWhere);
    if (at.length === 3 && at.every((p: V3 | null) => p)) return ontoPlane(scale(add(add(at[0], at[1]), at[2]), 1 / 3), frame.origin, frame.z);
  }
  if (t !== 'offset' && t !== 'mid_plane') return frame.origin;
  const refs = [f.plane, ...(f.planes ?? []), ...(f.points ?? [])].filter((x) => x !== undefined);
  if (!modelCenter || refs.every((r) => (DEFAULT_PLANES as readonly unknown[]).includes(r) || r === 'origin')) return frame.origin;
  return ontoPlane(modelCenter, frame.origin, frame.z);
}

export function Viewport() {
  let host!: HTMLDivElement;
  let glCanvas!: HTMLCanvasElement;
  let overlay!: HTMLCanvasElement;
  let dimInput: HTMLInputElement | undefined;
  const [hoverHit, setHoverHit] = createSignal<PickHit | null>(null);
  /** The line of a revolve's sketch under the pointer, while the axis box takes clicks. */
  const [hoverLine, setHoverLine] = createSignal<number | null>(null);
  const [cursor, setCursor] = createSignal('');
  const [box, setBox] = createSignal<{ x: number; y: number; w: number; h: number } | null>(null);
  const [context, setContext] = createSignal<{ x: number; y: number; items: (MenuItem | null)[] } | null>(null);
  const [shownRegions, setShownRegions] = createSignal<ShownRegion[]>([]);
  /** The point or sketch line a box taking points or lines would pick, under the pointer. */
  const [hoverRef, setHoverRef] = createSignal<{ point?: V3; line?: [V3, V3]; lines?: [V3, V3][] } | null>(null);
  // A used sketch stays on show while it's chosen in a dialog, or one of its regions, points or lines is, or while one of
  // its regions is selected.
  const alsoShown = (): (number | null | undefined)[] => (activeDef() ? [values.sketch, ...regionPicksShown().map((p) => p.sketch), ...sketchesIn({ ...values })] : [selectedRegions()?.sketch]);
  let renderer!: Renderer;
  let labels: { name: string; plane: Plane; half: number; anyCorner?: boolean }[] = [];
  let marks: Marks | null = null;
  /** The faces the feature selected in the list made, by the mesh's numbers. */
  const [featureFaces, setFeatureFaces] = createSignal<number[]>([]);
  createEffect(() => {
    const id = hoveredFeature() ?? selectedFeature();
    mesh();
    const f = id !== null ? doc.features.find((x) => x.id === id) : null;
    if (!f || f.type === 'constrained_sketch' || f.type === 'sketch' || f.type === 'plane') {
      setFeatureFaces([]);
      return;
    }
    let live = true;
    onCleanup(() => { live = false; });
    void faceList().then((list) => {
      if (live) setFeatureFaces(list.flatMap((x, i) => (x.name.startsWith(`f${id}:`) ? [i] : [])));
    });
  });
  let arrow: Arrow | null = null;
  let arrowHot = false;
  let turn: Turn | null = null;
  let turnHot = false;
  let lastMesh: unknown = null;
  let hadSolid = false;
  let planeSize = 50;
  let partCount = 0;

  onMount(() => {
    try {
      renderer = new Renderer(glCanvas);
    } catch {
      setGlProblem('missing');
      return;
    }
    // A driver reset wipes everything on the GPU. Reloading rebuilds it all from the autosave.
    glCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      flushAutosave();
      setGlProblem('lost');
    });
    glCanvas.addEventListener('webglcontextrestored', () => location.reload());
    view.renderer = renderer;
    view.redraw = () => {
      renderer.dirty = true;
    };
    const ctx = overlay.getContext('2d')!;
    // The overlay is only touched while it has something to show. Leaving a sketch resets it outright and
    // hides it, so a part can never show a leftover frame of a sketch on top of it.
    let painted = false;
    let wasSketching = false;
    renderer.afterRender = () => {
      const s = session();
      const origin = !geometryHidden().has('origin');
      if (wasSketching && !s) overlay.width = Math.round(renderer.camera.width * renderer.dpr);
      wasSketching = !!s;
      const measured = !s && !activeDef() ? measureLine() : null;
      if (s || labels.length || origin || inAssembly() || marks || arrow || turn || measured) {
        const d = renderer.dpr;
        overlay.style.display = '';
        ctx.setTransform(d, 0, 0, d, 0, 0);
        ctx.clearRect(0, 0, renderer.camera.width, renderer.camera.height);
        const settled = labels.length ? viewSettled(renderer) : true;
        for (const l of labels) drawPlaneLabel(ctx, renderer, l.name, l.plane, l.half, l.anyCorner, settled);
        if (s) {
          ctx.setTransform(d, 0, 0, d, 0, 0);
          drawSketch(ctx, s);
        } else if (origin) drawOrigin(ctx, renderer, selectedGeometry() === 'origin');
        if (marks && !s) drawMarks(ctx, renderer, marks);
        if (arrow && !s) drawArrow(ctx, renderer, { ...arrow, hot: arrowHot });
        if (turn && !s) drawTurn(ctx, renderer, { ...turn, hot: turnHot });
        if (measured) drawMeasureLine(ctx, renderer, measured);
        if (inAssembly()) drawAssemblyOverlay(ctx);
        painted = true;
      } else if (painted) {
        overlay.width = Math.round(renderer.camera.width * renderer.dpr);
        overlay.style.display = 'none';
        painted = false;
      }
      view.redrawCube();
    };
    const fit = () => {
      const box = host.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      renderer.resize(box.width, box.height, dpr);
      overlay.width = Math.round(box.width * dpr);
      overlay.height = Math.round(box.height * dpr);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    fit();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const b = host.getBoundingClientRect();
      renderer.camera.zoomAt(Math.exp(e.deltaY * (e.ctrlKey ? 0.012 : 0.0016)), e.clientX - b.left, e.clientY - b.top);
      renderer.invalidate();
    };
    host.addEventListener('wheel', wheel, { passive: false });
    onCleanup(() => {
      ro.disconnect();
      host.removeEventListener('wheel', wheel);
      renderer.dispose();
    });

    // The solid, and what's lit on it. One effect, so a new mesh never misses its highlights.
    createEffect(() => {
      const m = mesh();
      if (m !== lastMesh) {
        lastMesh = m;
        renderer.setMesh(m);
        const has = !!m && m.indices.length > 0;
        // Not while picking regions: fitting to the first one would push the others out of view.
        if (has && !hadSolid && !takesRegions()) fitView();
        // Rolling back to before the first solid hasn't lost it: coming forward again mustn't move the view.
        hadSolid = has || (hadSolid && doc.rollback !== null);
        // Part numbers go by position, so a change in how many there are makes old choices meaningless.
        if ((m?.parts.length ?? 0) !== partCount) {
          partCount = m?.parts.length ?? 0;
          setHiddenParts(new Set<number>());
          setSelectedPart(null);
        }
      }
      const sel = selection();
      const hit = hoverHit();
      const base = pickBase();
      const key = pickKey();
      const faces = new Map<number, number>();
      const edges = new Map<number, number>();
      // A feature selected in the list lights what it made, as in Onshape.
      if (!activeDef()) for (const i of featureFaces()) faces.set(i, 1);
      if (base && pickKind() === 'regions') {
        const refs = new Set<string>(values.faces ?? []);
        base.faces.forEach((f, i) => {
          if (refs.has(f.name) || refs.has(f.key)) faces.set(i, 2);
        });
      } else if (base && key && pickKind() !== 'axis') {
        const v = values[key];
        const list: any[] = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v];
        const kind = pickKind();
        if (kind === 'edges' || kind === 'path') {
          const chosen = new Set(list.filter((x) => !(x && typeof x.sketch === 'number')).map(canonical));
          base.edges.forEach((e, i) => {
            if (chosen.has(canonical(e.select))) edges.set(i, 2);
          });
        } else if (kind === 'part' || kind === 'parts') {
          for (const p of base.mesh.parts) if (list.includes(p.name)) p.faces.forEach((i) => faces.set(i, 2));
        } else if (kind === 'features') {
          base.faces.forEach((_, i) => {
            const id = featureOfFace(base, i);
            if (id !== null && list.includes(id)) faces.set(i, 2);
          });
        } else if (kind === 'faces' || kind === 'face' || kind === 'plane' || kind === 'planes') {
          const names = new Set(list);
          base.faces.forEach((f, i) => {
            if (names.has(f.name) || names.has(f.key)) faces.set(i, 2);
          });
        } else if (kind === 'edge' || kind === 'line') {
          // A line can be an edge, or the axis of a round face or edge.
          const axes = list.map((r) => (r && typeof r === 'object' && 'axis_of' in r ? r.axis_of : null));
          const faceNames = new Set(axes.filter((a) => typeof a === 'string'));
          const chosen = new Set(list.map((r, i) => canonical(axes[i] ?? r)));
          base.faces.forEach((f, i) => { if (faceNames.has(f.name) || faceNames.has(f.key)) faces.set(i, 2); });
          base.edges.forEach((e, i) => { if (chosen.has(canonical(e.select))) edges.set(i, 2); });
        }
      } else {
        sel.faces.forEach((i) => faces.set(i, 2));
        sel.edges.forEach((i) => edges.set(i, 2));
      }
      const hoverPart = base && hit?.kind === 'face' && (pickKind() === 'part' || pickKind() === 'parts') ? base.mesh.parts.find((p) => p.faces.includes(hit.id)) : null;
      if (hoverPart) hoverPart.faces.forEach((i) => { if (!faces.has(i)) faces.set(i, 1); });
      // Hovering a face, for a mirror or pattern of features, lights everything the feature that made it made.
      const hoverFeature = base && hit?.kind === 'face' && pickKind() === 'features' ? featureOfFace(base, hit.id) : null;
      if (base && hoverFeature !== null) base.faces.forEach((_, i) => { if (!faces.has(i) && featureOfFace(base, i) === hoverFeature) faces.set(i, 1); });
      // What a click wouldn't pick doesn't light up as if it would: a curved face for an extrude or a plane, anything
      // for a point, which is marked on its own, or a face with no axis for a line.
      const kindNow = pickKind();
      const pointing = kindNow === 'point' || kindNow === 'points';
      const faceOff = (i: number) => !!base && ((kindNow === 'regions' && (!regionsTakeFaces() || !flatFace(base, i))) || ((kindNow === 'plane' || kindNow === 'planes') && !flatFace(base, i)) || pointing || (kindNow === 'line' && !base.faces[i]?.axis));
      const edgeOff = (i: number) => !!base && (pointing || (kindNow === 'line' && !['line', 'circle', 'ellipse'].includes(base.edges[i]?.curve)));
      if (hit?.kind === 'face' && !faces.has(hit.id) && !faceOff(hit.id)) faces.set(hit.id, 1);
      if (hit?.kind === 'edge' && !edges.has(hit.id) && !edgeOff(hit.id)) edges.set(hit.id, 1);
      const parts = m?.parts ?? [];
      const hidden = [...hiddenParts()].filter((i) => parts[i]);
      renderer.setStates(faces, edges, hidden.flatMap((i) => parts[i].faces), hidden.flatMap((i) => parts[i].edges));
    });


    createEffect(() => {
      const lit = hoverPlane();
      const chosen = selectedGeometry();
      const hidden = geometryHidden();
      // While a plane is wanted, every plane shows, hidden or not.
      const picking = mode() === 'pick-plane' || pickTakesPlanes();
      const m = mesh();
      // Going back to an earlier step leaves the planes as they were, like the rest of the view.
      // And so does trying out regions, which would otherwise resize them with every click.
      if (doc.rollback === null && !takesRegions()) planeSize = m && m.indices.length ? Math.max(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]) * 0.8 : 50;
      const size = planeSize;
      const key = pickKey();
      const picked = new Set<number>();
      if (key && pickTakesPlanes()) for (const r of [values[key]].flat()) { const q = quadOfRef(r); if (q !== null) picked.add(q); }
      const quads: { id: number; name: string; plane: Plane; half: number; pickable: boolean; lit: boolean }[] = [];
      if (!inAssembly()) {
        for (const p of PLANES) if (picking || lit === p.id || !hidden.has(p.id)) quads.push({ id: p.id, name: p.name, plane: p.plane, half: size, pickable: true, lit: lit === p.id || chosen === p.id || picked.has(p.id) });
        const making = activeDef()?.id === 'plane' ? dialogFeature() : null;
        const off = new Set(hiddenPlanes());
        const center = m && m.indices.length ? scale(add(m.min, m.max), 0.5) : null;
        for (const info of doc.planes) {
          const frame = info.type === 'plane' && info.id !== undefined ? frameOfInfo(info) : null;
          if (!frame || info.id === undefined) continue;
          const id = FEATURE_QUAD + info.id;
          const f = doc.features.find((x) => x.id === info.id);
          if (!f || f.suppressed || (off.has(info.id) && !picking && lit !== id && info.id !== making)) continue;
          // Its own display size if it has one, and otherwise a size that goes with the model's.
          const own = Number(f.app?.size);
          quads.push({ id, name: f.name, plane: { ...frame, origin: planeCenter(f, frame, center) }, half: own > 0 ? own / 2 : size * 0.6, pickable: quadPickable(id) || !activeDef(), lit: lit === id || selectedFeature() === info.id || picked.has(id) || info.id === making });
        }
      }
      renderer.setPlanes(quads.map((q) => ({ id: q.id, origin: q.plane.origin, u: q.plane.x, v: q.plane.y, half: q.half, lit: q.lit, pickable: q.pickable })));
      labels = quads.map((q) => ({ name: q.name, plane: q.plane, half: q.half, anyCorner: q.id >= FEATURE_QUAD }));
      renderer.pickMask = activeDef() ? renderer.pickMask : { faces: true, edges: !picking, planes: quads.length > 0, regions: !picking };
      renderer.invalidate();
    });

    // The points and sketch lines a box has picked, and the one under the pointer, drawn over the view.
    createEffect(() => {
      const kind = pickKind();
      const key = pickKey();
      const hover = hoverRef();
      doc.planes;
      if (activeDef() && key && kind === 'path') {
        // A sketch picked as a path is drawn whole, as the curves it gives.
        const list = [values[key]].flat().filter((x: any) => x && typeof x.sketch === 'number');
        const segs = list.flatMap((x: any) => {
          const f = doc.features.find((y) => y.id === x.sketch);
          return f ? sketchCurveSegments(f).map((g) => [g.a, g.b] as [V3, V3]) : [];
        });
        marks = { points: [], numbered: false, lines: segs, hoverPoint: null, hoverLine: null, hoverLines: hover?.lines ?? [] };
      } else if (!activeDef() || !key || !(kind === 'point' || kind === 'points' || kind === 'line')) marks = null;
      else {
        const list = [values[key]].flat().filter((x) => x !== null && x !== undefined);
        marks = {
          points: kind === 'line' ? [] : list.map(pointWhere).filter((p): p is V3 => !!p),
          numbered: kind === 'points',
          lines: kind === 'line' ? list.map(lineWhere).filter((l): l is [V3, V3] => !!l) : [],
          hoverPoint: hover?.point ?? null,
          hoverLine: hover?.line ?? null,
        };
      }
      renderer.invalidate();
    });

    // A blind extrude's arrow, from where the depth starts to where it ends, and a revolve's arc.
    createEffect(() => {
      arrow = null;
      turn = null;
      const def = activeDef();
      if (def?.id === 'extrude' && (values.end ?? 'blind') === 'blind' && !values.secondOn) {
        const depth = Number(String(values.length ?? '').trim());
        const offset = values.offsetOn ? Number(String(values.offset ?? '').trim()) : 0;
        let from: V3 | null = null;
        let normal: V3 | null = null;
        const picks = regionPicksShown();
        const sketchId = picks[0]?.sketch ?? (typeof values.sketch === 'number' ? values.sketch : null);
        const f = sketchId !== null ? doc.features.find((x) => x.id === sketchId) : null;
        if (f) {
          const all = sketchRegions().get(f.id) ?? [];
          const ids = picks.length ? picks.filter((p) => p.sketch === f.id).map((p) => p.id) : all.filter((r) => r.depth % 2 === 0).map((r) => r.id);
          const mid = regionsMiddle(all.filter((r) => ids.includes(r.id)));
          if (mid) {
            const plane = sketchPlane(f);
            from = toWorld(plane, mid);
            normal = plane.z;
          }
        } else if ((values.faces ?? []).length) {
          const face = pickBase()?.faces.find((x) => x.name === values.faces[0] || x.key === values.faces[0]);
          if (face) {
            from = face.center;
            normal = face.normal;
          }
        }
        if (from && normal && Number.isFinite(depth) && Number.isFinite(offset) && depth > 0) {
          const dir = scale(normalize(normal), values.flip && !values.symmetric ? -1 : 1);
          arrow = { from: add(from, scale(dir, offset)), dir, depth, symmetric: !!values.symmetric, hot: false, key: 'length' };
        }
      }
      // A revolve's arc, from the middle of what it turns, round its axis.
      if (def?.id === 'revolve') {
        const degrees = Number(String(values.degrees ?? '').trim());
        const picks = regionPicksShown();
        const sketchId = picks[0]?.sketch ?? (typeof values.sketch === 'number' ? values.sketch : null);
        const f = sketchId !== null ? doc.features.find((x) => x.id === sketchId) : null;
        const all = f ? sketchRegions().get(f.id) ?? [] : [];
        const ids = picks.length ? picks.filter((p) => p.sketch === f?.id).map((p) => p.id) : all.filter((r) => r.depth % 2 === 0).map((r) => r.id);
        const mid = f ? regionsMiddle(all.filter((r) => ids.includes(r.id))) : null;
        const ax = f ? axisJson(f.id, values.axis, values.customAxis) : null;
        if (f && mid && ax !== null && Number.isFinite(degrees) && degrees > 0) {
          const plane = sketchPlane(f);
          const a = ax as { point: V2; direction: V2 } | undefined;
          const at = a ? toWorld(plane, a.point) : plane.origin;
          const dir = a ? normalize(sub(toWorld(plane, [a.point[0] + a.direction[0], a.point[1] + a.direction[1]]), at)) : normalize(plane.z);
          const c = toWorld(plane, mid);
          const foot = add(at, scale(dir, dot(sub(c, at), dir)));
          const u = sub(c, foot);
          if (Math.hypot(u[0], u[1], u[2]) > 1e-6) turn = { foot, u, v: cross(dir, u), degrees, hot: false };
        }
      }
      // An offset plane's distance, from the plane it's offset from.
      if (def?.id === 'plane' && values.planeType === 'offset') {
        const distance = Number(String(values.distance ?? '').trim());
        const id = dialogFeature();
        const p = id !== null ? doc.planes.find((x) => x.id === id) : null;
        if (p?.origin && p.normal && Number.isFinite(distance)) {
          const dir = scale(normalize(p.normal), values.flip ? -1 : 1);
          arrow = { from: sub(p.origin, scale(dir, distance)), dir, depth: distance, symmetric: false, hot: false, key: 'distance', signed: true };
        }
      }
      // A thicken's thickness, out of the first face.
      if (def?.id === 'thicken' && (values.faces ?? []).length) {
        const t = Number(String(values.thickness ?? '').trim());
        const face = pickBase()?.faces.find((x) => x.name === values.faces[0] || x.key === values.faces[0]);
        if (face && Number.isFinite(t)) arrow = { from: face.center, dir: normalize(face.normal), depth: t, symmetric: false, hot: false, key: 'thickness', signed: true };
      }
      renderer.invalidate();
    });

    createEffect(() => {
      measureLine();
      renderer.invalidate();
    });

    createEffect(() => {
      renderer.displayMode = displayMode();
      renderer.invalidate();
    });

    // While picking regions, an added feature's preview is glass over the model before it, so the sketch stays in sight.
    // A cut stays solid, because the hole is what you need to see, and Final shows the finished model as it is.
    createEffect(() => {
      renderer.ghostPreview = takesRegions() && !showingFinal() && values.body !== 'surface' && (values.mode === 'add' || values.mode === 'new_body');
      renderer.invalidate();
    });

    // Clicks go to whichever box in the dialog has the blue edge, so the view only offers what that box takes.
    createEffect(() => {
      activeDef();
      const kind = pickKind();
      applyPickMask();
      // What the pointer was over meant something to the box before, and may mean nothing now.
      if (kind !== 'axis') {
        setHoverLine(null);
        setHoverText('');
      }
    });

    createEffect(() => {
      const base = previewBase();
      renderer.setPreviewBase(base);
      const hidden = [...hiddenParts()];
      if (base) renderer.setPreviewBaseHidden(hidden.flatMap((i) => base.parts[i]?.faces ?? []), hidden.flatMap((i) => base.parts[i]?.edges ?? []));
    });

    // After the meshes are made, so a new one gets its colors.
    // Each part in its own color, if it has one, on the model and on the model under a see-through preview.
    createEffect(() => {
      const looks = partLooks();
      const trying = lookPreview();
      const colorsOf = (md: MeshData | null) => {
        const out = new Map<number, [number, number, number]>();
        for (const p of md?.parts ?? []) {
          const hex = trying?.body === p.name ? trying.color : looks[p.name]?.color;
          const rgb = hex ? hexColor(hex) : null;
          if (rgb) for (const f of p.faces) out.set(f, rgb);
        }
        return out;
      };
      // Whatever remakes either mesh on the GPU wipes its colors, so this follows all of it.
      hiddenParts();
      renderer.setFaceColors(colorsOf(mesh()), colorsOf(previewBase()));
    });


    // The closed areas of those sketches, shaded and pickable. A dialog can only use what comes before it.
    createEffect(() => {
      mesh();
      selectedFeature();
      sketchesHidden();
      const limit = takesRegions() ? pickLimit() : Infinity;
      const editing = session()?.featureId;
      const list: ShownRegion[] = [];
      const positions: number[] = [];
      const ids: number[] = [];
      for (const f of visibleSketches(alsoShown())) {
        if (f.id === editing || doc.features.findIndex((x) => x.id === f.id) >= limit) continue;
        const plane = sketchPlane(f);
        for (const region of sketchRegions().get(f.id) ?? []) {
          for (const i of region.triangles) {
            positions.push(...toWorld(plane, region.points[i]));
            ids.push(list.length);
          }
          list.push({ sketch: f.id, sketchName: f.name, plane, region });
        }
      }
      renderer.setRegions(new Float32Array(positions), new Uint32Array(ids));
      setShownRegions(list);
    });

    createEffect(() => {
      const list = shownRegions();
      const hit = hoverHit();
      const picks: RegionPick[] = takesRegions() ? regionPicksShown() : (() => { const s = selectedRegions(); return s ? s.ids.map((id) => ({ sketch: s.sketch, id })) : []; })();
      const states = new Map<number, number>();
      list.forEach((r, i) => {
        if (picks.some((p) => p.sketch === r.sketch && p.id === r.region.id)) states.set(i, 2);
      });
      if (hit?.kind === 'region' && !states.has(hit.id)) states.set(hit.id, 1);
      renderer.setRegionStates(states);
    });

    // Sketches not being edited, as lines in the part.
    createEffect(() => {
      mesh();
      selectedFeature();
      sketchesHidden();
      const seg: number[] = [];
      const editing = session()?.featureId;
      for (const f of visibleSketches(alsoShown())) {
        if (f.id === editing) continue;
        const plane = sketchPlane(f);
        const helpers = sketchLinksOf(f.id).helpers;
        for (const e of f.sketch?.entities ?? []) {
          if (String(e.id) in helpers) continue;
          const pts = polyline(e);
          for (let i = 0; i + 1 < pts.length; i++) {
            if (!e.construction) {
              seg.push(...toWorld(plane, pts[i]), ...toWorld(plane, pts[i + 1]));
              continue;
            }
            // Dotted, as in the sketch. The line shader draws solid lines, so the dots are short pieces of line.
            const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
            const dash = renderer.camera.worldPerPixel * 4, gap = renderer.camera.worldPerPixel * 3;
            for (let t = 0; t < len; t += dash + gap) {
              const at = (d: number): V2 => [pts[i][0] + ((pts[i + 1][0] - pts[i][0]) * d) / len, pts[i][1] + ((pts[i + 1][1] - pts[i][1]) * d) / len];
              seg.push(...toWorld(plane, at(t)), ...toWorld(plane, at(Math.min(len, t + dash))));
            }
          }
        }
        // A text's letters, which are curves of the sketch the kernel sets in its font.
        for (const pts of sketchTexts(f.id)) for (let i = 0; i + 1 < pts.length; i++) seg.push(...toWorld(plane, pts[i]), ...toWorld(plane, pts[i + 1]));
      }
      renderer.setSketchLines(new Float32Array(seg));
    });

    // A revolve's axis, drawn long and on top, and the sketch line under the pointer while the axis box takes clicks.
    createEffect(() => {
      const seg: number[] = [];
      const ids: number[] = [];
      const states = new Map<number, number>();
      const sketchId = values.sketch;
      const f = activeDef()?.id === 'revolve' && typeof sketchId === 'number' ? doc.features.find((x) => x.id === sketchId) : null;
      if (f) {
        sketchRegions();
        const plane = sketchPlane(f);
        const axis = axisJson(sketchId, values.axis, values.customAxis) as { point: V2; direction: V2 } | null | undefined;
        if (axis) {
          const m = mesh();
          const reach = m && m.indices.length ? Math.hypot(m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]) : 100;
          const len = Math.hypot(axis.direction[0], axis.direction[1]) || 1;
          const d: V2 = [axis.direction[0] / len, axis.direction[1] / len];
          const at = (t: number): V2 => [axis.point[0] + d[0] * t, axis.point[1] + d[1] * t];
          seg.push(...toWorld(plane, at(-reach)), ...toWorld(plane, at(reach)));
          ids.push(0);
        }
        const hover = hoverLine();
        const line = hover !== null && pickKind() === 'axis' ? sketchLines(sketchId).find((l) => l.id === hover) : null;
        if (line && values.axis !== `line:${line.id}`) {
          seg.push(...toWorld(plane, line.start), ...toWorld(plane, line.end));
          ids.push(1);
          states.set(1, 1);
        }
      }
      renderer.setAxisLines(new Float32Array(seg), new Uint32Array(ids), states);
    });

    // Whatever the pointer rested on stops mattering once a sketch opens.
    createEffect(() => {
      if (session()) onLeave();
    });

    createEffect(() => {
      const e = session()?.editing[0]();
      if (e) queueMicrotask(() => { dimInput?.focus(); dimInput?.select(); });
    });
  });

  let drag: { button: number; x: number; y: number; px: number; py: number; moved: boolean; sketch: boolean; shift: boolean; ctrl: boolean; alt: boolean; pivot: V3; assembly?: boolean; arrow?: Arrow; grab?: number; turn?: Turn } | null = null;

  /** Whether the pointer is on the revolve arc's head. */
  const onTurn = (x: number, y: number) => {
    if (!turn) return false;
    const [ex, ey] = renderer.camera.project(turnAt(turn, turn.degrees));
    return Math.hypot(x - ex, y - ey) < 13;
  };
  /** The angle the arc's head would give, dragged to here: the nearest point round the circle, in whole degrees. */
  const turnDegrees = (t: Turn, x: number, y: number, coarse: boolean) => {
    let best = t.degrees, bestD = Infinity;
    for (let deg = 0.5; deg <= 360; deg += 0.5) {
      const [sx, sy] = renderer.camera.project(turnAt(t, deg));
      const dd = Math.hypot(sx - x, sy - y);
      if (dd < bestD) { bestD = dd; best = deg; }
    }
    const step = coarse ? 15 : 1;
    return Math.min(360, Math.max(step, Math.round(best / step) * step));
  };

  /** Whether the pointer is on the extrude arrow's head. */
  const onArrow = (x: number, y: number) => {
    if (!arrow) return false;
    const [tx, ty] = renderer.camera.project(arrowTip(arrow));
    const [fx, fy] = renderer.camera.project(arrow.from);
    const len = Math.hypot(tx - fx, ty - fy);
    // Seen end on, it can't be dragged, and it mustn't cover what's under it.
    if (len < 16) return false;
    const hx = tx + ((tx - fx) / len) * 6, hy = ty + ((ty - fy) / len) * 6;
    return Math.hypot(x - hx, y - hy) < 12;
  };
  /** The depth the arrow's head would give, dragged to here: along its line, in steps that suit the zoom. */
  const arrowDepth = (a: Arrow, x: number, y: number) => {
    const [ax, ay] = renderer.camera.project(a.from);
    const [bx, by] = renderer.camera.project(add(a.from, a.dir));
    const dx = bx - ax, dy = by - ay;
    const dd = dx * dx + dy * dy;
    // Seen end on, the arrow can't be dragged along.
    if (dd < 0.04) return null;
    const t = ((x - ax) * dx + (y - ay) * dy) / dd;
    return a.symmetric ? 2 * t : t;
  };
  const roundDepth = (raw: number, signed = false) => {
    const step = [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100].find((k) => k >= renderer.camera.worldPerPixel * 3) ?? 100;
    const r = Math.round(raw / step) * step;
    return signed ? r : Math.max(step, r);
  };
  let hoverToken = 0;
  let hoverQueued: [number, number] | null = null;

  const rel = (e: PointerEvent | MouseEvent) => {
    const b = host.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top] as [number, number];
  };

  /** The line of the revolve's sketch nearest a point on screen, within a few pixels. */
  const lineAt = (x: number, y: number): number | null => {
    const sketchId = values.sketch;
    const f = typeof sketchId === 'number' ? doc.features.find((g) => g.id === sketchId) : null;
    if (!f) return null;
    const plane = sketchPlane(f);
    let best: number | null = null;
    let bestD = 7;
    for (const l of sketchLines(sketchId)) {
      const [ax, ay] = renderer.camera.project(toWorld(plane, l.start));
      const [bx, by] = renderer.camera.project(toWorld(plane, l.end));
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
      if (d < bestD) {
        bestD = d;
        best = l.id;
      }
    }
    return best;
  };

  /** The sketches on show before the feature in the dialog, whose points and lines it can use. */
  const sketchesToPick = () => {
    const limit = pickLimit();
    return visibleSketches(alsoShown()).filter((f) => doc.features.findIndex((x) => x.id === f.id) < limit);
  };
  const screenGap = (x: number, y: number, at: V3) => {
    const [sx, sy] = renderer.camera.project(at);
    return Math.hypot(sx - x, sy - y);
  };
  const samePoint = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;

  /**
   * The point a box taking points would pick under the pointer: the origin, a point of a sketch on show, or a corner of
   * the face or edge under the pointer, whichever is nearest on screen and close enough.
   */
  const pointSpotAt = (x: number, y: number): PointSpot | null => {
    const base = pickBase();
    const sketchOnly = !!pickField()?.sketchOnly;
    const spots: PointSpot[] = [...(sketchOnly ? [] : [{ ref: 'origin', at: [0, 0, 0] as V3 }]), ...sketchPointSpots(sketchesToPick())];
    const hit = sketchOnly ? null : renderer.pick(x, y);
    if (base && hit?.kind === 'edge') {
      const e = base.edges[hit.id];
      if (e) spots.push(...corners(base.edges).filter((c) => samePoint(c.at, e.start) || samePoint(c.at, e.end)));
    } else if (base && hit?.kind === 'face') {
      const f = base.faces[hit.id];
      if (f) spots.push(...corners(base.edges).filter((c) => c.faces.includes(f.name) || c.faces.includes(f.key)));
    }
    let best: PointSpot | null = null;
    let bestGap = 12;
    for (const spot of spots) {
      const gap = screenGap(x, y, spot.at);
      if (gap < bestGap) {
        bestGap = gap;
        best = spot;
      }
    }
    return best;
  };

  /**
   * The line a box taking lines would pick under the pointer: a line of a sketch on show, a straight edge, or the axis of
   * a round edge or face.
   */
  const lineSpotAt = (x: number, y: number): { ref: unknown; line?: [V3, V3]; hit?: PickHit } | null => {
    let best: LineSpot | null = null;
    let bestGap = 7;
    for (const l of sketchLineSpots(sketchesToPick())) {
      const [ax, ay] = renderer.camera.project(l.a);
      const [bx, by] = renderer.camera.project(l.b);
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const gap = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
      if (gap < bestGap) {
        bestGap = gap;
        best = l;
      }
    }
    if (best) return { ref: best.ref, line: [best.a, best.b] };
    const base = pickBase();
    const hit = renderer.pick(x, y);
    if (!base || !hit) return null;
    if (hit.kind === 'edge') {
      const e = base.edges[hit.id];
      if (e?.curve === 'line') return { ref: e.select, hit };
      if (e && (e.curve === 'circle' || e.curve === 'ellipse')) return { ref: { axis_of: e.select }, hit };
    }
    if (hit.kind === 'face' && base.faces[hit.id]?.axis) return { ref: { axis_of: surfaceRef(base, hit.id) }, hit };
    return null;
  };

  /** A sketch curve under the pointer, for a sweep path: it stands for all of its sketch's curves. */
  const pathSpotAt = (x: number, y: number): { sketch: number; lines: [V3, V3][] } | null => {
    let best: number | null = null;
    let bestGap = 7;
    const all = new Map<number, [V3, V3][]>();
    for (const f of sketchesToPick()) {
      const segs = sketchCurveSegments(f);
      all.set(f.id, segs.map((g) => [g.a, g.b]));
      for (const g of segs) {
        const [ax, ay] = renderer.camera.project(g.a);
        const [bx, by] = renderer.camera.project(g.b);
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const gap = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
        if (gap < bestGap) {
          bestGap = gap;
          best = f.id;
        }
      }
    }
    return best === null ? null : { sketch: best, lines: all.get(best)! };
  };

  /** A plane or flat face under the pointer, as a box taking planes names it. */
  const planeRefAt = (hit: PickHit | null): unknown => {
    if (hit?.kind === 'plane') return refOfPlaneQuad(hit.id);
    const base = pickBase();
    return hit?.kind === 'face' && base && flatFace(base, hit.id) ? surfaceRef(base, hit.id) : null;
  };

  /** A drawn plane's name: Top, Front or Right, or the plane feature's. */
  const quadName = (quad: number) => (quad >= FEATURE_QUAD ? doc.features.find((f) => f.id === quad - FEATURE_QUAD)?.name ?? 'Plane' : `${PLANES[quad - 1]?.name ?? ''} plane`);

  const updateHover = () => {
    if (!hoverQueued) return;
    const [x, y] = hoverQueued;
    hoverQueued = null;
    if (pickKind() === 'axis') {
      const line = lineAt(x, y);
      setHoverLine(line);
      setHoverText(line !== null ? 'Line: click to turn around it' : '');
      return;
    }
    const kind = pickKind();
    if (activeDef() && (kind === 'point' || kind === 'points')) {
      const spot = pointSpotAt(x, y);
      setHoverRef(spot ? { point: spot.at } : null);
      setHoverHit(null);
      setHoverPlane(null);
      const w = spot ? pointWords(spot.ref) : null;
      setHoverText(w ? `${w.name}${w.size ? `  ${w.size}` : ''}` : '');
      return;
    }
    if (activeDef() && kind === 'path') {
      const spot = pathSpotAt(x, y);
      const hit = spot ? null : renderer.pick(x, y);
      const edge = hit?.kind === 'edge' ? hit : null;
      setHoverRef(spot ? { lines: spot.lines } : null);
      setHoverHit(edge);
      setHoverPlane(null);
      const base = pickBase();
      const w = spot ? pathWords({ sketch: spot.sketch }) : edge && base ? pathWords(base.edges[edge.id]?.select, base.edges) : null;
      setHoverText(w ? `${w.name}${w.size ? `  ${w.size}` : ''}` : '');
      return;
    }
    if (activeDef() && kind === 'line') {
      const spot = lineSpotAt(x, y);
      setHoverRef(spot?.line ? { line: spot.line } : null);
      setHoverHit(spot?.hit ?? null);
      setHoverPlane(null);
      const w = spot ? lineWords(spot.ref, pickBase()?.faces, pickBase()?.edges) : null;
      setHoverText(w ? `${w.name}${w.size ? `  ${w.size}` : ''}` : '');
      return;
    }
    if (hoverRef()) setHoverRef(null);
    const hit = renderer.pick(x, y);
    if (inAssembly()) asmHover(hit, x, y);
    const old = hoverHit();
    if (old?.kind === hit?.kind && old?.id === hit?.id) return;
    setHoverHit(hit);
    setHoverPlane(hit?.kind === 'plane' ? hit.id : null);
    if (inAssembly()) return;
    const token = ++hoverToken;
    const base = pickBase();
    if (!hit) setHoverText('');
    else if (hit.kind === 'plane') setHoverText(quadName(hit.id));
    else if (hit.kind === 'region') setHoverText(describeRegion(shownRegions()[hit.id]));
    else if (hit.kind === 'face') {
      if (base) setHoverText(describeFace(base.faces[hit.id]));
      else void faceList().then((l) => token === hoverToken && setHoverText(describeFace(l[hit.id])));
    } else if (base) setHoverText(describeEdge(base.edges[hit.id]));
    else void edgeList().then((l) => token === hoverToken && setHoverText(describeEdge(l[hit.id])));
  };

  const click = async (x: number, y: number, shift: boolean) => {
    const hit = renderer.pick(x, y);
    if (inAssembly()) return asmClick(hit, x, y, shift);
    // Waiting for a plane is the one time a click starts a sketch.
    if (mode() === 'pick-plane') {
      if (hit?.kind === 'plane') {
        setHoverPlane(null);
        setMode('part');
        sketchOnQuad(hit.id);
      } else if (hit?.kind === 'face') {
        const on = await sketchPlaneAt(hit.id, x, y);
        setMode('part');
        if (on) startSketch(on);
      }
      return;
    }
    if (pickKind() === 'axis') {
      const line = lineAt(x, y);
      if (line !== null) pickAxisLine(line);
      return;
    }
    if (pickKind() === 'regions') {
      const r = hit?.kind === 'region' ? shownRegions()[hit.id] : null;
      if (r) toggleRegion(r.sketch, r.region.id);
      else if (hit?.kind === 'face') togglePick(hit);
      return;
    }
    if (pickKind() === 'sections') {
      const r = hit?.kind === 'region' ? shownRegions()[hit.id] : null;
      if (r) toggleSection({ sketch: r.sketch, id: r.region.id });
      return;
    }
    const kind = pickKind();
    if (activeDef() && kind && REF_KINDS.has(kind)) {
      let ref: unknown = null;
      if (kind === 'point' || kind === 'points') ref = pointSpotAt(x, y)?.ref ?? null;
      else if (kind === 'line') ref = lineSpotAt(x, y)?.ref ?? null;
      else if (kind === 'path') {
        const spot = pathSpotAt(x, y);
        const base = pickBase();
        ref = spot ? { sketch: spot.sketch } : hit?.kind === 'edge' && base ? base.edges[hit.id]?.select ?? null : null;
      }
      else if (kind === 'edge') {
        const base = pickBase();
        ref = hit?.kind === 'edge' && base ? base.edges[hit.id]?.select ?? null : null;
      } else ref = planeRefAt(hit);
      if (ref !== null && ref !== undefined && !pickRef(ref)) setHoverText('That’s all this box takes. Remove one to pick another.');
      return;
    }
    if (activeDef()) {
      const base = pickBase();
      if (!hit || !base) return;
      // For a corner, whichever end of the edge is nearer the pointer.
      let end: 'start' | 'end' = 'start';
      if (hit.kind === 'edge' && pickKind() === 'vertex') {
        const e = base.edges[hit.id];
        if (e) {
          const [ax, ay] = renderer.camera.project(e.start);
          const [bx, by] = renderer.camera.project(e.end);
          end = Math.hypot(x - ax, y - ay) <= Math.hypot(x - bx, y - by) ? 'start' : 'end';
        }
      }
      togglePick(hit, end);
      return;
    }
    const cur = selection();
    if (!hit) {
      if (!shift) clearSelection();
      return;
    }
    if (hit.kind === 'plane') {
      clearSelection();
      if (hit.id >= FEATURE_QUAD) setSelectedFeature(hit.id - FEATURE_QUAD);
      else setSelectedGeometry(hit.id);
      return;
    }
    if (hit.kind === 'region') {
      const r = shownRegions()[hit.id];
      if (r) selectRegion(r, shift);
      return;
    }
    const list = hit.kind === 'face' ? 'faces' : 'edges';
    setSelectedGeometry(null);
    setSelectedFeature(null);
    setSelectedPart(null);
    setSelectedRegions(null);
    if (shift) {
      const has = cur[list].includes(hit.id);
      setSelection({ ...cur, [list]: has ? cur[list].filter((i) => i !== hit.id) : [...cur[list], hit.id] });
    } else {
      setSelection({ faces: list === 'faces' ? [hit.id] : [], edges: list === 'edges' ? [hit.id] : [] });
    }
  };

  /** Selects a region. Shift adds to or drops from the ones already selected, as long as they're in the same sketch. */
  const selectRegion = (r: ShownRegion, adding: boolean) => {
    const cur = selectedRegions();
    const ids = adding && cur?.sketch === r.sketch ? cur.ids : [];
    const next = ids.includes(r.region.id) ? ids.filter((id) => id !== r.region.id) : [...ids, r.region.id];
    clearSelection();
    setSelectedRegions(next.length ? { sketch: r.sketch, ids: next } : null);
  };

  /** A sketch plane on a face: the face itself if it's flat, or the plane touching it under the cursor if it's curved. */
  const sketchPlaneAt = async (face: number, x: number, y: number): Promise<Plane | null> => {
    const f = (await faceList())[face];
    if (f?.surface === 'plane') return planeOnFace(f.center, f.normal);
    const under = surfaceHit(mesh(), renderer, x, y);
    return under ? planeOnFace(under.point, under.normal) : null;
  };

  /** Starts a sketch on a drawn plane. On a plane feature it's put on the plane itself, so it follows it. */
  const sketchOnQuad = (quad: number) => {
    if (quad < FEATURE_QUAD) return startSketch(PLANES[quad - 1].plane);
    const frame = planeFrame(quad - FEATURE_QUAD);
    if (frame) startSketch(frame, { on_plane: quad - FEATURE_QUAD });
  };

  /** "Edit Extrude 1", for the feature a face or edge was made by, as Onshape's menu offers it. */
  const madeByItems = (name: string | undefined): (MenuItem | null)[] => {
    const id = Number(/^f(\d+):/.exec(name ?? '')?.[1] ?? NaN);
    const f = doc.features.find((x) => x.id === id);
    return f ? [{ label: `Edit ${f.name}`, run: () => editFeature(id) }, null] : [];
  };
  /** What can be done to the part something is on: its flat pattern if it's sheet metal, and hiding it or the rest. */
  const partItems = (i: number): (MenuItem | null)[] => {
    const m = mesh();
    const part = i >= 0 ? m?.parts[i] : undefined;
    if (!m || !part) return [null];
    const sheet = sheetParts().some((x) => x.body === part.name);
    return [
      null,
      ...(sheet ? [{ label: 'Show flat pattern', run: () => { setFlatBody(part.name); setFlatOpen(true); } }] : []),
      { label: 'Edit appearance…', run: () => { clearSelection(); setAppearanceFor(part.name); } },
      { label: 'Hide part', run: () => setHiddenParts(new Set([...hiddenParts(), i])) },
      { label: 'Hide other parts', disabled: m.parts.length < 2, run: () => setHiddenParts(new Set(m.parts.map((_, k) => k).filter((k) => k !== i))) },
      null,
    ];
  };

  const openContext = async (x: number, y: number, cx: number, cy: number) => {
    const m = mesh();
    const fit = { label: 'Fit to window', keys: 'F', run: fitView };
    const iso = { label: 'Isometric view', keys: '0', run: () => setView('iso') };
    const s = session();
    if (s) {
      setContext({
        x: cx,
        y: cy,
        items: [
          { label: 'Normal to sketch plane', keys: 'N', command: 'view.normal', run: looksAtSketch },
          fit,
          null,
          { label: 'Finish sketch', keys: 'Ctrl Enter', run: finishSketch },
          { label: 'Discard sketch', run: cancelSketch },
        ],
      });
      return;
    }
    if (activeDef()) return;
    const hit = renderer.pick(x, y);
    if (inAssembly()) return setContext({ x: cx, y: cy, items: asmMenu(hit, fit, iso) });
    if (hit?.kind === 'region') {
      const r = shownRegions()[hit.id];
      if (!r) return;
      // Right-clicking something already selected keeps the rest of the selection, as anywhere.
      if (selectedRegions()?.sketch !== r.sketch || !selectedRegions()?.ids.includes(r.region.id)) selectRegion(r, false);
      setContext({
        x: cx,
        y: cy,
        items: [
          { label: 'Extrude', keys: 'Shift E', command: 'menu.extrude', run: () => startFeature('extrude') },
          { label: 'Edit sketch', run: () => editSketch(r.sketch) },
          null,
          { label: 'New sketch', keys: 'Shift S', command: 'menu.sketch', run: () => startSketch(r.plane) },
          { label: 'Normal to sketch plane', keys: 'N', run: () => normalTo(r.plane) },
          fit,
        ],
      });
    } else if (hit?.kind === 'plane' && hit.id >= FEATURE_QUAD) {
      const id = hit.id - FEATURE_QUAD;
      const frame = planeFrame(id);
      clearSelection();
      setSelectedFeature(id);
      setContext({
        x: cx,
        y: cy,
        items: [
          { label: 'New sketch', keys: 'Shift S', command: 'menu.sketch', disabled: !frame, run: () => sketchOnQuad(hit.id) },
          { label: 'Normal to plane', keys: 'N', disabled: !frame, run: () => normalTo(frame!) },
          { label: 'Edit plane', run: () => editFeature(id) },
          null,
          { label: 'Hide plane', run: () => setPlanesHidden([id], true) },
          fit,
        ],
      });
    } else if (hit?.kind === 'plane') {
      const p = PLANES[hit.id - 1];
      clearSelection();
      setSelectedGeometry(hit.id);
      setContext({
        x: cx,
        y: cy,
        items: [
          { label: 'New sketch', keys: 'Shift S', command: 'menu.sketch', run: () => startSketch(p.plane) },
          { label: 'Normal to plane', keys: 'N', run: () => normalTo(p.plane) },
          { label: 'Plane from this', run: () => startFeature('plane') },
          null,
          { label: 'Hide plane', run: () => toggleGeometry(p.id) },
          fit,
        ],
      });
    } else if (hit?.kind === 'face') {
      const plane = await sketchPlaneAt(hit.id, x, y);
      const face = (await faceList())[hit.id];
      const flat = face?.surface === 'plane';
      setSelectedGeometry(null);
      setSelection({ faces: [hit.id], edges: [] });
      setContext({
        x: cx,
        y: cy,
        items: [
          ...madeByItems(face?.name),
          { label: flat ? 'New sketch' : 'New sketch, touching here', keys: flat ? 'Shift S' : undefined, command: 'menu.sketch', disabled: !plane, run: () => startSketch(plane!) },
          { label: flat ? 'Normal to face' : 'Normal to surface here', keys: flat ? 'N' : undefined, disabled: !plane, run: () => normalTo(plane!) },
          ...(flat && face ? [
            { label: 'Plane from this face', run: () => startFeature('plane') },
            { label: 'Section view here', run: () => setSection({ by: 'face', point: face.center, normal: normalize(face.normal), offset: 0, flip: false, faceName: face.name }) },
          ] : []),
          null,
          { label: 'Extrude', keys: 'Shift E', disabled: !flat, run: () => startFeature('extrude') },
          { label: 'Shell', run: () => startFeature('shell') },
          ...partItems(m?.parts.findIndex((p) => p.faces.includes(hit.id)) ?? -1),
          fit,
        ],
      });
    } else if (hit?.kind === 'edge') {
      setSelectedGeometry(null);
      setSelection({ faces: [], edges: [hit.id] });
      const edge = (await edgeList())[hit.id];
      const part = m?.parts.findIndex((p) => p.edges.includes(hit.id)) ?? -1;
      const sheet = part >= 0 && sheetParts().some((x) => x.body === m!.parts[part].name);
      setContext({
        x: cx,
        y: cy,
        items: [
          ...madeByItems(edge?.name.split('|')[0]),
          ...(sheet ? [{ label: 'Flange', run: () => startFeature('flange') }] : []),
          { label: 'Fillet', keys: 'G', run: () => startFeature('fillet') },
          { label: 'Chamfer', run: () => startFeature('chamfer') },
          ...partItems(part),
          fit,
        ],
      });
    } else {
      setContext({ x: cx, y: cy, items: [fit, iso, null, { label: 'Show or hide planes', keys: 'P', run: togglePlanes }] });
    }
  };

  const onDown = (e: PointerEvent) => {
    if (glProblem() || session()?.editing[0]()) return;
    host.setPointerCapture(e.pointerId);
    const [x, y] = rel(e);
    const s = session();
    const sketch = !!s && e.button === 0;
    drag = { button: e.button, x, y, px: x, py: y, moved: false, sketch, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, pivot: e.button === 2 ? rotationPivot(mesh(), renderer, x, y) : renderer.camera.target };
    if (!s && e.button === 0 && turn && onTurn(x, y)) drag.turn = { ...turn };
    else if (!s && e.button === 0 && arrow && onArrow(x, y)) {
      // Where on the head it was grabbed stays under the pointer.
      drag.arrow = { ...arrow };
      drag.grab = (arrowDepth(arrow, x, y) ?? arrow.depth) - arrow.depth;
    }
    if (sketch) s!.pointerDown(x, y, e.shiftKey);
    if (inAssembly() && e.button === 0) drag.assembly = asmDown(renderer, x, y, e.shiftKey);
    e.preventDefault();
  };

  const onMove = (e: PointerEvent) => {
    if (glProblem()) return;
    const [x, y] = rel(e);
    const s = session();
    if (drag) {
      if (Math.hypot(x - drag.x, y - drag.y) > 3) drag.moved = true;
      const dx = x - drag.px, dy = y - drag.py;
      drag.px = x;
      drag.py = y;
      if (drag.assembly) return asmMove(x, y);
      if (drag.turn) {
        const deg = String(turnDegrees(drag.turn, x, y, e.shiftKey));
        if (deg !== String(values.degrees)) setValue('degrees', deg);
        return;
      }
      if (drag.arrow) {
        const raw = arrowDepth(drag.arrow, x, y);
        const text = raw === null ? null : String(Number(roundDepth(raw - (drag.grab ?? 0), drag.arrow.signed).toFixed(4)));
        if (text !== null && text !== String(values[drag.arrow.key])) setValue(drag.arrow.key, text);
        return;
      }
      if (drag.sketch) {
        s?.pointerMove(x, y, e.shiftKey);
        return;
      }
      if (!drag.moved) return;
      // Left selects, so its drag draws a box. Right drag rotates. Middle drag pans, and so does Ctrl with right.
      if (drag.button === 0) {
        if (mode() !== 'pick-plane') setBox({ x: Math.min(drag.x, x), y: Math.min(drag.y, y), w: Math.abs(x - drag.x), h: Math.abs(y - drag.y) });
        return;
      }
      if (drag.button === 1 || drag.ctrl) renderer.camera.pan(dx, dy);
      else renderer.camera.orbit(dx, dy, drag.pivot, drag.alt);
      renderer.invalidate();
      return;
    }
    if (s) {
      s.pointerMove(x, y, e.shiftKey);
      const tool = s.tool[0]();
      setCursor(tool === 'select' ? (s.hover ? 'pointer' : '') : 'crosshair');
      return;
    }
    const hot = onArrow(x, y);
    const turning = !hot && onTurn(x, y);
    if (hot !== arrowHot || turning !== turnHot) {
      arrowHot = hot;
      turnHot = turning;
      renderer.invalidate();
    }
    setCursor(hot || turning ? 'grab' : '');
    noteAsmShift(e.shiftKey);
    const fresh = hoverQueued === null;
    hoverQueued = [x, y];
    if (fresh) requestAnimationFrame(updateHover);
  };

  const onUp = (e: PointerEvent) => {
    if (!drag) return;
    const [x, y] = rel(e);
    const d = drag;
    drag = null;
    // A press on a handle that didn't drag is an ordinary click.
    if ((d.arrow || d.turn) && d.moved) return;
    if (d.assembly) asmUp(x, y, d.shift, renderer.pick(x, y));
    else if (d.sketch) session()?.pointerUp(x, y);
    else if (d.button === 2 && !d.moved) void openContext(x, y, e.clientX, e.clientY);
    else if (d.button === 0 && !session()) {
      const b = box();
      setBox(null);
      if (b) selectInBox(b, d.shift);
      else if (!d.moved) void click(x, y, d.shift);
    }
  };

  /** The regions whose whole outline is inside a screen rectangle. */
  const regionsInBox = (b: { x: number; y: number; w: number; h: number }) =>
    shownRegions().filter((r) => r.region.loops[0].every((p) => {
      const [sx, sy] = renderer.camera.project(toWorld(r.plane, p));
      return sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h;
    }));

  const selectInBox = (b: { x: number; y: number; w: number; h: number }, adding: boolean) => {
    if (inAssembly()) return asmBox(withinBox(mesh(), renderer, b), adding);
    const inside = regionsInBox(b);
    if (pickKind() === 'regions') {
      addRegions(inside.map((r) => ({ sketch: r.sketch, id: r.region.id })));
      const base = pickBase();
      const found = base ? withinBox(base.mesh, renderer, b) : null;
      if (found) addPicks(found);
      return;
    }
    // A loft's profiles go in the order they're clicked, which a box doesn't have.
    if (pickKind() === 'axis' || pickKind() === 'sections' || REF_KINDS.has(pickKind()!)) return;
    const base = pickBase();
    if (!base) {
      const cur = selectedRegions();
      const sketch = cur && adding && inside.some((r) => r.sketch === cur.sketch) ? cur.sketch : inside[0]?.sketch;
      const ids = inside.filter((r) => r.sketch === sketch).map((r) => r.region.id);
      const kept = adding && cur?.sketch === sketch ? cur!.ids : [];
      setSelectedRegions(ids.length ? { sketch: sketch!, ids: [...new Set([...kept, ...ids])] } : adding ? cur : null);
    }
    const found = withinBox(base ? base.mesh : mesh(), renderer, b);
    if (!found) return;
    if (base) return addPicks(found);
    const cur = selection();
    setSelection(adding ? { faces: [...new Set([...cur.faces, ...found.faces])], edges: [...new Set([...cur.edges, ...found.edges])] } : found);
  };

  const onLeave = () => {
    hoverQueued = null;
    hoverToken++;
    setHoverHit(null);
    setHoverLine(null);
    setHoverText('');
    setHoverPlane(null);
    setHoverRef(null);
  };

  const editing = () => session()?.editing[0]();

  return (
    <div class="viewport" ref={host} style={{ cursor: cursor() }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onLeave} onContextMenu={(e) => e.preventDefault()} data-testid="viewport">
      <canvas ref={glCanvas} class="layer" />
      <canvas ref={overlay} class="layer overlay" />
      <Show when={!glProblem()}><ViewCube onEnter={onLeave} /></Show>
      <Show when={editing()}>
        {(ed) => (
          <input
            ref={dimInput}
            class="dim-input"
            style={{ left: `${ed().x}px`, top: `${ed().y}px` }}
            value={ed().text}
            data-testid="dim-input"
            aria-label="Dimension value"
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') session()?.setDimension(ed().id, e.currentTarget.value);
              if (e.key === 'Escape') session()?.editing[1](null);
            }}
          />
        )}
      </Show>
      <Show when={session()?.textEditing[0]()}>
        {(ed) => {
          // Read once: Enter closes the box, and its blur comes after, when there's no longer one to read.
          const id = ed().id;
          return (
          <textarea
            ref={(el) => queueMicrotask(() => { el.focus(); el.select(); })}
            class="dim-input text-input"
            rows={Math.max(1, ed().text.split('\n').length)}
            style={{ left: `${ed().x}px`, top: `${ed().y}px` }}
            value={ed().text}
            data-testid="text-input"
            aria-label="Text"
            spellcheck={false}
            onPointerDown={(e) => e.stopPropagation()}
            onInput={(e) => { e.currentTarget.rows = Math.max(1, e.currentTarget.value.split('\n').length); }}
            onKeyDown={(e) => {
              e.stopPropagation();
              // Enter sets it, and Shift Enter starts a new line, as the kernel lays lines out a line's spacing apart.
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); session()?.setText(id, e.currentTarget.value); }
              if (e.key === 'Escape') session()?.textEditing[1](null);
            }}
            onBlur={(e) => { if (session()?.textEditing[0]()?.id === id) session()?.setText(id, e.currentTarget.value); }}
          />
          );
        }}
      </Show>
      <Show when={mode() === 'pick-plane'}>
        <div class="banner" onPointerDown={(e) => e.stopPropagation()}>Pick a plane or a flat face to sketch on<button class="link" onClick={() => setMode('part')}>Cancel</button></div>
      </Show>
      <Show when={context()}>{(c) => <ContextMenu {...c()} close={() => setContext(null)} />}</Show>
      <Show when={box()}>{(b) => <div class="select-box" data-testid="select-box" style={{ left: `${b().x}px`, top: `${b().y}px`, width: `${b().w}px`, height: `${b().h}px` }} />}</Show>
      <Show when={glProblem()}>{(p) => <GlNotice problem={p()} />}</Show>
    </div>
  );
}
