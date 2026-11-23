import { createSignal } from 'solid-js';
import { sameRegions, sketchLines, wholeSketch, type RegionPick } from '../sketch/regions';
import { doc, isHidden, numberOr, sketchRegions } from '../store/doc';
import { planeFromNumbers, sketchPlane } from '../store/planes';
import { sheetParts } from '../store/sheetmetal';
import type { FaceInfo } from '../store/doc';

export type FieldKind =
  | 'expr' | 'segment' | 'tabs' | 'check' | 'group' | 'select' | 'sketch' | 'sketches' | 'steps'
  | 'edges' | 'faces' | 'face' | 'part' | 'parts' | 'vertex' | 'regions' | 'sections' | 'axis' | 'features'
  | 'plane' | 'planes' | 'point' | 'points' | 'line' | 'edge' | 'path';
/** Fields filled by clicking in the view. One at a time takes the clicks, as in Onshape. */
export const PICK_KINDS = new Set<FieldKind>(['edges', 'faces', 'face', 'part', 'parts', 'vertex', 'regions', 'sections', 'axis', 'features', 'plane', 'planes', 'point', 'points', 'line', 'edge', 'path']);
/**
 * References the way the kernel names them wherever a feature takes one: a plane (Top, Front, Right, a plane feature or a
 * flat face), a point (the origin, a part's corner or a sketch's point), a line (a straight edge, a sketch's line or the
 * axis of something round), or one edge.
 */
export const REF_KINDS = new Set<FieldKind>(['plane', 'planes', 'point', 'points', 'line', 'edge', 'path']);
/** Fields holding one thing rather than a list. */
export const SINGLE_KINDS = new Set<FieldKind>(['face', 'part', 'vertex', 'plane', 'point', 'line', 'edge']);
export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  unit?: string;
  options?: { value: string; label: string; disabled?: (v: Values) => boolean }[];
  hint?: string;
  /** Only shown when this says so. */
  when?: (v: Values) => boolean;
  /** Greyed out when this says so. */
  disabled?: (v: Values) => boolean;
  /** Positive numbers only, when dragged. */
  scrub?: number;
  /** For an expr or a select: the value a flip button beside it turns on and off, and when that button is off limits. */
  flip?: { key: string; label: string; disabled?: (v: Values) => boolean };
  /** For a group: what's inside it. */
  fields?: FieldDef[];
  /** For a group: it has a checkbox, setting its key, that turns its contents on. */
  checkable?: boolean;
  /** Takes the dialog's whole width, with its label only for screen readers, as Onshape's Result row does. */
  bare?: boolean;
  /** For regions: a part's flat faces can go in too, as extrude takes them. */
  takesFaces?: boolean;
  /** For a face: a plane can stand in for one, as Up to face takes them. */
  takesPlanes?: boolean;
  /** For a list of points or planes: how many it takes. */
  max?: number;
  /** For a face: only its surface matters, a plane or an axis, so a name covering several pieces of it will do. */
  surface?: boolean;
  /** For points: only a sketch's points, not the origin or a part's corners. */
  sketchOnly?: boolean;
}
export type Values = Record<string, any>;

export interface FeatureDef {
  id: string;
  title: string;
  icon: string;
  namePrefix: string;
  fields: FieldDef[];
  defaults(): Values;
  /** The feature's JSON, or null if it isn't complete yet. */
  make(v: Values): any | null;
  read(f: any): Values;
  /** What's still needed before it can be added, if anything. */
  missing?(v: Values): string | null;
  /** Needs a solid before it, to pick from or to act on. */
  needsBody?: boolean;
  /** Writes all of its feature's app data, so an edit that leaves it out means there's none left. */
  ownsApp?: boolean;
  /** Looks at the model before it, as a tab finds the wall its sketch is on, though nothing is picked from it. */
  needsModel?: boolean;
  /** The box that takes clicks first, though it starts filled, as a hole's points do. */
  startPick?: string;
}

/** Whether there's a solid before this feature for it to act on. Set when the dialog opens, so nothing moves as the preview makes one. */
export const [hasBase, setHasBase] = createSignal(true);
const needsBase = () => !hasBase();

const surface = (v: Values) => v.body === 'surface';
const MODE: FieldDef = {
  key: 'mode',
  label: 'Result',
  kind: 'segment',
  bare: true,
  when: (v) => !surface(v),
  options: [
    { value: 'new_body', label: 'New' },
    { value: 'add', label: 'Add', disabled: needsBase },
    { value: 'remove', label: 'Remove', disabled: needsBase },
    { value: 'intersect', label: 'Intersect', disabled: needsBase },
  ],
};
/** Onshape's Solid and Surface. A surface is a sheet of its own, with no inside, so it has no Result. */
const CREATION: FieldDef = {
  key: 'body',
  label: 'Creation type',
  kind: 'tabs',
  options: [{ value: 'solid', label: 'Solid' }, { value: 'surface', label: 'Surface' }],
};
/**
 * Onshape's merge scope: which parts an Add, Remove or Intersect acts on. It's all of them until "… with all" is turned
 * off, and then the parts picked in the view. The words follow the Result, so a cut says what it cuts.
 */
const SCOPE_WORDS: Record<string, [string, string, string]> = {
  add: ['Merge with all', 'Parts to merge with', 'Click the parts to merge with'],
  remove: ['Remove from all', 'Parts to remove from', 'Click the parts to remove from'],
  intersect: ['Intersect with all', 'Parts to intersect with', 'Click the parts to intersect with'],
};
const scoped = (v: Values) => !surface(v) && v.mode in SCOPE_WORDS;
/** Only the picked parts, rather than all of them. */
const someParts = (v: Values) => scoped(v) && !v.mergeAll;
const SCOPE: FieldDef[] = Object.entries(SCOPE_WORDS).flatMap(([mode, [all, some]]): FieldDef[] => [
  { key: 'mergeAll', label: all, kind: 'check', when: (v) => !surface(v) && v.mode === mode },
  { key: 'scope', label: some, kind: 'parts', when: (v) => !surface(v) && v.mode === mode && !v.mergeAll },
]);
const readScope = (f: any): Values => (Array.isArray(f.bodies) && f.bodies.length && f.mode !== 'new_body' && f.mode !== 'surface' ? { mergeAll: false, scope: [...f.bodies] } : { mergeAll: true, scope: [] });

/**
 * Gives a feature with a Result its merge scope, at the bottom of its dialog as in Onshape. The kernel reads no `bodies`,
 * and an empty list, as all of them, so with none picked yet the preview shows the shape as a part of its own, and it
 * waits for a pick before it can be added.
 */
function withScope(def: FeatureDef): FeatureDef {
  return {
    ...def,
    fields: [...def.fields, ...SCOPE],
    defaults: () => ({ ...def.defaults(), mergeAll: true, scope: [] }),
    read: (f) => ({ ...def.read(f), ...readScope(f) }),
    missing: (v) => def.missing?.(v) ?? (someParts(v) && !v.scope?.length ? SCOPE_WORDS[v.mode][2] : null),
    make(v) {
      const json = def.make(v);
      if (!json) return null;
      delete json.bodies;
      if (!someParts(v)) return json;
      return v.scope?.length ? { ...json, bodies: [...v.scope] } : { ...json, mode: 'new_body' };
    },
  };
}

const modeOf = (v: Values) => (surface(v) ? 'surface' : v.mode);
const readMode = (f: any): Values => (f.mode === 'surface' ? { body: 'surface', mode: 'new_body' } : { body: 'solid', mode: f.mode ?? 'add' });

const num = numberOr;
const str = (v: unknown) => String(v ?? '');
const POSITION: FieldDef[] = [
  { key: 'x', label: 'X', kind: 'expr', unit: 'mm', scrub: 1 },
  { key: 'y', label: 'Y', kind: 'expr', unit: 'mm', scrub: 1 },
  { key: 'z', label: 'Z', kind: 'expr', unit: 'mm', scrub: 1 },
];

function solidDef(shape: string, title: string, dims: FieldDef[], defaults: Values): FeatureDef {
  return {
    id: shape,
    title,
    icon: shape,
    namePrefix: title,
    fields: [MODE, ...dims, ...POSITION],
    defaults: () => ({ ...defaults, x: '0', y: '0', z: '0', mode: 'add' }),
    make(v) {
      const out: any = { type: 'solid', shape, mode: v.mode };
      for (const d of dims) out[d.key] = num(v[d.key]);
      const at = [num(v.x), num(v.y), num(v.z)];
      if (at.some((c) => c !== 0)) out.at = { origin: at };
      return out;
    },
    read(f) {
      const v: Values = { mode: f.mode ?? 'add', x: str(f.at?.origin?.[0] ?? 0), y: str(f.at?.origin?.[1] ?? 0), z: str(f.at?.origin?.[2] ?? 0) };
      for (const d of dims) v[d.key] = str(f[d.key]);
      return v;
    },
  };
}

const dim = (key: string, label: string): FieldDef => ({ key, label, kind: 'expr', unit: 'mm', scrub: 0.5 });
const angle = (key: string, label: string): FieldDef => ({ key, label, kind: 'expr', unit: '°', scrub: 1 });

/** The last sketch, or with `closed`, the last that has a closed region. */
export const lastSketchId = (closed = false) => {
  for (let i = doc.features.length - 1; i >= 0; i--) {
    const f = doc.features[i];
    if (closed && !sketchRegions().get(f.id)?.length) continue;
    if ((f.type === 'constrained_sketch' || f.type === 'sketch') && !isHidden(f) && !f.suppressed) return f.id as number;
  }
  return null;
};

/** A sweep path picked in the view: one sketch's curves, or a part's edges, never both. */
export const isSketchPath = (x: unknown): x is { sketch: number } => !!x && typeof x === 'object' && typeof (x as any).sketch === 'number' && Object.keys(x).length === 1;
function pathJson(picked: unknown[]) {
  const sketch = picked.find(isSketchPath);
  return sketch ? { sketch: sketch.sketch } : { edges: edgeField(picked) };
}
function readPath(path: any): Values {
  if (Array.isArray(path)) return { pathBy: 'steps', pathPick: [], path: path.map(readStep) };
  const pathPick = path && typeof path.sketch === 'number' ? [{ sketch: path.sketch }] : path?.edges ? edgeList(path.edges) : [];
  return { pathBy: 'curves', pathPick, path: [newStep('line'), newStep('bend')] };
}

type AxisName = 'x' | 'y' | 'z';
const AXES: Record<AxisName, [number, number, number]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const axisName = (v?: number[]): AxisName => (!v ? 'z' : Math.abs(v[0]) > 0.5 ? 'x' : Math.abs(v[1]) > 0.5 ? 'y' : 'z');
const AXIS_FIELD = (key: string, label: string): FieldDef => ({ key, label, kind: 'segment', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }] });
const point = (v: Values, keys: [string, string, string]) => keys.map((k) => num(v[k]));
/** Three numbers or expressions, rather than something named. */
const isVector = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' || typeof c === 'string');
const isOrigin = (p: unknown[]) => p.every((c) => c === 0);

const picks = (v: Values) => (v.regions ?? []) as RegionPick[];
/** A part's flat faces, picked in the same box as regions, as Onshape's Extrude takes them. */
const pickedFaces = (v: Values) => (v.faces ?? []) as string[];
/**
 * Whether something is picked: regions, faces, or a sketch with no regions on record, which stays chosen for the kernel
 * to say why it can't build.
 */
export const regionsChosen = (v: Values) =>
  picks(v).length > 0 || pickedFaces(v).length > 0 || (v.sketch !== null && v.sketch !== undefined && !sketchRegions().get(Number(v.sketch))?.length);

/**
 * The sketch and regions an extrude takes. All of one sketch is just that sketch, so it keeps up as regions come and go.
 * Anything else lists them: plainly for the first sketch, and with their sketch for the others.
 */
function regionsJson(v: Values): { sketch?: number; regions?: unknown[] } {
  const list = picks(v);
  // Faces alone need no sketch at all.
  if (!list.length) return v.sketch === null || v.sketch === undefined || pickedFaces(v).length ? {} : { sketch: Number(v.sketch) };
  const first = list[0].sketch;
  if (list.every((p) => p.sketch === first) && sameRegions(list.map((p) => p.id), wholeSketch(sketchRegions().get(first)))) return { sketch: first };
  return { sketch: first, regions: list.map((p) => (p.sketch === first ? p.id : { sketch: p.sketch, region: p.id })) };
}

/** What an extrude takes, as the dialog picks it. Regions that have gone from their sketch are left for picking again. */
function readRegions(f: any): { sketch: number | null; regions: RegionPick[]; faces: string[] } {
  const faces = Array.isArray(f.faces) ? [...f.faces] : [];
  if (f.sketch === undefined) return { sketch: null, regions: [], faces };
  return { ...readSketchRegions(f), faces };
}

function readSketchRegions(f: any): { sketch: number; regions: RegionPick[] } {
  const there = (p: RegionPick) => (sketchRegions().get(p.sketch) ?? []).some((r) => r.id === p.id);
  if (Array.isArray(f.regions) && f.regions.length) {
    const list = f.regions.map((r: any): RegionPick => (typeof r === 'string' ? { sketch: f.sketch, id: r } : { sketch: r.sketch, id: r.region }));
    return { sketch: f.sketch ?? list[0].sketch, regions: list.filter(there) };
  }
  return { sketch: f.sketch, regions: wholeSketch(sketchRegions().get(f.sketch)).map((id) => ({ sketch: f.sketch, id })) };
}

type Amount = number | string;
const neg = (v: Amount): Amount => (typeof v === 'number' ? (v === 0 ? 0 : -v) : `-(${v})`);
const half = (v: Amount): Amount => (typeof v === 'number' ? v / 2 : `(${v}) / 2`);
const plus = (a: Amount, b: Amount): Amount => {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (b === 0) return a;
  if (a === 0) return b;
  return `(${a}) + (${b})`;
};
const minus = (a: Amount, b: Amount): Amount => (a === 0 ? neg(b) : b === 0 ? a : typeof a === 'number' && typeof b === 'number' ? a - b : `(${a}) - (${b})`);

/**
 * Where a blind extrude's options put it along the sketch's normal, as a start and a length: the depth runs from the
 * starting offset, the flip reverses it, the second end reaches back the other way, and symmetric centres the depth on
 * the start. This is how flipped extrudes have always been written, so their end faces keep their names.
 */
function extent(v: Values): { start: Amount; length: Amount } {
  const depth = num(v.length);
  const offset = v.offsetOn ? num(v.offset) : 0;
  if (v.symmetric) return { start: minus(offset, half(depth)), length: depth };
  const second = v.secondOn ? num(v.second) : 0;
  const length = plus(depth, second);
  return { start: v.flip ? neg(plus(offset, depth)) : minus(offset, second), length };
}

/** Two amounts as the kernel might hand them back, which can tidy up brackets and fold constants. */
const bare = (v: unknown) => String(v ?? '').replace(/[\s()]/g, '');

const EXTRUDE_OPTIONS = { flip: false, symmetric: false, offsetOn: false, offset: '5', secondOn: false, second: '10', end: 'blind', endFace: null, endPart: null, endVertex: null, keepOpposite: false };
const END_TYPES = [
  { value: 'blind', label: 'Blind' },
  { value: 'up_to_next', label: 'Up to next' },
  { value: 'up_to_face', label: 'Up to face' },
  { value: 'up_to_part', label: 'Up to part' },
  { value: 'up_to_vertex', label: 'Up to vertex' },
  { value: 'through_all', label: 'Through all' },
];
const endType = (v: Values) => (surface(v) ? 'blind' : v.end ?? 'blind');
const blind = (v: Values) => endType(v) === 'blind';

/** Where an extrude stops when it isn't blind, or null while what it stops at isn't picked yet. */
function endJson(v: Values): unknown | null {
  switch (endType(v)) {
    case 'up_to_face': return v.endFace ? { type: 'up_to_face', face: v.endFace } : null;
    case 'up_to_part': return v.endPart ? { type: 'up_to_part', part: v.endPart } : null;
    case 'up_to_vertex': return v.endVertex ? { type: 'up_to_vertex', vertex: v.endVertex } : null;
    default: return endType(v);
  }
}

/**
 * What the dialog showed for an extrude. Its own record is used only if it still describes the feature, since a file or
 * an AI can change a feature without knowing about it. Otherwise this works it out, and anything it can't name becomes
 * a starting offset, so opening a feature never changes its shape.
 */
function readExtent(f: any): Values {
  const base = { ...EXTRUDE_OPTIONS, length: str(f.length) };
  const start = f.start ?? 0;
  const end = typeof f.end === 'string' ? f.end : f.end?.type ?? 'blind';
  if (end !== 'blind' || f.opposite) {
    const ends = { end, endFace: f.end?.face ?? null, endPart: f.end?.part ?? null, endVertex: f.end?.vertex ?? null };
    return { ...base, ...ends, flip: !!f.opposite, keepOpposite: end === 'blind', offsetOn: start !== 0, offset: start !== 0 ? str(start) : base.offset };
  }
  const said = f.app?.dialog;
  if (said) {
    const v = { ...base, ...said };
    const e = extent(v);
    if (bare(e.start) === bare(start) && bare(e.length) === bare(f.length)) return v;
  }
  if (start === 0) return base;
  if (typeof start === 'number' && typeof f.length === 'number') {
    if (Math.abs(start + f.length) < 1e-9) return { ...base, flip: true };
    if (Math.abs(start * 2 + f.length) < 1e-9) return { ...base, symmetric: true };
  } else {
    const s = bare(start), l = bare(f.length);
    if (s === `-${l}`) return { ...base, flip: true };
    if (s === `-${l}/2`) return { ...base, symmetric: true };
  }
  return { ...base, offsetOn: true, offset: str(start) };
}

const edgeList = (edges: any): any[] => (edges && typeof edges === 'object' && Array.isArray(edges.any) ? edges.any : edges ? [edges] : []);
const edgeField = (edges: any[]) => (edges.length === 1 ? edges[0] : { any: edges });

/** A revolve's axis: the sketch's own axes, the old way round its normal, or one of its lines, which it then follows. */
export const AXIS_CHOICES = { y: 'y_axis', x: 'x_axis', normal: 'normal' } as const;
export function axisJson(sketchId: number, choice: string, custom?: unknown): unknown | null | undefined {
  if (choice === 'y_axis') return { point: [0, 0], direction: [0, 1] };
  if (choice === 'x_axis') return { point: [0, 0], direction: [1, 0] };
  if (choice === 'normal') return undefined;
  if (choice === 'custom') return custom ?? null;
  const m = /^line:(\d+)$/.exec(choice);
  const line = m ? sketchLines(sketchId).find((l) => l.id === Number(m[1])) : null;
  if (!line) return null;
  return { point: line.start, direction: [line.end[0] - line.start[0], line.end[1] - line.start[1]] };
}

/** Whether two axes are one line, which needs the same direction either way and a point of one on the other. */
function sameAxis(a: any, b: any) {
  if (!a || !b) return false;
  const [ax, ay] = a.direction, [bx, by] = b.direction;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < 1e-12 || lb < 1e-12) return false;
  if (Math.abs(ax * by - ay * bx) / (la * lb) > 1e-9) return false;
  const dx = b.point[0] - a.point[0], dy = b.point[1] - a.point[1];
  return Math.abs(dx * ay - dy * ax) / la < 1e-6;
}

function readAxis(f: any): { axis: string; customAxis?: unknown } {
  if (!f.axis) return { axis: 'normal' };
  const said = f.app?.axis;
  if (typeof said === 'string' && /^line:\d+$/.test(said) && axisJson(f.sketch, said) !== null) return { axis: said };
  for (const choice of ['y_axis', 'x_axis']) if (sameAxis(f.axis, axisJson(f.sketch, choice))) return { axis: choice };
  const line = sketchLines(f.sketch).find((l) => sameAxis(f.axis, axisJson(f.sketch, `line:${l.id}`)));
  return line ? { axis: `line:${line.id}` } : { axis: 'custom', customAxis: f.axis };
}

/** One profile of a loft: a whole sketch holding one outline, or one region of a sketch. */
export interface Section { sketch: number; id?: string }
/** A region that's all of its sketch is written as the sketch, as lofts always were. */
const sectionJson = (s: Section) => (!s.id || sameRegions([s.id], wholeSketch(sketchRegions().get(s.sketch))) ? s.sketch : { sketch: s.sketch, region: s.id });
const readSection = (s: any): Section => (typeof s === 'number' ? { sketch: s } : { sketch: s.sketch, id: s.region });

/** How a loft leaves its first profile or comes into its last, as Onshape's end conditions: free, square to it, or round over a point. */
const loftEnds = (point: 'startPoint' | 'endPoint') => [
  { value: 'free', label: 'Free' },
  { value: 'normal', label: 'Normal', disabled: (v: Values) => !!v[point] },
  { value: 'round', label: 'Round', disabled: (v: Values) => !v[point] },
];

/** One step of a sweep's path, as the dialog edits it. */
export interface PathStep { kind: 'line' | 'bend'; length: string; radius: string; degrees: string; toward: string }
export const newStep = (kind: PathStep['kind']): PathStep => ({ kind, length: '30', radius: '20', degrees: '90', toward: '0' });
const stepJson = (s: PathStep) => (s.kind === 'line' ? { line: num(s.length) } : { arc_radius: num(s.radius), degrees: num(s.degrees), toward_degrees: num(s.toward) });
const readStep = (s: any): PathStep => ('line' in s ? { ...newStep('line'), length: str(s.line) } : { ...newStep('bend'), radius: str(s.arc_radius), degrees: str(s.degrees), toward: str(s.toward_degrees ?? 0) });

const readOther = (f: any, ...keys: string[]) => {
  const out = { ...(f.app ?? {}) };
  for (const k of keys) delete out[k];
  return out;
};

/** Fillet and chamfer follow smoothly joined edges unless this is off, as Onshape's Tangent propagation does. */
const TANGENT: FieldDef = { key: 'propagate', label: 'Tangent propagation', kind: 'check' };
const propagation = (v: Values) => (v.propagate === false ? { propagate: false } : {});

/**
 * What a mirror or pattern copies, as Onshape's Part and Feature types: parts, which with none picked means every
 * part, as it always has, or features picked in the list or by a face they made.
 */
function copyOf(title: string, verb: string): FieldDef[] {
  return [
    { key: 'copyType', label: `${title} type`, kind: 'select', options: [{ value: 'part', label: `Part ${verb}` }, { value: 'feature', label: `Feature ${verb}` }] },
    { key: 'bodies', label: `Parts to ${verb}`, kind: 'parts', when: (v) => v.copyType !== 'feature', hint: 'None picked means every part.' },
    { key: 'of', label: `Features to ${verb}`, kind: 'features', when: (v) => v.copyType === 'feature' },
  ];
}
const COPY_DEFAULTS = { copyType: 'part', bodies: [], of: [] };
const copyMissing = (verb: string) => (v: Values) => (v.copyType === 'feature' && !v.of?.length ? `Click the features to ${verb}, in the list or in the view` : null);
const copyJson = (v: Values) => (v.copyType === 'feature' ? { of: [...v.of] } : v.bodies?.length ? { bodies: [...v.bodies] } : {});
// The kernel writes a copy of the whole part with an empty `of`.
const readCopy = (f: any): Values => (Array.isArray(f.of) && f.of.length ? { copyType: 'feature', of: [...f.of], bodies: [] } : { copyType: 'part', of: [], bodies: f.bodies ?? [] });

/** Onshape's plane types, in its order. */
export const PLANE_TYPES = [
  { value: 'offset', label: 'Offset' },
  { value: 'plane_point', label: 'Plane point' },
  { value: 'line_angle', label: 'Line angle' },
  { value: 'point_normal', label: 'Point normal' },
  { value: 'three_point', label: 'Three point' },
  { value: 'mid_plane', label: 'Mid plane' },
  { value: 'curve_point', label: 'Curve point' },
  { value: 'tangent', label: 'Tangent plane' },
];
const typeIs = (...types: string[]) => (v: Values) => types.includes(v.planeType);
const has = (x: unknown) => x !== null && x !== undefined;
const PLANE_DEFAULTS = {
  planeType: 'offset', plane: null, point: null, line: null, points: [], planes: [], edge: null, face: null, reference: null,
  midBy: 'planes', curveBy: 'fraction', tangentBy: 'angle', distance: '20', degrees: '0', fraction: '0.5', flip: false,
  sizeOn: false, size: '50', otherApp: {},
};

/**
 * Onshape's Plane feature: a plane, not a part, worked out again at every rebuild from what it's made from, so it
 * follows them. Each type picks what it needs, and switching type keeps whatever the new one can use.
 */
const PLANE_DEF: FeatureDef = {
  id: 'plane',
  title: 'Plane',
  icon: 'plane',
  namePrefix: 'Plane',
  ownsApp: true,
  fields: [
    { key: 'planeType', label: 'Plane type', kind: 'select', options: PLANE_TYPES, flip: { key: 'flip', label: 'Flip normal' } },
    { key: 'midBy', label: 'Between', kind: 'segment', options: [{ value: 'planes', label: 'Two planes' }, { value: 'points', label: 'Two points' }], when: typeIs('mid_plane') },
    { key: 'plane', label: 'Plane or flat face', kind: 'plane', when: typeIs('offset', 'plane_point') },
    { key: 'planes', label: 'Planes or flat faces', kind: 'planes', max: 2, when: (v) => v.planeType === 'mid_plane' && v.midBy !== 'points' },
    { key: 'points', label: 'Points', kind: 'points', max: 3, when: typeIs('three_point'), hint: 'The plane starts at the first, its x runs toward the second, and it faces the side they go round counter-clockwise from.' },
    { key: 'points', label: 'Points', kind: 'points', max: 2, when: (v) => v.planeType === 'mid_plane' && v.midBy === 'points' },
    { key: 'edge', label: 'Edge', kind: 'edge', when: typeIs('curve_point') },
    { key: 'face', label: 'Round face', kind: 'face', surface: true, when: typeIs('tangent'), hint: 'A cylinder, cone or sphere.' },
    { key: 'curveBy', label: 'Where', kind: 'segment', options: [{ value: 'fraction', label: 'Along the edge' }, { value: 'point', label: 'At a point' }], when: typeIs('curve_point') },
    { key: 'tangentBy', label: 'Where', kind: 'segment', options: [{ value: 'angle', label: 'By angle' }, { value: 'point', label: 'At a point' }], when: typeIs('tangent') },
    { key: 'point', label: 'Point', kind: 'point', when: (v) => ['plane_point', 'point_normal'].includes(v.planeType) || (v.planeType === 'curve_point' && v.curveBy === 'point') || (v.planeType === 'tangent' && v.tangentBy === 'point') },
    { key: 'line', label: 'Line or axis', kind: 'line', when: typeIs('line_angle', 'point_normal') },
    { ...dim('distance', 'Distance'), when: typeIs('offset') },
    { ...angle('degrees', 'Angle'), when: (v) => v.planeType === 'line_angle' || (v.planeType === 'tangent' && v.tangentBy !== 'point') },
    { key: 'fraction', label: 'Along', kind: 'expr', scrub: 0.05, when: (v) => v.planeType === 'curve_point' && v.curveBy !== 'point', hint: 'From 0 at the edge’s start to 1 at its end.' },
    { key: 'reference', label: 'Reference plane', kind: 'plane', when: typeIs('line_angle'), hint: 'At 0° the plane comes nearest to parallel with this one. Without one, it goes by Top, Front and Right.' },
    // How big it's drawn changes nothing in the model, so it's kept in the feature's app data, as Onshape keeps its own.
    { key: 'sizeOn', label: 'Display size', kind: 'group', checkable: true, fields: [{ ...dim('size', 'Size'), hint: 'How big the plane is drawn. Unticked, it goes by the size of the model.' }] },
  ],
  defaults: () => ({ ...PLANE_DEFAULTS }),
  missing(v) {
    switch (v.planeType) {
      case 'offset': return has(v.plane) ? null : 'Click a plane or a flat face';
      case 'plane_point': return !has(v.plane) ? 'Click a plane or a flat face' : !has(v.point) ? 'Click a point for it to go through' : null;
      case 'line_angle': return has(v.line) ? null : 'Click a line, an edge or something round for its axis';
      case 'point_normal': return !has(v.point) ? 'Click a point' : !has(v.line) ? 'Click a line for it to be square to' : null;
      case 'three_point': return (v.points?.length ?? 0) < 3 ? `Click ${3 - (v.points?.length ?? 0)} more point${v.points?.length === 2 ? '' : 's'}` : null;
      case 'mid_plane':
        if (v.midBy === 'points') return (v.points?.length ?? 0) < 2 ? 'Click two points' : null;
        return (v.planes?.length ?? 0) < 2 ? 'Click two planes or flat faces' : null;
      case 'curve_point': return !has(v.edge) ? 'Click an edge' : v.curveBy === 'point' && !has(v.point) ? 'Click a point on or near the edge' : null;
      case 'tangent': return !has(v.face) ? 'Click a round face' : v.tangentBy === 'point' && !has(v.point) ? 'Click a point on or near the face' : null;
      default: return 'Choose a plane type';
    }
  },
  make(v) {
    if (PLANE_DEF.missing!(v)) return null;
    const out: any = { type: 'plane', plane_type: v.planeType };
    switch (v.planeType) {
      case 'offset': Object.assign(out, { plane: v.plane, distance: num(v.distance) }); break;
      case 'plane_point': Object.assign(out, { plane: v.plane, point: v.point }); break;
      case 'line_angle': Object.assign(out, { line: v.line, degrees: num(v.degrees) }, has(v.reference) ? { reference: v.reference } : {}); break;
      case 'point_normal': Object.assign(out, { point: v.point, line: v.line }); break;
      case 'three_point': out.points = v.points.slice(0, 3); break;
      case 'mid_plane': if (v.midBy === 'points') out.points = v.points.slice(0, 2); else out.planes = v.planes.slice(0, 2); break;
      case 'curve_point': Object.assign(out, { edge: v.edge }, v.curveBy === 'point' ? { point: v.point } : { fraction: num(v.fraction) }); break;
      case 'tangent': Object.assign(out, { face: v.face }, v.tangentBy === 'point' ? { point: v.point } : { degrees: num(v.degrees) }); break;
    }
    if (v.flip) out.flip = true;
    const size = Number(v.size);
    const app = { ...v.otherApp, ...(v.sizeOn && size > 0 ? { size } : {}) };
    if (Object.keys(app).length) out.app = app;
    return out;
  },
  read(f) {
    const t = f.plane_type ?? 'offset';
    const size = Number(f.app?.size);
    const v: Values = { ...PLANE_DEFAULTS, planeType: t, flip: !!f.flip, sizeOn: size > 0, size: size > 0 ? str(size) : PLANE_DEFAULTS.size, otherApp: readOther(f, 'size') };
    for (const k of ['plane', 'point', 'line', 'edge', 'face', 'reference']) if (has(f[k])) v[k] = f[k];
    if (Array.isArray(f.points)) v.points = f.points;
    if (Array.isArray(f.planes)) v.planes = f.planes;
    if (t === 'mid_plane') v.midBy = Array.isArray(f.points) ? 'points' : 'planes';
    if (t === 'curve_point') v.curveBy = has(f.point) ? 'point' : 'fraction';
    if (t === 'tangent') v.tangentBy = has(f.point) ? 'point' : 'angle';
    if (has(f.distance)) v.distance = str(f.distance);
    if (has(f.degrees)) v.degrees = str(f.degrees);
    if (has(f.fraction)) v.fraction = str(f.fraction);
    return v;
  },
};

/** A plane, or what can stand for one, picked in the view or the list: Top, Front, Right, a plane feature or a flat face. */
const planeField = (key: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, kind: 'plane', ...extra });
/** What a feature that takes a plane read before it could take any: a point and a normal. */
const readPlane = (f: any, signed: boolean) => (has(f.plane) ? f.plane : planeFromNumbers(f.normal, f.point, signed));

/** A pattern's direction or axis: X, Y or Z, or along a line picked in the view, which it then follows. */
const DIRECTION_OPTIONS = [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' }, { value: 'line', label: 'Line' }];
const lineOr = (v: Values, key: string, line: string) => (v[key] === 'line' ? v[line] : AXES[v[key] as AxisName]);

/**
 * Onshape's Sheet metal model, from a sketch: a closed outline makes a flat plate, and a chain of lines makes walls as
 * deep as Depth, with a bend at each corner. The part keeps its thickness, bend radius and K factor for the flanges and
 * the flat pattern after it.
 */
const chainSketch = (v: Values) => has(v.sketch) && !sketchRegions().get(Number(v.sketch))?.length;
const SHEET_METAL_DEF: FeatureDef = {
  id: 'sheet-metal',
  title: 'Sheet metal model',
  icon: 'sheet-metal',
  namePrefix: 'Sheet metal',
  fields: [
    { key: 'sketch', label: 'Sketch', kind: 'sketch', hint: 'A closed outline makes a flat plate. A chain of lines makes walls, with a bend at each corner.' },
    { ...dim('depth', 'Depth'), when: chainSketch },
    { ...dim('thickness', 'Thickness'), flip: { key: 'flip', label: 'Thicken the other side' } },
    dim('bendRadius', 'Bend radius'),
    { key: 'kFactor', label: 'K factor', kind: 'expr', scrub: 0.01, hint: 'Where the neutral line lies across the sheet, 0 at the inside of a bend and 1 at the outside.' },
    {
      key: 'corner',
      label: 'Flange corners',
      kind: 'segment',
      options: [{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }],
      hint: 'Where two flanges of one feature meet: Open leaves the corner open, Closed runs one wall over the other’s end, for 90° flanges.',
    },
    { ...dim('minimalGap', 'Minimal gap'), scrub: 0.05, hint: 'Between walls that close a corner, and between hems that meet at one.' },
  ],
  defaults: () => ({ sketch: lastSketchId(), depth: '30', thickness: '2', flip: false, bendRadius: '2', kFactor: '0.45', corner: 'open', minimalGap: '0.2' }),
  missing: (v) => (has(v.sketch) ? null : 'Choose a sketch'),
  make(v) {
    if (this.missing!(v)) return null;
    return {
      type: 'sheet_metal',
      sketch: Number(v.sketch),
      ...(chainSketch(v) ? { depth: num(v.depth) } : {}),
      thickness: num(v.thickness),
      bend_radius: num(v.bendRadius),
      k_factor: num(v.kFactor),
      ...(v.flip ? { flip: true } : {}),
      minimal_gap: num(v.minimalGap),
      ...(v.corner === 'closed' ? { corner: 'closed' } : {}),
    };
  },
  read: (f) => ({
    sketch: f.sketch, depth: str(f.depth ?? 30), thickness: str(f.thickness ?? 2), flip: !!f.flip,
    bendRadius: str(f.bend_radius ?? f.thickness ?? 2), kFactor: str(f.k_factor ?? 0.45), corner: f.corner ?? 'open',
    minimalGap: str(f.minimal_gap ?? (typeof f.thickness === 'number' ? Math.round(f.thickness * 100) / 1000 : 0.2)),
  }),
};

/** The model before the feature in the dialog, for a tab to find the wall it's drawn on. The dialog hands it over. */
let modelBefore: () => { faces: FaceInfo[]; parts: { name: string; faces: number[] }[] } | null = () => null;
export const setModelBefore = (fn: typeof modelBefore) => { modelBefore = fn; };

/**
 * Where a tab goes: the sheet metal wall face its sketch lies on, the part that face is on, and which way into the sheet
 * from the sketch, so the tab is exactly as thick as the wall and in line with it.
 */
function tabWall(v: Values): { body: string; inward: boolean; thickness: unknown } | null {
  const sketchId = picks(v)[0]?.sketch ?? (has(v.sketch) ? Number(v.sketch) : null);
  const f = sketchId !== null ? doc.features.find((x) => x.id === sketchId) : null;
  const base = modelBefore();
  if (!f || !base) return null;
  const plane = sketchPlane(f);
  const n = plane.z;
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  for (const [i, face] of base.faces.entries()) {
    if (face.surface !== 'plane') continue;
    const len = Math.hypot(...face.normal) || 1;
    const along = dot(face.normal, n) / len;
    if (Math.abs(Math.abs(along) - 1) > 1e-6) continue;
    if (Math.abs(dot([face.center[0] - plane.origin[0], face.center[1] - plane.origin[1], face.center[2] - plane.origin[2]], n)) > 1e-6) continue;
    const body = base.parts.find((p) => p.faces.includes(i))?.name;
    const sheet = sheetParts().find((p) => p.body === body);
    if (!body || !sheet?.flat) continue;
    // The sheet is behind its face: the tab goes the way the face looks away from.
    const made = doc.features.find((x) => x.id === Number(/^f(\d+)/.exec(body)?.[1]));
    return { body, inward: along < 0, thickness: made?.thickness ?? sheet.flat.thickness };
  }
  return null;
}

/**
 * Onshape's Tab: regions sketched on a sheet metal wall's face, added to the wall as thick as the sheet, so they're in
 * its flat pattern too.
 */
const TAB_DEF: FeatureDef = {
  id: 'tab',
  title: 'Tab',
  icon: 'tab',
  namePrefix: 'Tab',
  needsBody: true,
  needsModel: true,
  fields: [{ key: 'regions', label: 'Tab profiles', kind: 'regions', hint: 'Regions of a sketch drawn on a flat wall of sheet metal, touching the wall.' }],
  defaults: () => ({ sketch: null, regions: [], faces: [] }),
  missing(v) {
    if (!regionsChosen(v)) return 'Click regions sketched on a wall';
    return tabWall(v) ? null : 'Sketch the tab on a flat face of a sheet metal wall';
  },
  make(v) {
    if (this.missing!(v)) return null;
    const wall = tabWall(v)!;
    const t = wall.thickness as number | string;
    return { type: 'extrude', ...regionsJson(v), start: wall.inward ? 0 : typeof t === 'number' ? -t : `-(${t})`, length: t, mode: 'add', bodies: [wall.body], app: { ...v.otherApp, tab: true } };
  },
  read: (f) => ({ ...readRegions(f), otherApp: readOther(f, 'tab') }),
};

/** The bend radius a flange takes when it has none of its own: the last sheet metal model's. */
function modelBendRadius(): string {
  const f = [...doc.features].reverse().find((x) => x.type === 'sheet_metal');
  return str(f?.bend_radius ?? f?.thickness ?? 2);
}

/**
 * Onshape's Flange: a bend and a wall along each edge picked, where a wall's face meets its side. Its length is from
 * the outer virtual sharp, and Alignment says where the bend goes.
 */
const FLANGE_DEF: FeatureDef = {
  id: 'flange',
  title: 'Flange',
  icon: 'flange',
  namePrefix: 'Flange',
  needsBody: true,
  fields: [
    { key: 'edges', label: 'Edges to flange', kind: 'edges', hint: 'Edges along the side of a wall. Flanges that meet at a corner go in one feature.' },
    {
      key: 'alignment',
      label: 'Alignment',
      kind: 'segment',
      options: [{ value: 'outer', label: 'Outer' }, { value: 'inner', label: 'Inner' }, { value: 'bend', label: 'Bend' }],
      hint: 'Outer keeps the part’s outside size, Inner puts the flange’s inside on the edge, and Bend starts the bend there.',
    },
    { ...dim('length', 'Length'), flip: { key: 'flip', label: 'Flip direction' } },
    angle('degrees', 'Angle'),
    { key: 'modelRadius', label: 'Use model bend radius', kind: 'check' },
    { ...dim('bendRadius', 'Bend radius'), when: (v) => !v.modelRadius },
    {
      key: 'corner',
      label: 'Corners',
      kind: 'select',
      options: [{ value: 'model', label: 'As the model says' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }],
      hint: 'Where two of its flanges meet. Closed runs one wall over the other’s end, for 90° flanges at an outside corner.',
    },
  ],
  defaults: () => ({ edges: [], alignment: 'outer', length: '20', flip: false, degrees: '90', modelRadius: true, bendRadius: modelBendRadius(), corner: 'model' }),
  missing: (v) => (v.edges.length ? null : 'Click edges along the side of a wall'),
  make(v) {
    if (this.missing!(v)) return null;
    return {
      type: 'flange',
      edges: edgeField(v.edges),
      length: num(v.length),
      degrees: num(v.degrees),
      alignment: v.alignment,
      ...(v.flip ? { flip: true } : {}),
      ...(v.modelRadius ? {} : { bend_radius: num(v.bendRadius) }),
      ...(v.corner === 'model' ? {} : { corner: v.corner }),
    };
  },
  read: (f) => ({
    edges: edgeList(f.edges), alignment: f.alignment ?? 'outer', length: str(f.length), flip: !!f.flip, degrees: str(f.degrees ?? 90),
    modelRadius: f.bend_radius === undefined, bendRadius: str(f.bend_radius ?? modelBendRadius()), corner: f.corner ?? 'model',
  }),
};

/** The minimal gap a hem takes when it has none of its own: the last sheet metal model's, or a tenth of its thickness. */
function modelGap(): string {
  const f = [...doc.features].reverse().find((x) => x.type === 'sheet_metal');
  if (f?.minimal_gap !== undefined) return str(f.minimal_gap);
  return typeof f?.thickness === 'number' ? str(Math.round(f.thickness * 100) / 1000) : '0.2';
}

const HEM_DEGREES: Record<string, string> = { teardrop: '225', rolled: '270' };
const hemKind = (...kinds: string[]) => (v: Values) => kinds.includes(v.kind);

/**
 * Onshape's Hem: an edge of a wall folded back over it. Straight leaves a gap and runs on, Rounded does the same round
 * a bend radius, Teardrop turns further and leans back, and Rolled is a curl with nothing after it.
 */
const HEM_DEF: FeatureDef = {
  id: 'hem',
  title: 'Hem',
  icon: 'hem',
  namePrefix: 'Hem',
  needsBody: true,
  fields: [
    { key: 'edges', label: 'Edges to hem', kind: 'edges', hint: 'Edges along the side of a wall. Hems that meet at a corner go in one feature.' },
    { key: 'kind', label: 'Hem type', kind: 'tabs', options: [{ value: 'straight', label: 'Straight' }, { value: 'rounded', label: 'Rounded' }, { value: 'teardrop', label: 'Teardrop' }, { value: 'rolled', label: 'Rolled' }] },
    {
      key: 'alignment',
      label: 'Alignment',
      kind: 'segment',
      options: [{ value: 'outer', label: 'Outer' }, { value: 'inner', label: 'Inner' }, { value: 'bend', label: 'Bend' }],
      hint: 'Outer keeps the part’s outside size, Inner puts the fold’s inside on the edge, and Bend starts the fold there.',
    },
    { ...dim('length', 'Length'), when: (v) => v.kind !== 'rolled', flip: { key: 'flip', label: 'Flip direction' } },
    // A teardrop turns 225° and a roll 270° unless told otherwise, each kept apart so switching keeps both.
    { ...angle('teardropDegrees', 'Angle'), when: hemKind('teardrop'), hint: 'How far round it turns: more than 180°.' },
    { ...angle('rolledDegrees', 'Angle'), when: hemKind('rolled'), hint: 'How far round it turns: more than 180° and less than 360°.' },
    { key: 'flip', label: 'Fold the other way', kind: 'check', when: hemKind('rolled') },
    { key: 'modelGap', label: 'Use model minimal gap', kind: 'check', when: hemKind('straight') },
    { ...dim('gap', 'Gap'), when: (v) => v.kind === 'straight' && !v.modelGap, hint: 'Between the wall and what folds back over it.' },
    { key: 'modelRadius', label: 'Use model bend radius', kind: 'check', when: (v) => v.kind !== 'straight' },
    { ...dim('bendRadius', 'Bend radius'), when: (v) => v.kind !== 'straight' && !v.modelRadius },
  ],
  defaults: () => ({ edges: [], kind: 'straight', alignment: 'outer', length: '10', flip: false, teardropDegrees: HEM_DEGREES.teardrop, rolledDegrees: HEM_DEGREES.rolled, modelGap: true, gap: modelGap(), modelRadius: true, bendRadius: modelBendRadius() }),
  missing: (v) => (v.edges.length ? null : 'Click edges along the side of a wall'),
  make(v) {
    if (this.missing!(v)) return null;
    const out: any = { type: 'hem', edges: edgeField(v.edges), kind: v.kind, alignment: v.alignment };
    if (v.kind !== 'rolled') out.length = num(v.length);
    if (v.kind === 'teardrop') out.degrees = num(v.teardropDegrees);
    if (v.kind === 'rolled') out.degrees = num(v.rolledDegrees);
    if (v.kind === 'straight' && !v.modelGap) out.gap = num(v.gap);
    if (v.kind !== 'straight' && !v.modelRadius) out.bend_radius = num(v.bendRadius);
    if (v.flip) out.flip = true;
    return out;
  },
  read: (f) => {
    const kind = f.kind ?? 'straight';
    return {
      edges: edgeList(f.edges), kind, alignment: f.alignment ?? 'outer', length: str(f.length ?? 10), flip: !!f.flip,
      teardropDegrees: kind === 'teardrop' && f.degrees !== undefined ? str(f.degrees) : HEM_DEGREES.teardrop,
      rolledDegrees: kind === 'rolled' && f.degrees !== undefined ? str(f.degrees) : HEM_DEGREES.rolled, modelGap: f.gap === undefined, gap: str(f.gap ?? modelGap()),
      modelRadius: f.bend_radius === undefined, bendRadius: str(f.bend_radius ?? modelBendRadius()),
    };
  },
};

/**
 * Onshape's Bend: a sheet metal part folded along a line sketched on one of its walls. The strip the bend takes is
 * part of the wall it was, so the flat pattern stays as it was.
 */
const BEND_DEF: FeatureDef = {
  id: 'bend',
  title: 'Bend',
  icon: 'bend',
  namePrefix: 'Bend',
  needsBody: true,
  fields: [
    { key: 'sketch', label: 'Bend line', kind: 'sketch', hint: 'A sketch with one line, drawn on a wall’s face and going right across it.' },
    { ...angle('degrees', 'Angle'), flip: { key: 'flip', label: 'Flip direction' } },
    {
      key: 'position',
      label: 'Bend position',
      kind: 'segment',
      options: [{ value: 'center', label: 'Centered on line' }, { value: 'start', label: 'Starts at line' }],
    },
    { key: 'otherSide', label: 'Move the other side', kind: 'check', hint: 'Which side of the line stays put. The side that moves takes its flanges with it.' },
    { key: 'modelRadius', label: 'Use model bend radius', kind: 'check' },
    { ...dim('bendRadius', 'Bend radius'), when: (v) => !v.modelRadius },
  ],
  defaults: () => ({ sketch: lastSketchId(), degrees: '90', flip: false, position: 'center', otherSide: false, modelRadius: true, bendRadius: modelBendRadius() }),
  missing: (v) => (has(v.sketch) ? null : 'Choose a sketch with one line across a wall'),
  make(v) {
    if (this.missing!(v)) return null;
    return {
      type: 'bend', sketch: Number(v.sketch), degrees: num(v.degrees),
      ...(v.position === 'start' ? { position: 'start' } : {}),
      ...(v.otherSide ? { moves: 'right' } : {}),
      ...(v.flip ? { flip: true } : {}),
      ...(v.modelRadius ? {} : { bend_radius: num(v.bendRadius) }),
    };
  },
  read: (f) => ({
    sketch: f.sketch, degrees: str(f.degrees ?? 90), flip: !!f.flip, position: f.position ?? 'center', otherSide: f.moves === 'right',
    modelRadius: f.bend_radius === undefined, bendRadius: str(f.bend_radius ?? modelBendRadius()),
  }),
};

/**
 * Onshape's Thin: a wall along the sketch's outlines, and its open curves, in place of the regions, `thickness` thick,
 * into each region, out of it, or half each way. A surface has no wall to make.
 */
const THIN: FieldDef = {
  key: 'thinOn',
  label: 'Thin',
  kind: 'group',
  checkable: true,
  when: (v) => !surface(v),
  fields: [
    dim('thinThickness', 'Thickness'),
    { key: 'thinSide', label: 'Side', kind: 'segment', options: [{ value: 'inside', label: 'Inside' }, { value: 'outside', label: 'Outside' }, { value: 'both', label: 'Both' }], hint: 'Inside goes into each region, or to the left of an open curve as it was drawn.' },
  ],
};
const THIN_DEFAULTS = { thinOn: false, thinThickness: '2', thinSide: 'inside' };
const thinOn = (v: Values) => !!v.thinOn && !surface(v);
const thinJson = (v: Values) => (thinOn(v) ? { thin: { thickness: num(v.thinThickness), side: v.thinSide ?? 'inside' } } : {});
const readThin = (f: any): Values => (f.thin ? { thinOn: true, thinThickness: str(f.thin.thickness), thinSide: f.thin.side ?? 'inside' } : { ...THIN_DEFAULTS });
/** With Thin on, a whole sketch will do with no regions picked, as one of open curves has none to pick. */
const THIN_SKETCH: FieldDef = { key: 'sketch', label: 'Sketch', kind: 'sketch', when: (v) => thinOn(v) && !picks(v).length, hint: 'With no regions picked, the wall follows every curve of this sketch, open ones too.' };
const thinSketchChosen = (v: Values) => thinOn(v) && !picks(v).length && has(v.sketch);

/** The metric sizes the kernel's hole tables have. */
export const HOLE_SIZES = ['M1.6', 'M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M20', 'M24', 'M30', 'M36'];
const custom = (v: Values) => v.size === 'custom';
/** A point of a sketch, as a hole takes one: a point entity's id, or a curve's end or centre such as "9.center". */
interface HolePoint { sketch: number; point: string }
/** Every point entity of a sketch, construction ones too, as a hole with no points listed takes them. */
function sketchPointsOf(sketch: number | null): HolePoint[] {
  const f = sketch === null ? null : doc.features.find((x) => x.id === sketch);
  return (f?.sketch?.entities ?? []).filter((e: any) => e.type === 'point').map((e: any) => ({ sketch: sketch!, point: String(e.id) }));
}

const HOLE_DEFAULTS = {
  style: 'simple', sketch: null as number | null, at: [] as HolePoint[], size: 'M6', fit: 'normal', tapped: false, diameter: '6', cboreDiameter: '11', cboreDepth: '6',
  csinkDiameter: '13', csinkAngle: '90', end: 'blind', depth: '10', flat: false, opposite: false, fromSketch: false, bodies: [] as string[],
};
/**
 * Onshape's Hole: a hole at each point of a sketch, cut from the parts it reaches. A metric size fills in the
 * clearance, tap drill, counterbore and countersink from the kernel's tables; Custom takes the sizes typed.
 */
const HOLE_DEF: FeatureDef = {
  id: 'hole',
  title: 'Hole',
  icon: 'hole',
  namePrefix: 'Hole',
  needsBody: true,
  startPick: 'at',
  fields: [
    { key: 'style', label: 'Style', kind: 'tabs', options: [{ value: 'simple', label: 'Simple' }, { value: 'counterbore', label: 'Counterbore' }, { value: 'countersink', label: 'Countersink' }] },
    { key: 'at', label: 'Sketch points', kind: 'points', sketchOnly: true, hint: 'Click points of one sketch: points, circle centres or line ends. A hole goes in at each, against the sketch’s normal.' },
    { key: 'size', label: 'Size', kind: 'select', options: [...HOLE_SIZES.map((x) => ({ value: x, label: x })), { value: 'custom', label: 'Custom' }] },
    { key: 'tapped', label: 'Tapped', kind: 'check', when: (v) => !custom(v), hint: 'Drilled at the tap drill. The thread is noted, not modelled.' },
    { key: 'fit', label: 'Fit', kind: 'segment', when: (v) => !custom(v) && !v.tapped, options: [{ value: 'close', label: 'Close' }, { value: 'normal', label: 'Normal' }, { value: 'loose', label: 'Loose' }] },
    { ...dim('diameter', 'Hole diameter'), when: custom },
    { ...dim('cboreDiameter', 'Counterbore diameter'), when: (v) => custom(v) && v.style === 'counterbore' },
    { ...dim('cboreDepth', 'Counterbore depth'), when: (v) => custom(v) && v.style === 'counterbore' },
    { ...dim('csinkDiameter', 'Countersink diameter'), when: (v) => custom(v) && v.style === 'countersink' },
    { ...angle('csinkAngle', 'Countersink angle'), when: (v) => custom(v) && v.style === 'countersink' },
    {
      key: 'end',
      label: 'Termination',
      kind: 'select',
      options: [{ value: 'blind', label: 'Blind' }, { value: 'up_to_next', label: 'Up to next' }, { value: 'through_all', label: 'Through all' }],
      flip: { key: 'opposite', label: 'Flip direction' },
    },
    { ...dim('depth', 'Depth'), when: (v) => v.end === 'blind' },
    { key: 'flat', label: 'Flat bottom', kind: 'check', when: (v) => v.end === 'blind' },
    { key: 'fromSketch', label: 'Start from sketch plane', kind: 'check' },
    { key: 'bodies', label: 'Parts to cut', kind: 'parts', hint: 'None picked means every part it reaches.' },
  ],
  defaults: () => {
    const sketch = lastSketchId();
    return { ...HOLE_DEFAULTS, sketch, at: sketchPointsOf(sketch) };
  },
  missing: (v) => {
    const at = (v.at ?? []) as HolePoint[];
    if (!at.length) return 'Click the sketch points to drill at';
    return new Set(at.map((p) => p.sketch)).size > 1 ? 'A hole takes the points of one sketch. Remove the others, or add a hole for each sketch.' : null;
  },
  make(v) {
    if (this.missing!(v)) return null;
    const at = v.at as HolePoint[];
    const sketch = at[0].sketch;
    const out: any = { type: 'hole', sketch, style: v.style };
    // Every point of the sketch is the sketch by itself, so points drawn later get holes too, and none renumber.
    const all = sketchPointsOf(sketch).map((p) => p.point);
    const names = at.map((p) => p.point);
    if (!(names.length === all.length && all.every((n) => names.includes(n)))) out.points = names;
    if (custom(v)) {
      out.diameter = num(v.diameter);
      if (v.style === 'counterbore') Object.assign(out, { cbore_diameter: num(v.cboreDiameter), cbore_depth: num(v.cboreDepth) });
      if (v.style === 'countersink') Object.assign(out, { csink_diameter: num(v.csinkDiameter), csink_angle: num(v.csinkAngle) });
    } else {
      out.size = v.size;
      if (v.tapped) out.tapped = true;
      else out.fit = v.fit;
    }
    out.end = v.end;
    if (v.end === 'blind') {
      out.depth = num(v.depth);
      if (v.flat) out.tip_angle = 180;
    }
    if (v.opposite) out.opposite = true;
    if (v.fromSketch) out.from_sketch = true;
    if (v.bodies?.length) out.bodies = [...v.bodies];
    return out;
  },
  read(f) {
    const at: HolePoint[] = Array.isArray(f.points) ? f.points.map((p: unknown) => ({ sketch: f.sketch, point: String(p) })) : sketchPointsOf(f.sketch ?? null);
    const v: Values = { ...HOLE_DEFAULTS, sketch: f.sketch ?? null, at, style: f.style ?? 'simple', end: f.end ?? 'blind', opposite: !!f.opposite, fromSketch: !!f.from_sketch, bodies: f.bodies ?? [] };
    if (f.size) Object.assign(v, { size: f.size, tapped: !!f.tapped, fit: f.fit ?? 'normal' });
    else v.size = 'custom';
    for (const [k, key] of [['diameter', 'diameter'], ['cboreDiameter', 'cbore_diameter'], ['cboreDepth', 'cbore_depth'], ['csinkDiameter', 'csink_diameter'], ['csinkAngle', 'csink_angle'], ['depth', 'depth']]) if (has(f[key])) v[k] = str(f[key]);
    v.flat = Number(f.tip_angle) === 180;
    return v;
  },
};

/**
 * Onshape's Rib: a wall along each of a sketch's open curves, running until it meets the parts and joined to them,
 * across the sketch's plane (a gusset) or along its normal.
 */
const RIB_DEF: FeatureDef = {
  id: 'rib',
  title: 'Rib',
  icon: 'rib',
  namePrefix: 'Rib',
  needsBody: true,
  fields: [
    { key: 'sketch', label: 'Sketch', kind: 'sketch', hint: 'Open curves, such as a line across the corner of a bracket.' },
    { ...dim('thickness', 'Thickness'), flip: { key: 'flip', label: 'Flip direction' } },
    {
      key: 'direction',
      label: 'Rib extrusion direction',
      kind: 'segment',
      options: [{ value: 'parallel', label: 'Parallel to sketch plane' }, { value: 'normal', label: 'Normal to sketch plane' }],
      hint: 'Parallel fills between each line and the part. Normal runs out of the sketch plane, as a rib down to a floor.',
    },
    { key: 'extend', label: 'Extend profiles to part', kind: 'check' },
    { key: 'bodies', label: 'Parts', kind: 'parts', hint: 'None picked means every part it meets.' },
  ],
  defaults: () => ({ sketch: lastSketchId(), thickness: '2', flip: false, direction: 'parallel', extend: true, bodies: [] }),
  missing: (v) => (has(v.sketch) ? null : 'Choose a sketch'),
  make(v) {
    if (this.missing!(v)) return null;
    return {
      type: 'rib', sketch: Number(v.sketch), thickness: num(v.thickness), direction: v.direction,
      ...(v.flip ? { flip: true } : {}), ...(v.extend ? {} : { extend: false }), ...(v.bodies?.length ? { bodies: [...v.bodies] } : {}),
    };
  },
  read: (f) => ({ sketch: f.sketch, thickness: str(f.thickness), flip: !!f.flip, direction: f.direction ?? 'parallel', extend: f.extend !== false, bodies: f.bodies ?? [] }),
};

/** Onshape's Split: parts cut into pieces, each a part of its own, by a plane, along a face's whole surface, or by a part. */
const SPLIT_DEF: FeatureDef = {
  id: 'split',
  title: 'Split',
  icon: 'split',
  namePrefix: 'Split',
  needsBody: true,
  fields: [
    { key: 'bodies', label: 'Parts to split', kind: 'parts', hint: 'None picked means every part it reaches.' },
    { key: 'by', label: 'Split with', kind: 'select', options: [{ value: 'plane', label: 'A plane' }, { value: 'face', label: 'A face' }, { value: 'part', label: 'A part' }] },
    planeField('plane', 'Plane', { when: (v) => v.by === 'plane' }),
    { key: 'face', label: 'Face', kind: 'face', when: (v) => v.by === 'face', hint: 'Cuts along the whole surface the face is on, carried on past its edges.' },
    { key: 'tool', label: 'Part', kind: 'part', when: (v) => v.by === 'part', hint: 'A solid, or a surface that goes right through.' },
    { key: 'keepTool', label: 'Keep tool', kind: 'check', when: (v) => v.by === 'part' },
  ],
  defaults: () => ({ bodies: [], by: 'plane', plane: 'right', face: null, tool: null, keepTool: true }),
  missing: (v) => (v.by === 'plane' && !has(v.plane) ? 'Click a plane or a flat face' : v.by === 'face' && !has(v.face) ? 'Click a face to split along' : v.by === 'part' && !has(v.tool) ? 'Click the part to split with' : null),
  make(v) {
    if (this.missing!(v)) return null;
    const out: any = { type: 'split' };
    if (v.by === 'plane') out.plane = v.plane;
    else if (v.by === 'face') out.face = v.face;
    else Object.assign(out, { tool: v.tool, ...(v.keepTool ? {} : { keep_tool: false }) });
    if (v.bodies?.length) out.bodies = [...v.bodies];
    return out;
  },
  read: (f) => ({
    bodies: f.bodies ?? [], by: f.tool ? 'part' : f.face ? 'face' : 'plane', plane: has(f.plane) ? f.plane : 'right', face: f.face ?? null,
    tool: f.tool ?? null, keepTool: f.keep_tool !== false,
  }),
};

export const DEFS: FeatureDef[] = ([
  solidDef('box', 'Box', [dim('dx', 'Width'), dim('dy', 'Depth'), dim('dz', 'Height')], { dx: '40', dy: '30', dz: '20' }),
  solidDef('cylinder', 'Cylinder', [dim('radius', 'Radius'), dim('height', 'Height')], { radius: '15', height: '30' }),
  solidDef('cone', 'Cone', [dim('r0', 'Base radius'), dim('r1', 'Top radius'), dim('height', 'Height')], { r0: '15', r1: '5', height: '30' }),
  solidDef('sphere', 'Sphere', [dim('radius', 'Radius')], { radius: '15' }),
  solidDef('torus', 'Torus', [dim('major', 'Ring radius'), dim('minor', 'Tube radius')], { major: '20', minor: '5' }),
  PLANE_DEF,
  {
    id: 'extrude',
    title: 'Extrude',
    icon: 'extrude',
    namePrefix: 'Extrude',
    fields: [
      CREATION,
      MODE,
      { key: 'regions', label: 'Faces and sketch regions to extrude', kind: 'regions', takesFaces: true },
      {
        key: 'end',
        label: 'End type',
        kind: 'select',
        options: END_TYPES.map((o) => ({ ...o, disabled: o.value === 'blind' ? undefined : surface })),
        flip: { key: 'flip', label: 'Flip direction', disabled: (v) => blind(v) && !!v.symmetric },
      },
      { key: 'endFace', label: 'Up to face', kind: 'face', takesPlanes: true, when: (v) => endType(v) === 'up_to_face' },
      { key: 'endPart', label: 'Up to part', kind: 'part', when: (v) => endType(v) === 'up_to_part' },
      { key: 'endVertex', label: 'Up to vertex', kind: 'vertex', when: (v) => endType(v) === 'up_to_vertex' },
      { ...dim('length', 'Depth'), when: blind },
      { key: 'symmetric', label: 'Symmetric', kind: 'check', when: blind },
      { key: 'offsetOn', label: 'Starting offset', kind: 'group', checkable: true, fields: [{ ...dim('offset', 'Offset'), scrub: 0.5 }] },
      { key: 'secondOn', label: 'Second end position', kind: 'group', checkable: true, when: blind, disabled: (v) => !!v.symmetric, fields: [dim('second', 'Depth')] },
      THIN,
      THIN_SKETCH,
    ],
    defaults: () => ({ sketch: null, regions: [], faces: [], length: '20', mode: 'add', body: 'solid', ...EXTRUDE_OPTIONS, ...THIN_DEFAULTS }),
    missing(v) {
      if (thinOn(v) && pickedFaces(v).length) return 'A thin extrude takes sketch regions or a sketch, not faces';
      if (!regionsChosen(v) && !thinSketchChosen(v)) return thinOn(v) ? 'Click regions in the view, or choose a sketch' : 'Click faces or regions in the view';
      if (endJson(v) === null) return `Click ${endType(v) === 'up_to_vertex' ? 'near the end of an edge' : 'a face'} to stop at`;
      return null;
    },
    make(v) {
      if (this.missing!(v)) return null;
      const out: any = { type: 'extrude', ...regionsJson(v), ...(pickedFaces(v).length ? { faces: pickedFaces(v) } : {}), mode: modeOf(v) };
      const offset = v.offsetOn ? num(v.offset) : 0;
      if (!blind(v)) Object.assign(out, { start: offset, length: num(v.length), end: endJson(v), opposite: !!v.flip });
      // A feature from a file or an AI can be flipped the kernel's way, which names its end faces the other way round.
      else if (v.keepOpposite && v.flip && !v.symmetric && !v.secondOn) Object.assign(out, { start: offset, length: num(v.length), opposite: true });
      else Object.assign(out, extent(v));
      Object.assign(out, thinJson(v));
      const dialog = { length: v.length, flip: !!v.flip, symmetric: !!v.symmetric, offsetOn: !!v.offsetOn, offset: v.offset, secondOn: !!v.secondOn, second: v.second };
      out.app = { ...v.otherApp, dialog };
      return out;
    },
    read(f) {
      return { ...readRegions(f), ...readMode(f), otherApp: readOther(f, 'dialog'), ...readExtent(f), ...readThin(f) };
    },
  },
  {
    id: 'revolve',
    title: 'Revolve',
    icon: 'revolve',
    namePrefix: 'Revolve',
    fields: [
      CREATION,
      MODE,
      { key: 'regions', label: 'Sketch regions to revolve', kind: 'regions' },
      { key: 'axis', label: 'Revolve axis', kind: 'axis', hint: 'Click a line of the first region’s sketch, or choose one.' },
      angle('degrees', 'Angle'),
      THIN,
      THIN_SKETCH,
    ],
    // The last sketch, all of it, as before regions could be picked: the usual revolve is of a sketch just drawn.
    defaults: () => {
      const sketch = lastSketchId();
      return { sketch, regions: sketch === null ? [] : wholeSketch(sketchRegions().get(sketch)).map((id) => ({ sketch, id })), faces: [], axis: AXIS_CHOICES.y, degrees: '360', mode: 'add', body: 'solid', ...THIN_DEFAULTS };
    },
    missing: (v) => (!regionsChosen(v) && !thinSketchChosen(v) ? 'Click regions in the view' : axisJson(Number(v.sketch), v.axis, v.customAxis) === null ? 'Choose an axis' : null),
    make(v) {
      if (this.missing!(v)) return null;
      const axis = axisJson(Number(v.sketch), v.axis, v.customAxis);
      return { type: 'revolve', ...regionsJson(v), degrees: num(v.degrees), mode: modeOf(v), ...(axis ? { axis } : {}), ...thinJson(v), app: { ...v.otherApp, axis: v.axis } };
    },
    read: (f) => ({ ...readRegions(f), degrees: str(f.degrees ?? 360), ...readMode(f), ...readAxis(f), ...readThin(f), otherApp: readOther(f, 'axis') }),
  },
  {
    id: 'sweep',
    title: 'Sweep',
    icon: 'sweep',
    namePrefix: 'Sweep',
    fields: [
      CREATION,
      MODE,
      { key: 'sketch', label: 'Profile', kind: 'sketch' },
      { key: 'pathPick', label: 'Sweep path', kind: 'path', when: (v) => v.pathBy !== 'steps', hint: 'A sketch’s curves, or a part’s edges, end to end. The profile has to be square to the path where it starts.' },
      { key: 'path', label: 'Path', kind: 'steps', when: (v) => v.pathBy === 'steps', hint: 'The path starts at the sketch, heading straight out of it, and each step carries on from the last.' },
      THIN,
    ],
    // The profile is a closed outline, and the path is usually the open sketch drawn for it.
    defaults: () => ({ sketch: lastSketchId(true) ?? lastSketchId(), pathBy: 'curves', pathPick: [], path: [newStep('line'), newStep('bend')], mode: 'add', body: 'solid', ...THIN_DEFAULTS }),
    missing: (v) => (!has(v.sketch) ? 'Choose a sketch' : v.pathBy === 'steps' ? (!v.path?.length ? 'Add a step to the path' : null) : !v.pathPick?.length ? 'Click the path: a sketch’s curves or a part’s edges' : null),
    make(v) {
      if (this.missing!(v)) return null;
      return { type: 'sweep', sketch: Number(v.sketch), path: v.pathBy === 'steps' ? (v.path as PathStep[]).map(stepJson) : pathJson(v.pathPick), mode: modeOf(v), ...thinJson(v) };
    },
    read: (f) => ({ sketch: f.sketch, ...readPath(f.path), ...readMode(f), ...readThin(f) }),
  },
  {
    id: 'helix',
    title: 'Helix',
    icon: 'helix',
    namePrefix: 'Helix',
    fields: [
      CREATION,
      MODE,
      { key: 'sketch', label: 'Profile', kind: 'sketch', hint: 'Sweeps the sketch around the axis, like a spring or a thread.' },
      { key: 'axis', label: 'Axis', kind: 'segment', options: DIRECTION_OPTIONS },
      { key: 'axisLine', label: 'Axis line', kind: 'line', when: (v) => v.axis === 'line', hint: 'An edge, a sketch line or something round. The helix follows it.' },
      dim('pitch', 'Pitch'),
      { key: 'turns', label: 'Turns', kind: 'expr', scrub: 0.25 },
      { key: 'left', label: 'Left-handed', kind: 'check' },
      { key: 'moved', label: 'Axis position', kind: 'group', when: (v) => v.axis !== 'line', fields: [dim('px', 'X'), dim('py', 'Y'), dim('pz', 'Z')] },
    ],
    defaults: () => ({ sketch: lastSketchId(), axis: 'z', axisLine: null, pitch: '10', turns: '4', left: false, px: '0', py: '0', pz: '0', mode: 'add', body: 'solid' }),
    missing: (v) => (v.sketch === null || v.sketch === undefined ? 'Choose a sketch' : v.axis === 'line' && !has(v.axisLine) ? 'Click a line for the axis' : null),
    make(v) {
      if (this.missing!(v)) return null;
      const at = point(v, ['px', 'py', 'pz']);
      // A line gives where the axis is too, so there's no point with one.
      const around = v.axis === 'line' ? { axis: v.axisLine } : { axis: AXES[v.axis as AxisName], ...(isOrigin(at) ? {} : { point: at }) };
      return { type: 'helix', sketch: Number(v.sketch), pitch: num(v.pitch), turns: num(v.turns), ...around, left_handed: !!v.left, mode: modeOf(v) };
    },
    read: (f) => ({
      sketch: f.sketch, ...(isVector(f.axis) || !has(f.axis) ? { axis: axisName(f.axis), axisLine: null } : { axis: 'line', axisLine: f.axis }),
      pitch: str(f.pitch), turns: str(f.turns), left: !!f.left_handed,
      px: str(f.point?.[0] ?? 0), py: str(f.point?.[1] ?? 0), pz: str(f.point?.[2] ?? 0), ...readMode(f),
    }),
  },
  {
    id: 'fillet',
    title: 'Fillet',
    icon: 'fillet',
    namePrefix: 'Fillet',
    needsBody: true,
    fields: [
      { key: 'edges', label: 'Edges to fillet', kind: 'edges' },
      { ...dim('radius', 'Radius'), when: (v) => !v.variable },
      { ...TANGENT, when: (v) => !v.variable },
      {
        key: 'variable', label: 'Variable radius', kind: 'group', checkable: true,
        fields: [
          dim('r0', 'At start'),
          { key: 'midOn', label: 'Halfway', kind: 'check', hint: 'Round a closed chain, such as a whole rim, the end is back at the start: give them the same radius and set one halfway.' },
          { ...dim('rMid', 'Halfway'), when: (v) => !!v.midOn },
          dim('r1', 'At end'),
        ],
      },
    ],
    defaults: () => ({ edges: [], radius: '3', variable: false, r0: '2', midOn: false, rMid: '4', r1: '5', propagate: true }),
    missing: (v) => (v.edges.length ? null : 'Click edges in the view'),
    make(v) {
      if (!v.edges.length) return null;
      if (!v.variable) return { type: 'fillet', edges: edgeField(v.edges), radius: num(v.radius), ...propagation(v) };
      const mid = v.midOn ? [{ at: 0.5, radius: num(v.rMid) }] : [];
      return { type: 'fillet_radii', sets: [{ edges: edgeField(v.edges), along: [{ at: 0, radius: num(v.r0) }, ...mid, { at: 1, radius: num(v.r1) }] }] };
    },
    read(f) {
      if (f.type !== 'fillet_radii') return { edges: edgeList(f.edges), radius: str(f.radius), variable: false, r0: '2', midOn: false, rMid: '4', r1: '5', propagate: f.propagate !== false };
      const set = f.sets[0];
      const along = set.along ?? [{ radius: set.radius }, { radius: set.radius }];
      const mid = along.length > 2 ? along[Math.floor(along.length / 2)] : null;
      return { edges: edgeList(set.edges), radius: str(along[0].radius), variable: !!set.along, r0: str(along[0].radius), midOn: !!mid, rMid: str(mid?.radius ?? 4), r1: str(along[along.length - 1].radius), propagate: true };
    },
  },
  {
    id: 'chamfer',
    title: 'Chamfer',
    icon: 'chamfer',
    namePrefix: 'Chamfer',
    needsBody: true,
    fields: [
      { key: 'edges', label: 'Edges to chamfer', kind: 'edges' },
      dim('distance', 'Distance'),
      TANGENT,
    ],
    defaults: () => ({ edges: [], distance: '2', propagate: true }),
    missing: (v) => (v.edges.length ? null : 'Click edges in the view'),
    make: (v) => (v.edges.length ? { type: 'chamfer', edges: edgeField(v.edges), distance: num(v.distance), ...propagation(v) } : null),
    read: (f) => ({ edges: edgeList(f.edges), distance: str(f.distance), propagate: f.propagate !== false }),
  },
  {
    id: 'shell',
    title: 'Shell',
    icon: 'shell',
    namePrefix: 'Shell',
    needsBody: true,
    fields: [
      { key: 'open', label: 'Faces to open', kind: 'faces' },
      dim('thickness', 'Wall'),
    ],
    defaults: () => ({ open: [], thickness: '2' }),
    make: (v) => ({ type: 'shell', open: v.open, thickness: num(v.thickness) }),
    read: (f) => ({ open: f.open ?? [], thickness: str(f.thickness) }),
  },
  {
    id: 'loft',
    title: 'Loft',
    icon: 'loft',
    namePrefix: 'Loft',
    fields: [
      CREATION,
      MODE,
      { key: 'sections', label: 'Profiles', kind: 'sections', hint: 'In the order the loft passes through them: regions in the view, or sketches in the list.' },
      { key: 'closed', label: 'Closed loft', kind: 'check', hint: 'Goes on from the last profile back round to the first, as a ring, with no ends. Three profiles or more.' },
      { key: 'startPoint', label: 'Start at a point', kind: 'check', when: (v) => !v.closed },
      { key: 'from', label: 'Start point', kind: 'point', when: (v) => !v.closed && v.startPoint, hint: 'Before the first profile, as a cone starts at its tip: a sketch point, a part’s corner or the origin.' },
      { key: 'endPoint', label: 'End at a point', kind: 'check', when: (v) => !v.closed },
      { key: 'to', label: 'End point', kind: 'point', when: (v) => !v.closed && v.endPoint, hint: 'After the last profile.' },
      { key: 'guides', label: 'Guides', kind: 'sketches', when: (v) => !v.closed, hint: 'Sketches of open curves, each running through every profile and any point. The sides follow them.' },
      { key: 'start', label: 'Start', kind: 'segment', options: loftEnds('startPoint'), when: (v) => !v.closed },
      { key: 'startPull', label: 'Start pull', kind: 'expr', scrub: 0.1, when: (v) => !v.closed && v.start !== 'free', hint: 'How hard the end pulls: at 1, as fast as going straight from end to end.' },
      { key: 'end', label: 'End', kind: 'segment', options: loftEnds('endPoint'), when: (v) => !v.closed },
      { key: 'endPull', label: 'End pull', kind: 'expr', scrub: 0.1, when: (v) => !v.closed && v.end !== 'free' },
      THIN,
    ],
    defaults: () => ({ sections: [], mode: 'add', body: 'solid', closed: false, startPoint: false, from: null, endPoint: false, to: null, guides: [], start: 'free', startPull: '1', end: 'free', endPull: '1', ...THIN_DEFAULTS }),
    missing(v) {
      const ends = v.closed ? 0 : (v.startPoint ? 1 : 0) + (v.endPoint ? 1 : 0);
      if (!v.closed && v.startPoint && !has(v.from)) return 'Click the point to start at';
      if (!v.closed && v.endPoint && !has(v.to)) return 'Click the point to end at';
      if (v.closed && v.sections.length < 3) return 'A closed loft goes through three profiles or more';
      if (!v.sections.length || v.sections.length + ends < 2) return ends ? 'Click a profile' : 'Click two profiles or more';
      if (!v.closed && v.start === 'normal' && v.startPoint) return 'A point has no plane to be square to: round over it, or leave it free';
      if (!v.closed && v.end === 'normal' && v.endPoint) return 'A point has no plane to be square to: round over it, or leave it free';
      if (!v.closed && v.start === 'round' && !v.startPoint) return 'Round goes over a point: start at a point, or pick another start';
      if (!v.closed && v.end === 'round' && !v.endPoint) return 'Round goes over a point: end at a point, or pick another end';
      return null;
    },
    make(v) {
      if (this.missing!(v)) return null;
      const out: any = { type: 'loft', sections: (v.sections as Section[]).map(sectionJson), mode: modeOf(v), ...thinJson(v) };
      if (v.closed) return { ...out, closed: true };
      if (v.startPoint) out.from = v.from;
      if (v.endPoint) out.to = v.to;
      if (v.guides?.length) out.guides = v.guides;
      // A pull of 1 is the kernel's own, so it's left out.
      const end = (kind: string, pull: string) => { const n = num(pull); return n === 1 ? kind : { [kind]: n }; };
      if (v.start !== 'free') out.start = end(v.start, v.startPull);
      if (v.end !== 'free') out.end = end(v.end, v.endPull);
      return out;
    },
    read(f) {
      const end = (e: any): [string, string] => (!e || e === 'free' ? ['free', '1'] : typeof e === 'string' ? [e, '1'] : [Object.keys(e)[0], str(Object.values(e)[0])]);
      const [start, startPull] = end(f.start), [stop, endPull] = end(f.end);
      return {
        sections: (f.sections ?? []).map(readSection), ...readMode(f), ...readThin(f),
        closed: !!f.closed, startPoint: f.from !== undefined, from: f.from ?? null, endPoint: f.to !== undefined, to: f.to ?? null,
        guides: f.guides ?? [], start, startPull, end: stop, endPull,
      };
    },
  },
  {
    id: 'draft',
    title: 'Draft',
    icon: 'draft',
    namePrefix: 'Draft',
    needsBody: true,
    fields: [
      planeField('neutral', 'Neutral plane', { hint: 'The faces stay put where they cross it, and its normal is the pull.' }),
      { key: 'faces', label: 'Faces to draft', kind: 'faces' },
      { key: 'degrees', label: 'Angle', kind: 'expr', unit: '°', scrub: 0.5, hint: 'A positive angle narrows the part along the pull, a negative one widens it.' },
    ],
    defaults: () => ({ faces: [], degrees: '3', neutral: 'top' }),
    missing: (v) => (!has(v.neutral) ? 'Click the neutral plane' : v.faces.length ? null : 'Click faces in the view'),
    make(v) {
      if (this.missing!(v)) return null;
      return { type: 'draft', faces: v.faces, degrees: num(v.degrees), neutral: v.neutral };
    },
    // Before it took a plane, a draft had a point on the neutral plane and a pull, which is that plane's normal.
    read: (f) => ({ faces: f.faces ?? [], degrees: str(f.degrees), neutral: has(f.neutral) && !isVector(f.neutral) ? f.neutral : planeFromNumbers(f.pull ?? [0, 0, 1], f.neutral, true) }),
  },
  {
    id: 'offset',
    title: 'Offset',
    icon: 'offset',
    namePrefix: 'Offset',
    fields: [{ key: 'distance', label: 'Distance', kind: 'expr', unit: 'mm', scrub: 0.1, hint: 'Every face moves out, or in if negative.' }],
    defaults: () => ({ distance: '1' }),
    make: (v) => ({ type: 'offset', distance: num(v.distance) }),
    read: (f) => ({ distance: str(f.distance) }),
  },
  {
    id: 'thicken',
    title: 'Thicken',
    icon: 'thicken',
    namePrefix: 'Thicken',
    needsBody: true,
    fields: [MODE, { key: 'faces', label: 'Faces to thicken', kind: 'faces' }, dim('thickness', 'Thickness')],
    defaults: () => ({ faces: [], thickness: '2', mode: 'add' }),
    missing: (v) => (v.faces.length ? null : 'Click faces in the view'),
    make: (v) => (v.faces.length ? { type: 'thicken', faces: v.faces, thickness: num(v.thickness), mode: v.mode } : null),
    read: (f) => ({ faces: f.faces ?? [], thickness: str(f.thickness), mode: f.mode ?? 'add' }),
  },
  {
    id: 'delete-face',
    title: 'Delete face',
    icon: 'delete-face',
    namePrefix: 'Delete face',
    needsBody: true,
    fields: [{ key: 'faces', label: 'Faces to delete', kind: 'faces', hint: 'The faces around them grow to close the gap.' }],
    defaults: () => ({ faces: [] }),
    missing: (v) => (v.faces.length ? null : 'Click faces in the view'),
    make: (v) => (v.faces.length ? { type: 'delete_face', faces: v.faces } : null),
    read: (f) => ({ faces: f.faces ?? [] }),
  },
  {
    id: 'mirror',
    title: 'Mirror',
    icon: 'mirror',
    namePrefix: 'Mirror',
    fields: [...copyOf('Mirror', 'mirror'), planeField('plane', 'Mirror plane')],
    defaults: () => ({ ...COPY_DEFAULTS, plane: 'right' }),
    missing: (v) => copyMissing('mirror')(v) ?? (has(v.plane) ? null : 'Click the plane or flat face to mirror across'),
    make(v) {
      if (this.missing!(v)) return null;
      return { type: 'mirror', ...copyJson(v), plane: v.plane };
    },
    // Which way a mirror plane faces makes no difference to the mirror.
    read: (f) => ({ ...readCopy(f), plane: readPlane(f, false) }),
  },
  {
    id: 'pattern-linear',
    title: 'Linear pattern',
    icon: 'pattern-linear',
    namePrefix: 'Pattern',
    fields: [
      ...copyOf('Pattern', 'pattern'),
      { key: 'direction', label: 'Direction', kind: 'segment', options: DIRECTION_OPTIONS },
      { key: 'directionLine', label: 'Direction line', kind: 'line', when: (v) => v.direction === 'line', hint: 'An edge, a sketch line or the axis of something round. The copies follow it.' },
      { key: 'count', label: 'Count', kind: 'expr', scrub: 1 },
      dim('spacing', 'Spacing'),
    ],
    defaults: () => ({ ...COPY_DEFAULTS, direction: 'x', directionLine: null, count: '3', spacing: '40' }),
    missing: (v) => copyMissing('pattern')(v) ?? (v.direction === 'line' && !has(v.directionLine) ? 'Click a line for the direction' : null),
    make(v) {
      if (this.missing!(v)) return null;
      return { type: 'pattern', ...copyJson(v), direction: lineOr(v, 'direction', 'directionLine'), count: num(v.count), spacing: num(v.spacing) };
    },
    read: (f) => ({ ...readCopy(f), ...(isVector(f.direction) ? { direction: axisName(f.direction), directionLine: null } : { direction: 'line', directionLine: f.direction }), count: str(f.count), spacing: str(f.spacing) }),
  },
  {
    id: 'pattern-circular',
    title: 'Circular pattern',
    icon: 'pattern-circular',
    namePrefix: 'Pattern',
    fields: [
      ...copyOf('Pattern', 'pattern'),
      { key: 'axis', label: 'Around', kind: 'segment', options: DIRECTION_OPTIONS },
      { key: 'axisLine', label: 'Axis', kind: 'line', when: (v) => v.axis === 'line', hint: 'Something round for its axis, an edge or a sketch line. The copies go round it.' },
      { key: 'count', label: 'Count', kind: 'expr', scrub: 1 },
      { key: 'degrees', label: 'Angle', kind: 'expr', unit: '°', scrub: 5 },
    ],
    defaults: () => ({ ...COPY_DEFAULTS, axis: 'z', axisLine: null, count: '4', degrees: '360' }),
    missing: (v) => copyMissing('pattern')(v) ?? (v.axis === 'line' && !has(v.axisLine) ? 'Click something round, or a line, to go around' : null),
    make(v) {
      if (this.missing!(v)) return null;
      // A line gives the center too, so there's none with one.
      const around = v.axis === 'line' ? { axis: v.axisLine } : { axis: AXES[v.axis as AxisName], ...(v.center ? { center: v.center } : {}) };
      return { type: 'pattern', ...copyJson(v), ...around, count: num(v.count), degrees: num(v.degrees) };
    },
    read: (f) => ({ ...readCopy(f), ...(isVector(f.axis) || !has(f.axis) ? { axis: axisName(f.axis), axisLine: null } : { axis: 'line', axisLine: f.axis }), count: str(f.count), degrees: str(f.degrees ?? 360), center: f.center ?? null }),
  },
  {
    id: 'transform',
    title: 'Transform',
    icon: 'transform',
    namePrefix: 'Transform',
    needsBody: true,
    fields: [
      { key: 'bodies', label: 'Parts to transform', kind: 'parts' },
      {
        key: 'motion',
        label: 'Type',
        kind: 'select',
        options: [
          { value: 'translate', label: 'Translate by XYZ' },
          { value: 'rotate', label: 'Rotate' },
          { value: 'scale', label: 'Scale uniformly' },
          { value: 'stretch', label: 'Scale along a direction' },
          { value: 'frames', label: 'From one place to another', disabled: () => true },
        ],
      },
      { ...dim('dx', 'X'), when: (v) => v.motion === 'translate' },
      { ...dim('dy', 'Y'), when: (v) => v.motion === 'translate' },
      { ...dim('dz', 'Z'), when: (v) => v.motion === 'translate' },
      { key: 'axis', label: 'Axis', kind: 'segment', options: DIRECTION_OPTIONS, when: (v) => v.motion === 'rotate' || v.motion === 'stretch' },
      { key: 'axisLine', label: 'Axis line', kind: 'line', when: (v) => (v.motion === 'rotate' || v.motion === 'stretch') && v.axis === 'line', hint: 'An edge, a sketch line or something round.' },
      { ...angle('degrees', 'Angle'), when: (v) => v.motion === 'rotate' },
      { key: 'factor', label: 'Scale', kind: 'expr', scrub: 0.1, when: (v) => v.motion === 'scale' || v.motion === 'stretch', hint: 'How many times as big: 25.4 takes a part drawn in inches to millimetres.' },
      { key: 'center', label: 'About point', kind: 'point', when: (v) => v.motion === 'scale', hint: 'What stays put. Nothing picked means the origin.' },
      { key: 'moved', label: 'Axis position', kind: 'group', when: (v) => v.motion === 'rotate' && v.axis !== 'line', fields: [dim('px', 'X'), dim('py', 'Y'), dim('pz', 'Z')] },
      // The kernel takes a stretch's point as numbers only.
      { key: 'stays', label: 'Point that stays', kind: 'group', when: (v) => v.motion === 'stretch' && v.axis !== 'line', fields: [dim('px', 'X'), dim('py', 'Y'), dim('pz', 'Z')] },
      { key: 'copy', label: 'Copy part', kind: 'check' },
    ],
    defaults: () => ({ bodies: [], motion: 'translate', dx: '0', dy: '0', dz: '20', axis: 'z', axisLine: null, degrees: '90', factor: '2', center: null, px: '0', py: '0', pz: '0', copy: false }),
    missing: (v) => (!v.bodies.length ? 'Click parts in the view' : (v.motion === 'rotate' || v.motion === 'stretch') && v.axis === 'line' && !has(v.axisLine) ? 'Click a line for the axis' : null),
    make(v) {
      if (this.missing!(v)) return null;
      const byLine = v.axis === 'line';
      const about = has(v.center) ? { point: v.center } : {};
      let motion: any;
      if (v.motion === 'frames') motion = v.frames;
      else if (v.motion === 'rotate') motion = byLine ? { type: 'rotate', axis: v.axisLine, degrees: num(v.degrees) } : { type: 'rotate', point: point(v, ['px', 'py', 'pz']), axis: AXES[v.axis as AxisName], degrees: num(v.degrees) };
      else if (v.motion === 'scale') motion = { type: 'scale', factor: num(v.factor), ...about };
      else if (v.motion === 'stretch') motion = byLine ? { type: 'stretch', axis: v.axisLine, factor: num(v.factor) } : { type: 'stretch', axis: AXES[v.axis as AxisName], factor: num(v.factor), point: point(v, ['px', 'py', 'pz']) };
      else motion = { type: 'translate', by: point(v, ['dx', 'dy', 'dz']) };
      return { type: 'transform', bodies: v.bodies, motion, copy: !!v.copy };
    },
    read(f) {
      const m = f.motion ?? {};
      const v: Values = { bodies: f.bodies ?? [], motion: m.type ?? 'translate', copy: !!f.copy, dx: '0', dy: '0', dz: '0', axis: 'z', axisLine: null, degrees: '90', factor: '2', center: null, px: '0', py: '0', pz: '0' };
      const axis = (a: any) => (isVector(a) ? { axis: axisName(a), axisLine: null } : { axis: 'line', axisLine: a });
      if (m.type === 'translate') Object.assign(v, { dx: str(m.by[0]), dy: str(m.by[1]), dz: str(m.by[2]) });
      if (m.type === 'rotate') Object.assign(v, axis(m.axis), { degrees: str(m.degrees), px: str(m.point?.[0] ?? 0), py: str(m.point?.[1] ?? 0), pz: str(m.point?.[2] ?? 0) });
      if (m.type === 'scale') Object.assign(v, { factor: str(m.factor), center: m.point ?? null });
      if (m.type === 'stretch') Object.assign(v, axis(m.axis), { factor: str(m.factor), px: str(m.point?.[0] ?? 0), py: str(m.point?.[1] ?? 0), pz: str(m.point?.[2] ?? 0) });
      if (m.type === 'frames') v.frames = m;
      return v;
    },
  },
  {
    id: 'boolean',
    title: 'Boolean',
    icon: 'boolean',
    namePrefix: 'Boolean',
    needsBody: true,
    fields: [
      { key: 'operation', label: 'Operation', kind: 'tabs', options: [{ value: 'union', label: 'Union' }, { value: 'subtract', label: 'Subtract' }, { value: 'intersect', label: 'Intersect' }] },
      { key: 'tools', label: 'Tools', kind: 'parts' },
      { key: 'targets', label: 'Targets', kind: 'parts', when: (v) => v.operation === 'subtract' },
      { key: 'keep', label: 'Keep tools', kind: 'check' },
    ],
    defaults: () => ({ operation: 'union', tools: [], targets: [], keep: false }),
    missing(v) {
      if (v.operation !== 'subtract') return v.tools.length >= 2 ? null : 'Click two parts or more';
      return !v.tools.length ? 'Click the parts to cut with' : !v.targets.length ? 'Click the parts to cut' : null;
    },
    make(v) {
      if (this.missing!(v)) return null;
      const keep = !!v.keep;
      if (v.operation === 'subtract') return { type: 'boolean', operation: 'subtract', bodies: v.targets, tools: v.tools, keep_tools: keep };
      return { type: 'boolean', operation: v.operation, bodies: v.tools.slice(0, 1), tools: v.tools.slice(1), keep_tools: keep };
    },
    read(f) {
      const subtract = f.operation === 'subtract';
      return { operation: f.operation, tools: subtract ? f.tools ?? [] : [...(f.bodies ?? []), ...(f.tools ?? [])], targets: subtract ? f.bodies ?? [] : [], keep: !!f.keep_tools };
    },
  },
  {
    id: 'delete-bodies',
    title: 'Delete part',
    icon: 'delete-part',
    namePrefix: 'Delete part',
    needsBody: true,
    fields: [{ key: 'bodies', label: 'Parts to delete', kind: 'parts' }],
    defaults: () => ({ bodies: [] }),
    missing: (v) => (v.bodies.length ? null : 'Click parts in the view'),
    make: (v) => (v.bodies.length ? { type: 'delete_bodies', bodies: v.bodies } : null),
    read: (f) => ({ bodies: f.bodies ?? [] }),
  },
  {
    id: 'fill',
    title: 'Fill',
    icon: 'fill',
    namePrefix: 'Fill',
    fields: [{ key: 'sketch', label: 'Sketch', kind: 'sketch', hint: 'A flat surface in each closed area of the sketch.' }],
    defaults: () => ({ sketch: lastSketchId() }),
    missing: (v) => (v.sketch === null || v.sketch === undefined ? 'Choose a sketch' : null),
    make: (v) => (v.sketch === null || v.sketch === undefined ? null : { type: 'fill', sketch: Number(v.sketch) }),
    read: (f) => ({ sketch: f.sketch }),
  },
  {
    id: 'copy-faces',
    title: 'Copy faces',
    icon: 'copy-faces',
    namePrefix: 'Copy faces',
    needsBody: true,
    fields: [{ key: 'faces', label: 'Faces to copy', kind: 'faces', hint: 'They become a surface of their own. The part stays as it is.' }],
    defaults: () => ({ faces: [] }),
    missing: (v) => (v.faces.length ? null : 'Click faces in the view'),
    make: (v) => (v.faces.length ? { type: 'copy_faces', faces: v.faces } : null),
    read: (f) => ({ faces: f.faces ?? [] }),
  },
  {
    id: 'sew',
    title: 'Sew',
    icon: 'sew',
    namePrefix: 'Sew',
    needsBody: true,
    fields: [
      { key: 'bodies', label: 'Surfaces to sew', kind: 'parts', hint: 'None picked means every surface. If nothing is left open, they become a solid.' },
      { key: 'tolOn', label: 'Tolerance', kind: 'group', checkable: true, fields: [{ ...dim('tolerance', 'Gap'), scrub: 0.001 }] },
    ],
    defaults: () => ({ bodies: [], tolOn: false, tolerance: '0.01' }),
    make: (v) => ({ type: 'sew', ...(v.bodies.length ? { bodies: v.bodies } : {}), ...(v.tolOn ? { tolerance: num(v.tolerance) } : {}) }),
    read: (f) => ({ bodies: f.bodies ?? [], tolOn: f.tolerance !== undefined, tolerance: str(f.tolerance ?? '0.01') }),
  },
  {
    id: 'trim',
    title: 'Trim surface',
    icon: 'trim-surface',
    namePrefix: 'Trim',
    needsBody: true,
    fields: [
      { key: 'bodies', label: 'Surfaces to trim', kind: 'parts', hint: 'None picked means every surface.' },
      { key: 'by', label: 'Trim with', kind: 'select', options: [{ value: 'part', label: 'A part' }, { value: 'plane', label: 'A plane' }, { value: 'sketch', label: 'A sketch' }] },
      { key: 'tool', label: 'Part', kind: 'part', when: (v) => v.by === 'part' },
      planeField('plane', 'Plane', { when: (v) => v.by === 'plane' }),
      { key: 'sketch', label: 'Sketch', kind: 'sketch', when: (v) => v.by === 'sketch', hint: 'Cuts straight through along the sketch’s normal.' },
      { key: 'keep', label: 'Keep', kind: 'segment', options: [{ value: 'outside', label: 'Outside' }, { value: 'inside', label: 'Inside' }, { value: 'both', label: 'Both' }] },
    ],
    defaults: () => ({ bodies: [], by: 'plane', tool: null, plane: 'top', sketch: lastSketchId(), keep: 'outside' }),
    missing: (v) => (v.by === 'part' && !v.tool ? 'Click the part to trim with' : v.by === 'sketch' && (v.sketch === null || v.sketch === undefined) ? 'Choose a sketch' : v.by === 'plane' && !has(v.plane) ? 'Click a plane or a flat face' : null),
    make(v) {
      if (this.missing!(v)) return null;
      const out: any = { type: 'trim', keep: v.keep, ...(v.bodies.length ? { bodies: v.bodies } : {}) };
      if (v.by === 'part') out.tool = v.tool;
      else if (v.by === 'sketch') out.sketch = Number(v.sketch);
      else out.plane = v.plane;
      return out;
    },
    read(f) {
      const by = f.tool ? 'part' : f.sketch !== undefined ? 'sketch' : 'plane';
      // Which side is outside depends on which way the plane faces, so only a plane facing the same way will do.
      return { bodies: f.bodies ?? [], by, tool: f.tool ?? null, plane: by === 'plane' ? readPlane(f, true) : 'top', sketch: f.sketch ?? lastSketchId(), keep: f.keep ?? 'outside' };
    },
  },
  HOLE_DEF,
  RIB_DEF,
  SPLIT_DEF,
  SHEET_METAL_DEF,
  FLANGE_DEF,
  HEM_DEF,
  TAB_DEF,
  BEND_DEF,
] as FeatureDef[]).map((d) => (d.fields.includes(MODE) ? withScope(d) : d));

export const defById = (id: string) => DEFS.find((d) => d.id === id);

/** The dialog for a feature in the history, if it has one. */
export function defForFeature(f: any): FeatureDef | undefined {
  if (f.type === 'solid') return defById(f.shape);
  if (f.type === 'pattern') return defById(f.direction ? 'pattern-linear' : 'pattern-circular');
  if (f.type === 'delete_face') return defById('delete-face');
  if (f.type === 'delete_bodies') return defById('delete-bodies');
  if (f.type === 'copy_faces') return defById('copy-faces');
  if (f.type === 'sheet_metal') return defById('sheet-metal');
  if (f.type === 'extrude' && f.app?.tab) return defById('tab');
  // Only what the Fillet dialog writes: one set of edges, at one radius or going from one to another, maybe by one halfway.
  const along = f.sets?.[0]?.along;
  const ours = !along || along.length === 2 || (along.length === 3 && along[1].at === 0.5);
  if (f.type === 'fillet_radii') return f.sets?.length === 1 && ours ? defById('fillet') : undefined;
  if (f.type === 'transform' && f.motion?.type === 'frames') return undefined;
  if (f.type === 'revolve' && readAxis(f).axis === 'custom') return defById('revolve');
  return defById(f.type);
}
