// Onshape's sketch patterns: copies of some curves in a row, or around a point. Each copy's points are held at so far
// from the original's, across and up for a row and by an angle around for a circle, so the copies follow when the
// originals change, and the spacing is one dimension to type.
import type { Con, Ent, V2 } from './geometry';
import type { Built, Ids } from './offset';

export interface PatternSetup {
  kind: 'linear' | 'circular';
  /** The curves to copy. */
  ids: number[];
  /** How many there are in all, the originals with them. */
  count: number;
  /** A row's step from one to the next. */
  dx: number;
  dy: number;
  /** A circle's whole angle in degrees: 360 spreads them evenly all round. */
  angle: number;
  /** What a circle turns about, and where that is. */
  center: string;
  centerAt: V2;
}

/** The angle from one copy to the next around a circle, in degrees. */
export function stepAngle(s: PatternSetup) {
  if (s.count < 2) return 0;
  return Math.abs(Math.abs(s.angle) - 360) < 1e-9 ? (Math.sign(s.angle) * 360) / s.count : s.angle / (s.count - 1);
}

/** Where copy `k` puts a point. */
export function placer(s: PatternSetup, k: number): (p: V2) => V2 {
  if (s.kind === 'linear') return (p) => [p[0] + s.dx * k, p[1] + s.dy * k];
  const t = (stepAngle(s) * k * Math.PI) / 180, c = Math.cos(t), n = Math.sin(t);
  const [ox, oy] = s.centerAt;
  return (p) => [ox + (p[0] - ox) * c - (p[1] - oy) * n, oy + (p[0] - ox) * n + (p[1] - oy) * c];
}

/** The kinds of curve a pattern can copy. */
export const patternable = (e: Ent) => ['line', 'arc', 'circle', 'point', 'spline'].includes(e.type) && !e.projected;

/** A curve moved to where copy `k` puts it. */
export function placed(e: Ent, at: (p: V2) => V2): Omit<Ent, 'id'> {
  const out: any = JSON.parse(JSON.stringify(e));
  delete out.id;
  for (const k of ['start', 'end', 'center', 'at']) if (Array.isArray(out[k])) out[k] = at(out[k] as V2);
  if (Array.isArray(out.points)) out.points = out.points.map(at);
  if (Array.isArray(out.through)) out.through = out.through.map(at);
  return out;
}

/** The points of a curve that place it, by name. A circle also keeps its size, which an `equal` holds. */
function pinsOf(e: Ent): string[] {
  switch (e.type) {
    case 'line':
      return ['start', 'end'];
    case 'arc':
      // Its center and start set its size and where it starts. Its end then needs only how far round it goes, which
      // pinning it whole would say twice.
      return ['center', 'start', 'end'];
    case 'circle':
      return ['center'];
    case 'point':
      return [''];
    case 'spline': {
      const n = (e.points ?? e.through ?? []).length;
      return Array.from({ length: n }, (_, i) => (i === 0 ? 'start' : i === n - 1 ? 'end' : `p${i}`));
    }
    default:
      return [];
  }
}

const refOf = (id: number, pin: string) => (pin ? `${id}.${pin}` : `${id}`);

function pointOf(e: Ent, pin: string): V2 | null {
  if (!pin) return e.at ?? null;
  if (e.type === 'spline') {
    const pts: V2[] = e.points ?? e.through ?? [];
    if (pin === 'start') return pts[0] ?? null;
    if (pin === 'end') return pts[pts.length - 1] ?? null;
    return pts[Number(pin.slice(1))] ?? null;
  }
  return (e as any)[pin] ?? null;
}

/** The copies of a pattern, for the preview: each curve moved, for each copy after the originals. */
export function patternPreview(ents: Ent[], s: PatternSetup): Omit<Ent, 'id'>[] {
  const out: Omit<Ent, 'id'>[] = [];
  for (let k = 1; k < s.count; k++) {
    const at = placer(s, k);
    for (const e of ents) out.push(placed(e, at));
  }
  return out;
}

/**
 * A pattern as constraints. In a row, each point of each copy is a horizontal and a vertical distance from the
 * original's, that many steps over. Around a circle, each point has a hidden line out to it from the center, as long as
 * the original's and turned that many steps from it. The first copy's step is the one that shows.
 */
export function patternBuild(ents: Ent[], s: PatternSetup, ids: Ids): Built | string {
  const out: Built = { ents: [], cons: [], helpers: {}, hidden: [], ties: [], lead: null };
  if (s.count < 2) return 'A pattern needs at least two, counting the original.';
  const con = (c: Omit<Con, 'id'>, hide = true) => {
    const made = { ...c, id: ids.con() } as Con;
    out.cons.push(made);
    if (hide) out.hidden.push(made.id);
    return made.id;
  };
  const step = stepAngle(s);
  const tol = 1e-9;
  /** Each tie's lead, and its followers, by what they measure. */
  const ties = new Map<string, { lead: number | null; follow: [number, number][] }>();
  const tie = (key: string, id: number, k: number) => {
    const t = ties.get(key) ?? { lead: null, follow: [] };
    if (t.lead === null && k === 1) t.lead = id;
    else t.follow.push([id, k]);
    ties.set(key, t);
  };
  /** The hidden line from the center to each original point, made once. */
  const spokes = new Map<string, number>();
  const spokeTo = (e: Ent, pin: string, p: V2) => {
    const ref = refOf(e.id, pin);
    let id = spokes.get(ref);
    if (id !== undefined) return id;
    id = ids.ent();
    spokes.set(ref, id);
    out.helpers[String(id)] = [e.id];
    out.ents.push({ id, type: 'line', start: [...s.centerAt] as V2, end: [...p] as V2, construction: true });
    con({ type: 'coincident', a: `${id}.start`, b: s.center });
    con({ type: 'coincident', a: `${id}.end`, b: ref });
    return id;
  };
  for (let k = 1; k < s.count; k++) {
    const at = placer(s, k);
    for (const e of ents) {
      const copy = { ...placed(e, at), id: ids.ent() } as Ent;
      if (copy.type === 'spline' && copy.through && !copy.points) {
        // Its points are named as control points, so it goes in as those.
        copy.points = copy.through;
        delete copy.through;
      }
      out.ents.push(copy);
      if (e.type === 'circle') con({ type: 'equal', a: `${e.id}`, b: `${copy.id}` });
      for (const pin of pinsOf(e)) {
        const p = pointOf(e, pin);
        if (!p) continue;
        const a = refOf(e.id, pin), b = refOf(copy.id, pin);
        const arcEnd = e.type === 'arc' && pin === 'end';
        if (s.kind === 'linear') {
          // An arc's end goes across or up, whichever way the arc is heading there.
          const t = arcEnd ? Math.abs(Math.sin(Math.atan2(p[1] - e.center![1], p[0] - e.center![0]))) : 1;
          if (!arcEnd || t >= Math.SQRT1_2) tie('x', con({ type: 'horizontal_distance', a, b, value: s.dx * k }), k);
          if (!arcEnd || t < Math.SQRT1_2) tie('y', con({ type: 'vertical_distance', a, b, value: s.dy * k }), k);
          continue;
        }
        if (Math.hypot(p[0] - s.centerAt[0], p[1] - s.centerAt[1]) < tol) {
          con({ type: 'coincident', a: b, b: s.center });
          continue;
        }
        const from = spokeTo(e, pin, p);
        const h = ids.ent();
        out.helpers[String(h)] = [copy.id];
        out.ents.push({ id: h, type: 'line', start: [...s.centerAt] as V2, end: at(p), construction: true });
        con({ type: 'coincident', a: `${h}.start`, b: s.center });
        con({ type: 'coincident', a: `${h}.end`, b });
        // An arc's end only needs to be on its line out from the center: how far out, its size already says.
        if (!arcEnd) con({ type: 'equal', a: `${from}`, b: `${h}` });
        tie('angle', con({ type: 'angle', a: `${from}`, b: `${h}`, value: step * k }), k);
      }
    }
  }
  for (const [key, t] of ties) {
    if (t.lead === null) continue;
    const shows = key === 'angle' || (key === 'x' ? Math.abs(s.dx) > tol : Math.abs(s.dy) > tol);
    if (shows) out.hidden = out.hidden.filter((id) => id !== t.lead);
    if (shows && out.lead === null) out.lead = t.lead;
    out.ties.push({ lead: t.lead, follow: t.follow, hold: ents.map((e) => e.id) });
  }
  return out;
}
