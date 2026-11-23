// What ties an offset's or a pattern's copies to their originals, beyond what the sketch file itself can say.
//
// The kernel's sketch has no offset or pattern constraint, so the app makes them from the ones it has: a distance for
// each offset curve, and for each copy in a pattern, its points held at so far from the original's. Those all take one
// value, or a multiple of it, so only one of them shows, the lead, and typing a new value into it sets the rest. A
// circular pattern also needs construction lines to measure its angles from. Those helpers, and the constraints that
// only serve them, stay out of sight. All of this is kept with the document, by sketch feature, in its app data.
import type { Con, SketchData } from './geometry';

/**
 * One shown value and the hidden ones that follow it, each that many times it. `hold` is the originals, which stay put
 * while a new value goes in, so the copies move to it rather than the originals moving to meet them.
 */
export interface Tie { lead: number; follow: [number, number][]; hold?: number[] }
export interface SketchLinks {
  /** Helper entities, out of sight, with the entities they serve: when any of those goes, so does the helper. */
  helpers: Record<string, number[]>;
  /** Constraints out of sight. */
  hiddenCons: number[];
  ties: Tie[];
}

export const noLinks = (): SketchLinks => ({ helpers: {}, hiddenCons: [], ties: [] });
export const emptyLinks = (l: SketchLinks) => !Object.keys(l.helpers).length && !l.hiddenCons.length && !l.ties.length;

/** Reads what a document kept, taking only what has the right shape. */
export function readLinks(v: unknown): SketchLinks {
  const l = noLinks();
  if (!v || typeof v !== 'object') return l;
  const o = v as Record<string, unknown>;
  if (o.helpers && typeof o.helpers === 'object') {
    for (const [k, owners] of Object.entries(o.helpers as Record<string, unknown>)) {
      if (/^\d+$/.test(k) && Array.isArray(owners)) l.helpers[k] = owners.filter((x): x is number => typeof x === 'number');
    }
  }
  if (Array.isArray(o.hiddenCons)) l.hiddenCons = o.hiddenCons.filter((x): x is number => typeof x === 'number');
  if (Array.isArray(o.ties)) {
    for (const t of o.ties as any[]) {
      if (t && typeof t.lead === 'number' && Array.isArray(t.follow)) {
        const hold = Array.isArray(t.hold) ? t.hold.filter((x: unknown): x is number => typeof x === 'number') : undefined;
        l.ties.push({ lead: t.lead, follow: t.follow.filter((f: unknown) => Array.isArray(f) && typeof f[0] === 'number' && typeof f[1] === 'number'), ...(hold ? { hold } : {}) });
      }
    }
  }
  return l;
}

/** A value `times` over: a number multiplied out, an expression wrapped. */
export function scaled(v: number | string, times: number): number | string {
  if (times === 1) return v;
  if (typeof v === 'number') return v * times;
  const n = Number(v);
  if (v.trim() !== '' && Number.isFinite(n)) return n * times;
  return `${times} * (${v})`;
}

const REF_KEYS = ['a', 'b', 'of', 'about', 'point', 'line', 'what'] as const;
const entityOf = (r: unknown) => (typeof r === 'string' && /^\d+(\.\w+)?$/.test(r) ? Number(r.split('.')[0]) : null);

/** Sets each follower from its lead, as they stand in the sketch. */
export function applyTies(d: SketchData, l: SketchLinks) {
  const byId = new Map(d.constraints.map((c) => [c.id, c]));
  for (const t of l.ties) {
    const lead = byId.get(t.lead);
    if (lead?.value === undefined) continue;
    for (const [id, times] of t.follow) {
      const c = byId.get(id);
      if (c) c.value = scaled(lead.value, times);
    }
  }
}

/**
 * Keeps the links true to the sketch after a change: a helper goes once what it serves has gone, with the constraints on
 * it; a constraint naming something gone goes too; and a tie whose lead was deleted hands the lead to a follower, which
 * then shows.
 */
export function tidyLinks(d: SketchData, l: SketchLinks) {
  let ids = new Set(d.entities.map((e) => e.id));
  const gone = new Set<number>();
  for (const [k, owners] of Object.entries(l.helpers)) {
    if (!ids.has(Number(k)) || owners.some((o) => !ids.has(o))) {
      gone.add(Number(k));
      delete l.helpers[k];
    }
  }
  if (gone.size) {
    d.entities = d.entities.filter((e) => !gone.has(e.id));
    ids = new Set(d.entities.map((e) => e.id));
  }
  d.constraints = d.constraints.filter((c) => REF_KEYS.every((k) => {
    const id = entityOf(c[k]);
    return id === null || ids.has(id);
  }));
  const cons = new Set(d.constraints.map((c) => c.id));
  l.hiddenCons = l.hiddenCons.filter((id) => cons.has(id));
  const ties: Tie[] = [];
  for (const t of l.ties) {
    const follow = t.follow.filter(([id]) => cons.has(id));
    const hold = t.hold?.filter((id) => ids.has(id));
    const keep = hold ? { hold } : {};
    if (cons.has(t.lead)) {
      ties.push({ lead: t.lead, follow, ...keep });
      continue;
    }
    // The lead's gone: the first follower takes over, and shows.
    const next = follow.find(([, k]) => k !== 0);
    if (!next) continue;
    const [lead, k] = next;
    l.hiddenCons = l.hiddenCons.filter((id) => id !== lead);
    const rest = follow.filter(([id]) => id !== lead).map(([id, times]) => [id, times / k] as [number, number]);
    ties.push({ lead, follow: rest, ...keep });
  }
  l.ties = ties;
}

/** Whether a constraint is out of sight. Everything that only serves a helper is hidden when it's made. */
export function conHidden(l: SketchLinks, c: Con) {
  return l.hiddenCons.includes(c.id);
}
