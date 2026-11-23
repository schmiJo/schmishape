// Onshape's sketch offset: a copy of a chain of lines and arcs, or of a circle, a set distance to one side. Each copy runs
// alongside its original, its corners meet where the copies cross, and where the original turns smoothly the copy does too.
import type { Con, Ent, V2 } from './geometry';
import type { Tie } from './links';

/** One curve of a chain, and whether the chain runs along it backwards, from its end to its start. */
export interface Link { e: Ent; rev: boolean }
export interface Chain { links: Link[]; closed: boolean }

const TAU = Math.PI * 2;
const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: V2) => Math.hypot(a[0], a[1]);
const unit = (a: V2): V2 => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const left = (u: V2): V2 => [-u[1], u[0]];
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];
const along = (p: V2, u: V2, t: number): V2 => [p[0] + u[0] * t, p[1] + u[1] * t];
const angle = (c: V2, p: V2) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const ccw = (from: number, to: number) => (((to - from) % TAU) + TAU) % TAU;

/** Where a link starts and ends, the way the chain runs. */
export const fromOf = (l: Link): V2 => (l.rev ? l.e.end! : l.e.start!);
export const toOf = (l: Link): V2 => (l.rev ? l.e.start! : l.e.end!);
/** The ends' names, the way the chain runs. */
export const fromRef = (l: Link) => `${l.e.id}.${l.rev ? 'end' : 'start'}`;
export const toRef = (l: Link) => `${l.e.id}.${l.rev ? 'start' : 'end'}`;

/** The direction a link runs at a point on it. */
function heading(l: Link, p: V2): V2 {
  if (l.e.type === 'line') return unit(l.rev ? sub(l.e.start!, l.e.end!) : sub(l.e.end!, l.e.start!));
  const r = unit(sub(p, l.e.center!));
  // An arc runs counter-clockwise, which is to the left of the way out from its center.
  return l.rev ? [r[1], -r[0]] : [-r[1], r[0]];
}

/**
 * The lines and arcs among `ents` put into chains, each running end to end: a closed loop, or an open run. A circle is a
 * chain on its own. Curves that branch, where three meet at a point, end a run there.
 */
export function chainsOf(ents: Ent[], tol: number): Chain[] {
  const curves = ents.filter((e) => e.type === 'line' || e.type === 'arc');
  const same = (a: V2, b: V2) => len(sub(a, b)) < tol;
  const used = new Set<number>();
  const at = (p: V2, not: number) => curves.filter((e) => e.id !== not && !used.has(e.id) && (same(e.start!, p) || same(e.end!, p)));
  const meeting = (p: V2) => curves.filter((e) => same(e.start!, p) || same(e.end!, p)).length;
  const out: Chain[] = ents.filter((e) => e.type === 'circle').map((e) => ({ links: [{ e, rev: false }], closed: true }));
  for (const first of curves) {
    if (used.has(first.id)) continue;
    used.add(first.id);
    const links: Link[] = [{ e: first, rev: false }];
    // Onward from its end, then back from its start.
    for (;;) {
      const p = toOf(links[links.length - 1]);
      const next = meeting(p) === 2 ? at(p, links[links.length - 1].e.id)[0] : undefined;
      if (!next) break;
      used.add(next.id);
      links.push({ e: next, rev: !same(next.start!, p) });
    }
    for (;;) {
      const p = fromOf(links[0]);
      const prev = meeting(p) === 2 ? at(p, links[0].e.id)[0] : undefined;
      if (!prev) break;
      used.add(prev.id);
      links.unshift({ e: prev, rev: same(prev.start!, p) });
    }
    const closed = links.length > 1 && same(toOf(links[links.length - 1]), fromOf(links[0]));
    out.push({ links, closed });
  }
  return out;
}

/** The nearest point on a link to `p`, and which side of it `p` is: positive on the left, the way the chain runs. */
function sideOf(l: Link, p: V2): { d: number; signed: number } {
  const e = l.e;
  if (e.type === 'line') {
    const a = e.start!, b = e.end!;
    const u = sub(b, a);
    const t = Math.max(0, Math.min(1, dot(sub(p, a), u) / (dot(u, u) || 1)));
    const q = along(a, u, t);
    const d = len(sub(p, q));
    const s = Math.sign(cross(u, sub(p, a))) * (l.rev ? -1 : 1);
    return { d, signed: d * (s || 1) };
  }
  const c = e.center!, r = e.radius!;
  let d = Math.abs(len(sub(p, c)) - r);
  if (e.type === 'arc') {
    const a0 = angle(c, e.start!), a1 = angle(c, e.end!);
    if (ccw(a0, angle(c, p)) > ccw(a0, a1)) d = Math.min(len(sub(p, e.start!)), len(sub(p, e.end!)));
  }
  // Inside is to the left of an arc running counter-clockwise.
  const inside = len(sub(p, c)) < r;
  return { d, signed: d * ((inside ? 1 : -1) * (l.rev ? -1 : 1)) };
}

/** How far from the chains a point is, and to which side, from the curve it's nearest. */
export function offsetAt(chains: Chain[], p: V2): number {
  let best = { d: Infinity, signed: 0 };
  for (const c of chains) for (const l of c.links) {
    const s = sideOf(l, p);
    if (s.d < best.d) best = s;
  }
  return best.signed;
}

/** A link's copy as a whole line or circle, `d` to its left. */
type Carrier = { kind: 'line'; p: V2; u: V2 } | { kind: 'circle'; c: V2; r: number };
function carrier(l: Link, d: number): Carrier | null {
  const e = l.e;
  if (e.type === 'line') {
    const u = unit(l.rev ? sub(e.start!, e.end!) : sub(e.end!, e.start!));
    return { kind: 'line', p: along(fromOf(l), left(u), d), u };
  }
  const r = e.type === 'circle' || !l.rev ? e.radius! - d : e.radius! + d;
  return r > 1e-9 ? { kind: 'circle', c: e.center!, r } : null;
}

function meet(a: Carrier, b: Carrier): V2[] {
  if (a.kind === 'line' && b.kind === 'line') {
    const det = cross(a.u, b.u);
    if (Math.abs(det) < 1e-12) return [];
    const t = cross(sub(b.p, a.p), b.u) / det;
    return [along(a.p, a.u, t)];
  }
  if (a.kind === 'circle' && b.kind === 'circle') {
    const d = len(sub(b.c, a.c));
    if (d < 1e-12 || d > a.r + b.r + 1e-9 || d < Math.abs(a.r - b.r) - 1e-9) return [];
    const x = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
    const h = Math.sqrt(Math.max(0, a.r * a.r - x * x));
    const u = unit(sub(b.c, a.c));
    const base = along(a.c, u, x);
    return [along(base, left(u), h), along(base, left(u), -h)];
  }
  const line = (a.kind === 'line' ? a : b) as Extract<Carrier, { kind: 'line' }>;
  const circ = (a.kind === 'circle' ? a : b) as Extract<Carrier, { kind: 'circle' }>;
  const t0 = dot(sub(circ.c, line.p), line.u);
  const foot = along(line.p, line.u, t0);
  const h2 = circ.r * circ.r - len(sub(foot, circ.c)) ** 2;
  if (h2 < -1e-9) return [];
  const h = Math.sqrt(Math.max(0, h2));
  return [along(foot, line.u, h), along(foot, line.u, -h)];
}

/** Where two links meet, and whether the chain turns smoothly there or makes a corner. */
export function smoothAt(a: Link, b: Link): boolean {
  const p = toOf(a);
  const ha = heading(a, p), hb = heading(b, p);
  return Math.abs(cross(ha, hb)) < 1e-6 && dot(ha, hb) > 0;
}

/** One copy: the curve it copies, the new curve with its ends in the original's own order, and how its ends were found. */
export interface OffsetPiece { link: Link; ent: Omit<Ent, 'id'> }

/**
 * The copies of a chain `d` to its left (negative is to the right), or why there can't be. Corners meet where the copies
 * cross, nearest where the corner would have moved to.
 */
export function offsetChain(chain: Chain, d: number): OffsetPiece[] | string {
  const { links, closed } = chain;
  const carriers = links.map((l) => carrier(l, d));
  if (carriers.some((c) => !c)) return 'That offset is bigger than an arc’s radius, so the arc would vanish.';
  const n = links.length;
  if (links[0].e.type === 'circle') {
    const c = carriers[0] as Extract<Carrier, { kind: 'circle' }>;
    return [{ link: links[0], ent: { type: 'circle', center: [...c.c] as V2, radius: c.r } }];
  }
  const pointOn = (i: number, p: V2): V2 => {
    const l = links[i];
    return along(p, left(heading(l, p)), d);
  };
  // Where each copy starts and ends, the way the chain runs.
  const starts: V2[] = links.map((l, i) => pointOn(i, fromOf(l)));
  const ends: V2[] = links.map((l, i) => pointOn(i, toOf(l)));
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const j = (i + 1) % n;
    if (smoothAt(links[i], links[j])) continue;
    const near = ends[i], near2 = starts[j];
    const goal: V2 = [(near[0] + near2[0]) / 2, (near[1] + near2[1]) / 2];
    const hits = meet(carriers[i]!, carriers[j]!);
    if (!hits.length) return 'The copies at a corner don’t meet at that distance.';
    const p = hits.reduce((best, h) => (len(sub(h, goal)) < len(sub(best, goal)) ? h : best));
    ends[i] = p;
    starts[j] = p;
  }
  const out: OffsetPiece[] = [];
  for (let i = 0; i < n; i++) {
    const l = links[i];
    const [s, t] = l.rev ? [ends[i], starts[i]] : [starts[i], ends[i]];
    if (l.e.type === 'line') {
      // A copy that would run backwards has been squeezed out of existence.
      const was = sub(l.e.end!, l.e.start!);
      if (dot(sub(t, s), was) <= 1e-9) return 'That offset is too big for this shape: a side would turn inside out.';
      out.push({ link: l, ent: { type: 'line', start: s, end: t } });
    } else {
      const c = carriers[i] as Extract<Carrier, { kind: 'circle' }>;
      const sweep = ccw(angle(l.e.center!, l.e.start!), angle(l.e.center!, l.e.end!));
      const now = ccw(angle(c.c, s), angle(c.c, t));
      if (Math.abs(now - sweep) > Math.PI) return 'That offset is too big for this shape: an arc would turn inside out.';
      out.push({ link: l, ent: { type: 'arc', center: [...c.c] as V2, radius: c.r, start: s, end: t } });
    }
  }
  return out;
}

/** New ids, as the sketch hands them out. */
export interface Ids { ent(): number; con(): number }
/** What a tool adds to a sketch: curves, constraints, and the links that keep them together out of sight. */
export interface Built { ents: Ent[]; cons: Con[]; helpers: Record<string, number[]>; hidden: number[]; ties: Tie[]; lead: number | null }

/**
 * Offsets chains as constraints, so the copies follow their originals: each copy runs parallel or concentric to its
 * original at the distance, every distance the one shown first. Corners join where they meet. Where the chain turns
 * smoothly, both copies end on a hidden line out from the arc's center, which a plain join can't do without saying the
 * same thing twice.
 */
export function offsetBuild(chains: Chain[], d: number, ids: Ids): Built | string {
  const out: Built = { ents: [], cons: [], helpers: {}, hidden: [], ties: [], lead: null };
  const con = (c: Omit<Con, 'id'>, hide = true) => {
    const made = { ...c, id: ids.con() } as Con;
    out.cons.push(made);
    if (hide) out.hidden.push(made.id);
    return made.id;
  };
  const distances: number[] = [];
  for (const chain of chains) {
    const pieces = offsetChain(chain, d);
    if (typeof pieces === 'string') return pieces;
    const made = pieces.map((p) => {
      const e = { ...p.ent, id: ids.ent() } as Ent;
      // A part's edge comes in as construction, but its offset is what was wanted to draw with.
      if (p.link.e.construction && !p.link.e.projected) e.construction = true;
      out.ents.push(e);
      return e;
    });
    // Ends of each copy the way the chain runs.
    const from = (i: number) => `${made[i].id}.${pieces[i].link.rev ? 'end' : 'start'}`;
    const to = (i: number) => `${made[i].id}.${pieces[i].link.rev ? 'start' : 'end'}`;
    pieces.forEach((p, i) => {
      const o = p.link.e, e = made[i];
      if (o.type === 'line') con({ type: 'parallel', a: `${e.id}`, b: `${o.id}` });
      else con({ type: 'concentric', a: `${e.id}`, b: `${o.id}` });
      distances.push(con({ type: 'distance', a: o.type === 'circle' ? `${o.id}` : `${o.id}.start`, b: `${e.id}`, value: Math.abs(d) }));
    });
    const n = pieces.length;
    for (let i = 0; i < (chain.closed && n > 1 ? n : n - 1); i++) {
      const j = (i + 1) % n;
      const a = chain.links[i], b = chain.links[j];
      if (!smoothAt(a, b)) {
        con({ type: 'coincident', a: to(i), b: from(j) }, false);
        continue;
      }
      const arc = a.e.type === 'arc' ? a.e : b.e.type === 'arc' ? b.e : null;
      const corner = toOf(a);
      const h = ids.ent();
      out.helpers[String(h)] = [made[i].id, made[j].id];
      if (arc) {
        out.ents.push({ id: h, type: 'line', start: [...arc.center!] as V2, end: [...corner] as V2, construction: true });
        con({ type: 'coincident', a: `${h}.start`, b: `${arc.id}.center` });
        con({ type: 'coincident', a: `${h}.end`, b: toRef(a) });
        con({ type: 'coincident', a: to(i), b: `${h}` });
      } else {
        // Two lines running straight on: the line across them at the joint, out to where the copy ends.
        const end = toOf({ e: made[i], rev: a.rev });
        out.ents.push({ id: h, type: 'line', start: [...corner] as V2, end: [...end] as V2, construction: true });
        con({ type: 'coincident', a: `${h}.start`, b: toRef(a) });
        con({ type: 'perpendicular', a: `${h}`, b: `${a.e.id}` });
        con({ type: 'coincident', a: `${h}.end`, b: to(i) });
      }
      con({ type: 'coincident', a: from(j), b: `${h}` });
    }
    // An open run's two ends stay square across from the original's.
    if (!chain.closed && chain.links[0].e.type !== 'circle') {
      for (const [i, end] of [[0, 'from'], [n - 1, 'to']] as const) {
        const l = chain.links[i];
        const ref = end === 'from' ? fromRef(l) : toRef(l);
        const there = end === 'from' ? fromOf(l) : toOf(l);
        const copyRef = end === 'from' ? from(i) : to(i);
        const copyAt = end === 'from' ? fromOf({ e: made[i], rev: l.rev }) : toOf({ e: made[i], rev: l.rev });
        const h = ids.ent();
        out.helpers[String(h)] = [made[i].id];
        if (l.e.type === 'arc') {
          out.ents.push({ id: h, type: 'line', start: [...l.e.center!] as V2, end: [...there] as V2, construction: true });
          con({ type: 'coincident', a: `${h}.start`, b: `${l.e.id}.center` });
          con({ type: 'coincident', a: `${h}.end`, b: ref });
          con({ type: 'coincident', a: copyRef, b: `${h}` });
        } else {
          out.ents.push({ id: h, type: 'line', start: [...there] as V2, end: [...copyAt] as V2, construction: true });
          con({ type: 'coincident', a: `${h}.start`, b: ref });
          con({ type: 'perpendicular', a: `${h}`, b: `${l.e.id}` });
          con({ type: 'coincident', a: `${h}.end`, b: copyRef });
        }
      }
    }
  }
  if (distances.length) {
    out.lead = distances[0];
    out.hidden = out.hidden.filter((id) => id !== out.lead);
    const hold = [...new Set(chains.flatMap((c) => c.links.map((l) => l.e.id)))];
    out.ties.push({ lead: distances[0], follow: distances.slice(1).map((id) => [id, 1]), hold });
  }
  return out;
}
